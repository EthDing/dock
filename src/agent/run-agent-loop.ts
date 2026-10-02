import type { UUID } from 'node:crypto'
import type { AgentSnapshot } from '../agents/types.js'
import { buildPostCompactMessages } from '../context/compaction.js'
import type { ContextManager, PreparedCompaction } from '../context/context-manager.js'
import {
  type AssistantTranscriptMessage,
  createAssistantMessage,
  createUserMessage,
  type TranscriptMessage,
  type UserTranscriptMessage,
} from '../messages/create-message.js'
import { streamAssistantResponse } from '../model/stream-response.js'
import type {
  AssistantMessage,
  JsonObject,
  ModelAdapter,
  ModelStreamEvent,
  ToolResultBlock,
  ToolUseBlock,
} from '../model/types.js'
import type { AgentTool, AgentToolResult, CanUseTool } from '../tools/types.js'
import type { SkillActivationContext } from '../skills/activation.js'
import { buildModelRequest, roughRequestTokens } from './request.js'

export type AgentLoopOptions = {
  getAgentIdentity?: () => Omit<
    AgentSnapshot,
    'messages' | 'systemPrompt' | 'userContext' | 'tools'
  >
  getPendingMessages?: (
    messages: readonly TranscriptMessage[],
  ) => Promise<readonly UserTranscriptMessage[]>
  canUseTool?: CanUseTool
  contextManager?: ContextManager
  model: ModelAdapter
  modelId: string
  systemPrompt: readonly string[]
  messages: readonly TranscriptMessage[]
  tools: readonly AgentTool[]
  signal?: AbortSignal
  maxTurns?: number
  maxOutputTokens?: number
  userContext?: Readonly<Record<string, string>>
}

export type ToolOutcome = 'success' | 'error' | 'denied' | 'aborted'
type ToolExecutionResult = {
  context?: SkillActivationContext
  result: ToolResultBlock
  outcome: ToolOutcome
}

export type AgentEvent =
  | {
      type: 'tool_results_cleared'
      messages: readonly TranscriptMessage[]
      toolUseIds: readonly string[]
    }
  | { type: 'compaction_status'; status: 'started' | 'failed' | 'cancelled'; message?: string }
  | { type: 'compact'; messages: readonly TranscriptMessage[]; compaction?: PreparedCompaction }
  | { type: 'model_stream'; event: ModelStreamEvent }
  | { type: 'assistant_message'; message: AssistantTranscriptMessage }
  | { type: 'user_message'; message: UserTranscriptMessage }
  | { type: 'tool_execution_start'; toolUse: ToolUseBlock }
  | { type: 'tool_result'; result: ToolResultBlock; outcome?: ToolOutcome }

export type AgentLoopResult = {
  reason: 'aborted' | 'completed' | 'max_turns' | 'model_error'
  messages: readonly TranscriptMessage[]
  error?: string
}

export async function* runAgentLoop(
  options: AgentLoopOptions,
): AsyncGenerator<AgentEvent, AgentLoopResult> {
  const controller = new AbortController()
  const externalSignal = options.signal
  const abort = () => controller.abort(externalSignal?.reason)
  externalSignal?.addEventListener('abort', abort, { once: true })
  if (externalSignal?.aborted) abort()

  const messages: TranscriptMessage[] = [...options.messages]
  let toolTurns = 0
  let userContext = options.userContext

  try {
    while (!controller.signal.aborted) {
      for (const message of (await options.getPendingMessages?.(messages)) ?? []) {
        if (messages.some((existing) => existing.uuid === message.uuid)) continue
        messages.push(message)
        yield { type: 'user_message', message }
      }
      const toolDefinitions = options.tools.map(({ description, inputSchema, name }) => ({
        description,
        inputSchema,
        name,
      }))
      const context = {
        modelId: options.modelId,
        systemPrompt: options.systemPrompt,
        tools: toolDefinitions,
        ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
        ...(userContext ? { userContext } : {}),
      }
      if (options.contextManager) {
        const cleared = options.contextManager.clear(messages)
        if (cleared.clearedToolUseIds.length) {
          yield {
            type: 'tool_results_cleared',
            messages: cleared.messages,
            toolUseIds: cleared.clearedToolUseIds,
          }
          messages.splice(0, messages.length, ...cleared.messages)
        }
        if (options.contextManager.shouldAutoCompact(messages, context)) {
          yield { type: 'compaction_status', status: 'started' }
          let prepared: PreparedCompaction | undefined
          try {
            prepared = await options.contextManager.compact(
              messages,
              buildModelRequest(messages, context),
              controller.signal,
              'auto',
            )
          } catch (error) {
            yield {
              type: 'compaction_status',
              status: controller.signal.aborted ? 'cancelled' : 'failed',
              message: error instanceof Error ? error.message : String(error),
            }
            if (controller.signal.aborted) return { messages, reason: 'aborted' }
          }
          if (prepared) {
            const compacted = buildPostCompactMessages(prepared)
            // The consumer durably commits the boundary before resuming this generator.
            yield { type: 'compact', messages: compacted, compaction: prepared }
            prepared.commit()
            messages.splice(0, messages.length, ...compacted)
            if (prepared.userContext !== undefined) userContext = prepared.userContext
          }
        }
      }
      if (controller.signal.aborted) return { messages, reason: 'aborted' }
      const request = buildModelRequest(messages, {
        ...context,
        ...(userContext ? { userContext } : {}),
      })
      let assistantApiMessage: AssistantMessage
      const stream = streamAssistantResponse(options.model, request, controller.signal)
      try {
        let next = await stream.next()
        while (!next.done) {
          yield { type: 'model_stream', event: next.value }
          next = await stream.next()
        }
        assistantApiMessage = next.value
      } catch (error) {
        return controller.signal.aborted
          ? { messages, reason: 'aborted' }
          : {
              messages,
              reason: 'model_error',
              error: error instanceof Error ? error.message : String(error),
            }
      } finally {
        await stream.return(undefined as never)
      }
      const content = assistantApiMessage.content
      const assistantMessage = {
        ...createAssistantMessage(assistantApiMessage),
        requestTokenEstimate: roughRequestTokens(request),
      }
      messages.push(assistantMessage)
      yield { type: 'assistant_message', message: assistantMessage }

      const toolUses = content.filter((block): block is ToolUseBlock => block.type === 'tool_use')
      if (toolUses.length === 0) {
        const pending = (await options.getPendingMessages?.(messages)) ?? []
        if (pending.some((message) => !messages.some((existing) => existing.uuid === message.uuid)))
          continue
        return { messages, reason: 'completed' }
      }

      toolTurns += 1
      if (options.maxTurns !== undefined && toolTurns > options.maxTurns) {
        const limitMessage = createUserMessage({
          content: toolUses.map((toolUse) => ({
            type: 'tool_result' as const,
            toolUseId: toolUse.id,
            isError: true,
            content: 'Tool was not executed because the maximum tool-use turns were reached',
          })),
        })
        messages.push(limitMessage)
        yield { type: 'user_message', message: limitMessage }
        return { messages, reason: 'max_turns' }
      }

      const toolResults: ToolResultBlock[] = []
      const additionalContexts: SkillActivationContext[] = []
      for (const batch of partitionToolUses(toolUses, options.tools)) {
        for (const toolUse of batch.toolUses) {
          yield { type: 'tool_execution_start', toolUse }
        }

        let batchResults: ToolExecutionResult[]
        if (controller.signal.aborted) {
          batchResults = batch.toolUses.map(abortedToolResult)
        } else if (batch.isConcurrencySafe) {
          batchResults = await Promise.all(
            batch.toolUses.map((toolUse) =>
              executeToolUse(
                toolUse,
                options.tools,
                controller.signal,
                assistantMessage.uuid,
                options.canUseTool,
                options.getAgentIdentity
                  ? {
                      ...options.getAgentIdentity(),
                      messages: [...messages],
                      systemPrompt: options.systemPrompt,
                      userContext,
                      tools: toolDefinitions,
                      maxOutputTokens: options.maxOutputTokens,
                    }
                  : undefined,
              ),
            ),
          )
        } else {
          const toolUse = batch.toolUses[0]
          if (!toolUse) throw new Error('Non-concurrent tool batch must contain one tool')
          batchResults = [
            await executeToolUse(
              toolUse,
              options.tools,
              controller.signal,
              assistantMessage.uuid,
              options.canUseTool,
              options.getAgentIdentity
                ? {
                    ...options.getAgentIdentity(),
                    messages: [...messages],
                    systemPrompt: options.systemPrompt,
                    userContext,
                    tools: toolDefinitions,
                    maxOutputTokens: options.maxOutputTokens,
                  }
                : undefined,
            ),
          ]
        }

        for (const { context, result, outcome } of batchResults) {
          toolResults.push(result)
          if (context) additionalContexts.push(context)
          yield { type: 'tool_result', result, outcome }
        }
      }

      const toolResultMessage = createUserMessage({ content: toolResults })
      messages.push(toolResultMessage)
      yield { type: 'user_message', message: toolResultMessage }
      for (const context of additionalContexts) {
        const contextMessage = createUserMessage(
          { content: [{ text: context.text, type: 'text' }] },
          { isMeta: true, skillContext: context.skillContext },
        )
        messages.push(contextMessage)
        yield { type: 'user_message', message: contextMessage }
      }
    }

    return { messages, reason: 'aborted' }
  } finally {
    externalSignal?.removeEventListener('abort', abort)
  }
}

function abortedToolResult(toolUse: ToolUseBlock): ToolExecutionResult {
  return {
    outcome: 'aborted',
    result: {
      content: 'Tool execution aborted',
      isError: true,
      toolUseId: toolUse.id,
      type: 'tool_result',
    },
  }
}

type ToolBatch = {
  isConcurrencySafe: boolean
  toolUses: ToolUseBlock[]
}

function partitionToolUses(
  toolUses: readonly ToolUseBlock[],
  tools: readonly AgentTool[],
): ToolBatch[] {
  const batches: ToolBatch[] = []

  for (const toolUse of toolUses) {
    const tool = tools.find((candidate) => candidate.name === toolUse.name)
    let isConcurrencySafe = false
    if (tool) {
      try {
        const parsedInput = tool.parseInput?.(toolUse.input) ?? toolUse.input
        isConcurrencySafe = tool.isConcurrencySafe(parsedInput)
      } catch {
        isConcurrencySafe = false
      }
    }

    const previous = batches.at(-1)
    if (isConcurrencySafe && previous?.isConcurrencySafe) {
      previous.toolUses.push(toolUse)
    } else {
      batches.push({ isConcurrencySafe, toolUses: [toolUse] })
    }
  }

  return batches
}

async function executeToolUse(
  toolUse: ToolUseBlock,
  tools: readonly AgentTool[],
  signal: AbortSignal,
  parentMessageUuid: UUID,
  canUseTool?: CanUseTool,
  agent?: AgentSnapshot,
): Promise<ToolExecutionResult> {
  const tool = tools.find((candidate) => candidate.name === toolUse.name)
  let result: AgentToolResult

  if (!tool) {
    result = { content: `Unknown tool: ${toolUse.name}`, isError: true }
  } else {
    let parsedInput: JsonObject
    try {
      // Validation must happen before permission handling so malformed calls
      // cannot trigger misleading approval prompts.
      parsedInput = tool.parseInput?.(toolUse.input) ?? toolUse.input
    } catch (error) {
      return {
        outcome: 'error',
        result: {
          content: `Invalid input for ${tool.name}: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
          toolUseId: toolUse.id,
          type: 'tool_result',
        },
      }
    }
    const decision = await canUseTool?.(tool, parsedInput, {
      parentMessageUuid,
      signal,
      toolUseId: toolUse.id,
      ...(agent ? { agent } : {}),
    })
    if (decision?.behavior === 'deny') {
      return {
        outcome: signal.aborted ? 'aborted' : 'denied',
        result: {
          content: decision.message,
          isError: true,
          toolUseId: toolUse.id,
          type: 'tool_result',
        },
      }
    }
    try {
      result = await tool.execute(
        decision?.behavior === 'allow' ? (decision.updatedInput ?? parsedInput) : parsedInput,
        {
          parentMessageUuid,
          signal,
          toolUseId: toolUse.id,
          ...(agent ? { agent } : {}),
        },
      )
    } catch (error) {
      result = {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  }

  return {
    ...(result.context ? { context: result.context } : {}),
    outcome: signal.aborted ? 'aborted' : result.isError ? 'error' : 'success',
    result: {
      content: result.content,
      ...(result.isError === undefined ? {} : { isError: result.isError }),
      toolUseId: toolUse.id,
      type: 'tool_result',
    },
  }
}
