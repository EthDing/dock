import type { ModelAdapter, ModelRequest, ModelStreamEvent, StopReason, Usage } from './types.js'
import { DEFAULT_MAX_OUTPUT_TOKENS, rethrowWithOutputTokenHint } from './output-tokens.js'

type AnthropicClient = {
  messages: {
    create: (body: unknown, options: { signal: AbortSignal }) => Promise<AsyncIterable<unknown>>
  }
}

export class AnthropicMessagesAdapter implements ModelAdapter {
  readonly #client: AnthropicClient

  constructor(client: AnthropicClient) {
    this.#client = client
  }

  async *stream(
    request: ModelRequest,
    options: { signal: AbortSignal },
  ): AsyncGenerator<ModelStreamEvent> {
    const cached = prepareCachedPayload(request)
    const stream = await this.#client.messages
      .create(
        {
          max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          messages: cached.messages,
          model: request.modelId,
          stream: true,
          system: cached.system,
          tools: cached.tools,
        },
        { signal: options.signal },
      )
      .catch(rethrowWithOutputTokenHint)

    for await (const value of stream) {
      const event = asObject(value)
      if (!event || typeof event.type !== 'string') continue
      switch (event.type) {
        case 'message_start': {
          const message = asObject(event.message)
          if (!message || typeof message.id !== 'string') continue
          yield {
            messageId: message.id,
            type: 'message_start',
            ...optionalUsage(asObject(message.usage)),
          }
          break
        }
        case 'content_block_start': {
          if (typeof event.index !== 'number') continue
          const block = asObject(event.content_block)
          if (!block || typeof block.type !== 'string') continue
          if (block.type === 'text') {
            yield { block: { type: 'text' }, index: event.index, type: 'content_block_start' }
          } else if (block.type === 'thinking') {
            yield { block: { type: 'thinking' }, index: event.index, type: 'content_block_start' }
          } else if (
            block.type === 'tool_use' &&
            typeof block.id === 'string' &&
            typeof block.name === 'string'
          ) {
            yield {
              block: { id: block.id, name: block.name, type: 'tool_use' },
              index: event.index,
              type: 'content_block_start',
            }
          }
          break
        }
        case 'content_block_delta': {
          if (typeof event.index !== 'number') continue
          const delta = asObject(event.delta)
          if (!delta || typeof delta.type !== 'string') continue
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            yield {
              delta: { text: delta.text, type: 'text_delta' },
              index: event.index,
              type: 'content_block_delta',
            }
          } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            yield {
              delta: { thinking: delta.thinking, type: 'thinking_delta' },
              index: event.index,
              type: 'content_block_delta',
            }
          } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
            yield {
              delta: { signature: delta.signature, type: 'signature_delta' },
              index: event.index,
              type: 'content_block_delta',
            }
          } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            yield {
              delta: { partialJson: delta.partial_json, type: 'input_json_delta' },
              index: event.index,
              type: 'content_block_delta',
            }
          }
          break
        }
        case 'content_block_stop':
          if (typeof event.index === 'number') {
            yield { index: event.index, type: 'content_block_stop' }
          }
          break
        case 'message_delta': {
          const delta = asObject(event.delta)
          const stopReason = normalizeStopReason(delta?.stop_reason)
          if (!stopReason) continue
          yield {
            stopReason,
            type: 'message_delta',
            usage: toUsage(asObject(event.usage)),
          }
          break
        }
        case 'message_stop':
          yield { type: 'message_stop' }
          break
        case 'error':
          throw new Error(String(asObject(event.error)?.message ?? 'Anthropic stream error'))
      }
    }
  }
}

function toAnthropicMessage(message: ModelRequest['messages'][number]): WireMessage {
  return {
    role: message.role,
    content: message.content.map((block) => {
      if (block.type === 'text') return { ...block }
      if (block.type === 'tool_result') {
        return {
          content: block.content,
          is_error: block.isError ?? false,
          tool_use_id: block.toolUseId,
          type: 'tool_result',
        }
      }
      if (block.type === 'tool_use') {
        return { id: block.id, input: block.input, name: block.name, type: 'tool_use' }
      }
      return {
        thinking: block.thinking,
        ...(block.signature ? { signature: block.signature } : {}),
        type: 'thinking',
      }
    }),
  }
}

function optionalUsage(value: Record<string, unknown> | undefined): { usage?: Usage } {
  const usage = toUsage(value)
  return Object.keys(usage).length > 0 ? { usage } : {}
}

function toUsage(value: Record<string, unknown> | undefined): Usage {
  if (!value) return {}
  return {
    ...(['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].some(
      (key) => typeof value[key] === 'number',
    )
      ? {
          inputTokens: [
            'input_tokens',
            'cache_read_input_tokens',
            'cache_creation_input_tokens',
          ].reduce(
            (total, key) => total + (typeof value[key] === 'number' ? (value[key] as number) : 0),
            0,
          ),
        }
      : {}),
    ...(typeof value.output_tokens === 'number' ? { outputTokens: value.output_tokens } : {}),
    ...(typeof value.cache_read_input_tokens === 'number'
      ? { cacheReadInputTokens: value.cache_read_input_tokens }
      : {}),
    ...(typeof value.cache_creation_input_tokens === 'number'
      ? { cacheCreationInputTokens: value.cache_creation_input_tokens }
      : {}),
  }
}

function normalizeStopReason(value: unknown): StopReason | undefined {
  return value === 'end_turn' ||
    value === 'max_tokens' ||
    value === 'stop_sequence' ||
    value === 'tool_use'
    ? value
    : undefined
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
type WireMessage = { role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }
function prepareCachedPayload(request: ModelRequest) {
  const messages = request.messages.map(toAnthropicMessage)
  const tools: Array<Record<string, unknown>> = request.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }))
  const system: Array<Record<string, unknown>> = request.systemPrompt.length
    ? [{ type: 'text', text: request.systemPrompt.join('\n\n') }]
    : []
  const end = Math.min(request.cachePrefixMessageCount ?? messages.length, messages.length)
  if (end > 0) {
    const cacheControl = { type: 'ephemeral' }
    const systemTail = system.at(-1)
    const toolTail = tools.at(-1)
    if (systemTail) systemTail.cache_control = cacheControl
    if (toolTail) toolTail.cache_control = cacheControl
    // Two history breakpoints retain the previous request boundary when the
    // assistant response is appended. Never mark the fork's summary instruction.
    let remaining = 2
    for (let index = end - 1; index >= 0 && remaining > 0; index--) {
      const block = messages[index]?.content.findLast((value) => value.type !== 'thinking')
      if (block) {
        block.cache_control = cacheControl
        remaining--
      }
    }
  }
  return { messages, tools, system }
}
