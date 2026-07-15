import type {
  AssistantMessage,
  JsonObject,
  JsonSchema,
  ModelAdapter,
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
} from '../messages/create-message.js'

export type AgentToolResult = {
  content: string
  isError?: boolean
}

export type AgentTool = {
  name: string
  description: string
  inputSchema: JsonSchema
  isConcurrencySafe: (input: JsonObject) => boolean
  execute: (input: JsonObject, options: { signal: AbortSignal }) => Promise<AgentToolResult>
}

export type AgentLoopOptions = {
  model: ModelAdapter
  modelId: string
  systemPrompt: readonly string[]
  messages: readonly TranscriptMessage[]
  tools: readonly AgentTool[]
  signal?: AbortSignal
  maxTurns?: number
}

export type AgentEvent =
  | { type: 'model_stream'; event: ModelStreamEvent }
  | { type: 'assistant_message'; message: AssistantTranscriptMessage }
  | { type: 'tool_execution_start'; toolUse: ToolUseBlock }
  | { type: 'tool_result'; result: ToolResultBlock }

export type AgentLoopResult = {
  reason: 'aborted' | 'completed' | 'max_turns' | 'model_error'
  messages: readonly TranscriptMessage[]
  error?: string
}

type PendingBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
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
      const request: ModelRequest = {
        messages: messages.map((message) => message.message),
        modelId: options.modelId,
        systemPrompt: options.systemPrompt,
        tools: options.tools.map(({ description, inputSchema, name }) => ({
          description,
          inputSchema,
          name,
        })),
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
              break
            case 'content_block_start':
              if (event.block.type === 'text') {
                blocks.set(event.index, { type: 'text', text: '' })
              } else if (event.block.type === 'thinking') {
                blocks.set(event.index, { type: 'thinking', thinking: '' })
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
              usage = event.usage
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
          if (controller.signal.aborted) return { messages, reason: 'aborted' }
          yield { type: 'tool_execution_start', toolUse }
        }

        let batchResults: ToolResultBlock[]
        if (batch.isConcurrencySafe) {
          batchResults = await Promise.all(
            batch.toolUses.map((toolUse) =>
              executeToolUse(toolUse, options.tools, controller.signal),
            ),
          )
        } else {
          const toolUse = batch.toolUses[0]
          if (!toolUse) throw new Error('Non-concurrent tool batch must contain one tool')
          batchResults = [await executeToolUse(toolUse, options.tools, controller.signal)]
        }

        for (const result of batchResults) {
          toolResults.push(result)
          yield { type: 'tool_result', result }
        }
      }

      messages.push(createUserMessage({ content: toolResults }))
    }

    return { messages, reason: 'aborted' }
  } finally {
    externalSignal?.removeEventListener('abort', abort)
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
): Promise<ToolResultBlock> {
  const tool = tools.find((candidate) => candidate.name === toolUse.name)
  let result: AgentToolResult

  if (!tool) {
    result = { content: `Unknown tool: ${toolUse.name}`, isError: true }
  } else {
    try {
      result = await tool.execute(toolUse.input, { signal })
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
