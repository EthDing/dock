import type { ModelAdapter, ModelRequest, ModelStreamEvent, StopReason, Usage } from './types.js'
import { DEFAULT_MAX_OUTPUT_TOKENS, rethrowWithOutputTokenHint } from './output-tokens.js'

type OpenAIClient = {
  responses: {
    create: (body: unknown, options: { signal: AbortSignal }) => Promise<AsyncIterable<unknown>>
  }
}

export class OpenAIResponsesAdapter implements ModelAdapter {
  readonly #client: OpenAIClient

  constructor(client: OpenAIClient) {
    this.#client = client
  }

  async *stream(
    request: ModelRequest,
    options: { signal: AbortSignal },
  ): AsyncGenerator<ModelStreamEvent> {
    const stream = await this.#client.responses
      .create(
        {
          input: toResponsesInput(request),
          instructions: request.systemPrompt.join('\n\n'),
          max_output_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          model: request.modelId,
          stream: true,
          tools: request.tools.map((tool) => ({
            description: tool.description,
            name: tool.name,
            parameters: tool.inputSchema,
            strict: true,
            type: 'function',
          })),
        },
        { signal: options.signal },
      )
      .catch(rethrowWithOutputTokenHint)

    const blocks = new Map<number, { index: number; itemId?: string; type: 'text' | 'tool' }>()
    let nextIndex = 0
    let sawTool = false

    for await (const value of stream) {
      const event = asObject(value)
      if (!event || typeof event.type !== 'string') continue
      if (event.type === 'response.created') {
        const response = asObject(event.response)
        if (response && typeof response.id === 'string') {
          yield { messageId: response.id, type: 'message_start' }
        }
      } else if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        const outputIndex = typeof event.output_index === 'number' ? event.output_index : 0
        let block = blocks.get(outputIndex)
        if (!block) {
          block = { index: nextIndex++, type: 'text' }
          blocks.set(outputIndex, block)
          yield { block: { type: 'text' }, index: block.index, type: 'content_block_start' }
        }
        yield {
          delta: { text: event.delta, type: 'text_delta' },
          index: block.index,
          type: 'content_block_delta',
        }
      } else if (event.type === 'response.output_item.added') {
        const item = asObject(event.item)
        if (
          item?.type === 'function_call' &&
          typeof item.name === 'string' &&
          (typeof item.call_id === 'string' || typeof item.id === 'string')
        ) {
          const outputIndex =
            typeof event.output_index === 'number' ? event.output_index : nextIndex
          const block = {
            index: nextIndex++,
            ...(typeof item.id === 'string' ? { itemId: item.id } : {}),
            type: 'tool' as const,
          }
          blocks.set(outputIndex, block)
          sawTool = true
          yield {
            block: {
              id: typeof item.call_id === 'string' ? item.call_id : String(item.id),
              name: item.name,
              type: 'tool_use',
            },
            index: block.index,
            type: 'content_block_start',
          }
        }
      } else if (
        event.type === 'response.function_call_arguments.delta' &&
        typeof event.delta === 'string'
      ) {
        const block = findBlock(blocks, event)
        if (block) {
          yield {
            delta: { partialJson: event.delta, type: 'input_json_delta' },
            index: block.index,
            type: 'content_block_delta',
          }
        }
      } else if (event.type === 'response.output_item.done') {
        const block = findBlock(blocks, event)
        if (block) yield { index: block.index, type: 'content_block_stop' }
      } else if (event.type === 'response.completed') {
        for (const block of blocks.values()) {
          if (block.type === 'text') yield { index: block.index, type: 'content_block_stop' }
        }
        const response = asObject(event.response)
        yield {
          stopReason: (sawTool ? 'tool_use' : 'end_turn') satisfies StopReason,
          type: 'message_delta',
          usage: toUsage(asObject(response?.usage)),
        }
        yield { type: 'message_stop' }
      } else if (event.type === 'error' || event.type === 'response.failed') {
        throw new Error(String(asObject(event.error)?.message ?? 'OpenAI response stream error'))
      }
    }
  }
}

function toResponsesInput(request: ModelRequest): unknown[] {
  const input: unknown[] = []
  for (const message of request.messages) {
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    if (text) input.push({ content: text, role: message.role, type: 'message' })
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        input.push({
          arguments: JSON.stringify(block.input),
          call_id: block.id,
          name: block.name,
          type: 'function_call',
        })
      } else if (block.type === 'tool_result') {
        input.push({
          call_id: block.toolUseId,
          output: block.content,
          type: 'function_call_output',
        })
      }
    }
  }
  return input
}

function findBlock(
  blocks: Map<number, { index: number; itemId?: string; type: 'text' | 'tool' }>,
  event: Record<string, unknown>,
): { index: number; itemId?: string; type: 'text' | 'tool' } | undefined {
  if (typeof event.output_index === 'number') return blocks.get(event.output_index)
  if (typeof event.item_id === 'string') {
    return [...blocks.values()].find((block) => block.itemId === event.item_id)
  }
  return undefined
}

function toUsage(value: Record<string, unknown> | undefined): Usage {
  if (!value) return {}
  const inputDetails = asObject(value.input_tokens_details)
  return {
    ...(typeof value.input_tokens === 'number' ? { inputTokens: value.input_tokens } : {}),
    ...(typeof value.output_tokens === 'number' ? { outputTokens: value.output_tokens } : {}),
    ...(typeof inputDetails?.cached_tokens === 'number'
      ? { cacheReadInputTokens: inputDetails.cached_tokens }
      : {}),
    ...(typeof inputDetails?.cache_write_tokens === 'number'
      ? { cacheCreationInputTokens: inputDetails.cache_write_tokens }
      : {}),
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
