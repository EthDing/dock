import type { UUID } from 'node:crypto'
import type { ContextManager } from '../context/context-manager.js'
import type {
  AssistantMessage,
  JsonObject,
  ModelAdapter,
  ModelMessage,
  ModelRequest,
  ModelStreamEvent,
  StopReason,
  ToolResultBlock,
  ToolUseBlock,
  Usage,
} from '../model/types.js'
import {
  createAssistantMessage,
  createUserMessage,
  type AssistantTranscriptMessage,
  type TranscriptMessage,
  type UserTranscriptMessage,
} from '../messages/create-message.js'
import type { AgentTool, AgentToolResult, CanUseTool } from '../tools/types.js'

export type AgentLoopOptions = {
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

export type AgentEvent =
  | { type: 'compact'; messages: readonly TranscriptMessage[] }
  | { type: 'model_stream'; event: ModelStreamEvent }
  | { type: 'assistant_message'; message: AssistantTranscriptMessage }
  | { type: 'user_message'; message: UserTranscriptMessage }
  | { type: 'tool_execution_start'; toolUse: ToolUseBlock }
  | { type: 'tool_result'; result: ToolResultBlock }

export type AgentLoopResult = {
  reason: 'aborted' | 'completed' | 'max_turns' | 'model_error'
  messages: readonly TranscriptMessage[]
  error?: string
}

type PendingBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'tool_use'; id: string; name: string; partialJson: string }

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

  try {
    while (!controller.signal.aborted) {
      const toolDefinitions = options.tools.map(({ description, inputSchema, name }) => ({
        description,
        inputSchema,
        name,
      }))
      if (options.contextManager) {
        const prepared = await options.contextManager.prepare(messages, {
          systemPrompt: options.systemPrompt,
          tools: toolDefinitions,
        })
        if (prepared.messages !== messages) {
          messages.splice(0, messages.length, ...prepared.messages)
        }
        if (prepared.compacted) yield { messages: [...messages], type: 'compact' }
      }
      const request: ModelRequest = {
        ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
        messages: [
          ...buildUserContextMessages(options.userContext),
          ...messages.map((message) => message.message),
        ],
        modelId: options.modelId,
        systemPrompt: options.systemPrompt,
        tools: toolDefinitions,
      }

      const blocks = new Map<number, PendingBlock>()
      let messageId: string | undefined
      let stopReason: StopReason | undefined
      let usage: Usage = {}

      try {
        for await (const event of options.model.stream(request, { signal: controller.signal })) {
          yield { type: 'model_stream', event }

          switch (event.type) {
            case 'message_start':
              messageId = event.messageId
              usage = { ...usage, ...event.usage }
              break
            case 'content_block_start':
              if (event.block.type === 'text') {
                blocks.set(event.index, { type: 'text', text: '' })
              } else if (event.block.type === 'thinking') {
                blocks.set(event.index, { type: 'thinking', thinking: '', signature: '' })
              } else {
                blocks.set(event.index, {
                  type: 'tool_use',
                  id: event.block.id,
                  name: event.block.name,
                  partialJson: '',
                })
              }
              break
            case 'content_block_delta': {
              const block = blocks.get(event.index)
              if (!block) throw new Error(`Delta for unknown content block ${event.index}`)
              if (block.type === 'text' && event.delta.type === 'text_delta') {
                block.text += event.delta.text
              } else if (block.type === 'thinking' && event.delta.type === 'thinking_delta') {
                block.thinking += event.delta.thinking
              } else if (block.type === 'thinking' && event.delta.type === 'signature_delta') {
                block.signature += event.delta.signature
              } else if (block.type === 'tool_use' && event.delta.type === 'input_json_delta') {
                block.partialJson += event.delta.partialJson
              } else {
                throw new Error(`Invalid delta ${event.delta.type} for ${block.type} block`)
              }
              break
            }
            case 'content_block_stop':
              if (!blocks.has(event.index)) {
                throw new Error(`Stop for unknown content block ${event.index}`)
              }
              break
            case 'message_delta':
              stopReason = event.stopReason
              usage = { ...usage, ...event.usage }
              break
            case 'message_stop':
              break
          }
        }
      } catch (error) {
        if (controller.signal.aborted) {
          return { messages, reason: 'aborted' }
        }
        return {
          error: error instanceof Error ? error.message : String(error),
          messages,
          reason: 'model_error',
        }
      }

      if (!messageId || !stopReason) {
        return {
          error: 'Model stream ended without message metadata',
          messages,
          reason: 'model_error',
        }
      }

      let content: AssistantMessage['content']
      try {
        content = [...blocks.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, block]) => {
            if (block.type !== 'tool_use') return block
            return {
              type: 'tool_use' as const,
              id: block.id,
              name: block.name,
              input: parseToolInput(block.name, block.partialJson),
            }
          })
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          messages,
          reason: 'model_error',
        }
      }

      const assistantApiMessage: AssistantMessage = {
        content,
        id: messageId,
        role: 'assistant',
        stopReason,
        usage,
      }
      const assistantMessage = createAssistantMessage(assistantApiMessage)
      messages.push(assistantMessage)
      yield { type: 'assistant_message', message: assistantMessage }

      const toolUses = content.filter((block): block is ToolUseBlock => block.type === 'tool_use')
      if (toolUses.length === 0) {
        return { messages, reason: 'completed' }
      }

      toolTurns += 1
      if (options.maxTurns !== undefined && toolTurns > options.maxTurns) {
        return { messages, reason: 'max_turns' }
      }

      const toolResults: ToolResultBlock[] = []
      for (const batch of partitionToolUses(toolUses, options.tools)) {
        for (const toolUse of batch.toolUses) {
          yield { type: 'tool_execution_start', toolUse }
        }

        let batchResults: ToolResultBlock[]
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
            ),
          ]
        }

        for (const result of batchResults) {
          toolResults.push(result)
          yield { type: 'tool_result', result }
        }
      }

      const toolResultMessage = createUserMessage({ content: toolResults })
      messages.push(toolResultMessage)
      yield { type: 'user_message', message: toolResultMessage }
    }

    return { messages, reason: 'aborted' }
  } finally {
    externalSignal?.removeEventListener('abort', abort)
  }
}

function abortedToolResult(toolUse: ToolUseBlock): ToolResultBlock {
  return {
    content: 'Tool execution aborted',
    isError: true,
    toolUseId: toolUse.id,
    type: 'tool_result',
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function buildUserContextMessages(
  context: Readonly<Record<string, string>> | undefined,
): ModelMessage[] {
  if (!context || Object.keys(context).length === 0) return []
  const content = Object.entries(context)
    .map(([key, value]) => `# ${key}\n${value}`)
    .join('\n')
  return [
    {
      content: [
        {
          text: `<system-reminder>\nAs you answer the user's questions, you can use the following context:\n${content}\n\nIMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>`,
          type: 'text',
        },
      ],
      role: 'user',
    },
  ]
}

function parseToolInput(toolName: string, partialJson: string): JsonObject {
  let parsed: unknown
  try {
    parsed = JSON.parse(partialJson || '{}') as unknown
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid JSON input for tool ${toolName}: ${detail}`)
  }

  if (!isJsonObject(parsed)) throw new Error(`Tool ${toolName} input must be an object`)
  return parsed
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
        isConcurrencySafe = tool.isConcurrencySafe(toolUse.input)
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
): Promise<ToolResultBlock> {
  const tool = tools.find((candidate) => candidate.name === toolUse.name)
  let result: AgentToolResult

  if (!tool) {
    result = { content: `Unknown tool: ${toolUse.name}`, isError: true }
  } else {
    const decision = await canUseTool?.(tool, toolUse.input, {
      parentMessageUuid,
      signal,
      toolUseId: toolUse.id,
    })
    if (decision?.behavior === 'deny') {
      return {
        content: decision.message,
        isError: true,
        toolUseId: toolUse.id,
        type: 'tool_result',
      }
    }
    try {
      result = await tool.execute(toolUse.input, { parentMessageUuid, signal })
    } catch (error) {
      result = {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  }

  return {
    content: result.content,
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    toolUseId: toolUse.id,
    type: 'tool_result',
  }
}
