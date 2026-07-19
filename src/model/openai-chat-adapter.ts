import type { ModelAdapter, ModelRequest, ModelStreamEvent, StopReason, Usage } from './types.js'

type OpenAIChatClient = {
  chat: {
    completions: {
      create: (body: unknown, options: { signal: AbortSignal }) => Promise<AsyncIterable<unknown>>
    }
  }
}

export class OpenAIChatAdapter implements ModelAdapter {
  readonly #client: OpenAIChatClient

  constructor(client: OpenAIChatClient) {
    this.#client = client
  }

  async *stream(
    request: ModelRequest,
    options: { signal: AbortSignal },
  ): AsyncGenerator<ModelStreamEvent> {
    const stream = await this.#client.chat.completions.create(
      {
        max_completion_tokens: request.maxOutputTokens,
        messages: toChatMessages(request),
        model: request.modelId,
        stream: true,
        stream_options: { include_usage: true },
        tools: request.tools.map((tool) => ({
          function: {
            description: tool.description,
            name: tool.name,
            parameters: tool.inputSchema,
            strict: true,
          },
          type: 'function',
        })),
      },
      { signal: options.signal },
    )

    let started = false
    let textStarted = false
    let nextIndex = 1
    const toolBlocks = new Map<number, { blockIndex: number; id: string; name: string }>()
    let finalUsage: Usage = {}
    let stopReason: StopReason = 'end_turn'

    for await (const value of stream) {
      const chunk = asObject(value)
      if (!chunk) continue
      if (!started && typeof chunk.id === 'string') {
        started = true
        yield { messageId: chunk.id, type: 'message_start' }
      }
      finalUsage = { ...finalUsage, ...toUsage(asObject(chunk.usage)) }
      const choice = Array.isArray(chunk.choices) ? asObject(chunk.choices[0]) : undefined
      if (!choice) continue
      const delta = asObject(choice.delta)
      if (delta && typeof delta.content === 'string' && delta.content) {
        if (!textStarted) {
          textStarted = true
          yield { block: { type: 'text' }, index: 0, type: 'content_block_start' }
        }
        yield {
          delta: { text: delta.content, type: 'text_delta' },
          index: 0,
          type: 'content_block_delta',
        }
      }

      if (delta && Array.isArray(delta.tool_calls)) {
        for (const rawCall of delta.tool_calls) {
          const call = asObject(rawCall)
          if (!call || typeof call.index !== 'number') continue
          const fn = asObject(call.function)
          let block = toolBlocks.get(call.index)
          if (!block && typeof call.id === 'string' && typeof fn?.name === 'string') {
            block = { blockIndex: nextIndex++, id: call.id, name: fn.name }
            toolBlocks.set(call.index, block)
            yield {
              block: { id: block.id, name: block.name, type: 'tool_use' },
              index: block.blockIndex,
              type: 'content_block_start',
            }
          }
          if (block && typeof fn?.arguments === 'string' && fn.arguments) {
            yield {
              delta: { partialJson: fn.arguments, type: 'input_json_delta' },
              index: block.blockIndex,
              type: 'content_block_delta',
            }
          }
        }
      }

      if (typeof choice.finish_reason === 'string') {
        stopReason = normalizeFinishReason(choice.finish_reason)
      }
    }

    if (textStarted) yield { index: 0, type: 'content_block_stop' }
    for (const block of toolBlocks.values()) {
      yield { index: block.blockIndex, type: 'content_block_stop' }
    }
    yield { stopReason, type: 'message_delta', usage: finalUsage }
    yield { type: 'message_stop' }
  }
}

function toChatMessages(request: ModelRequest): unknown[] {
  const messages: unknown[] = []
  if (request.systemPrompt.length > 0) {
    messages.push({ content: request.systemPrompt.join('\n\n'), role: 'system' })
  }
  for (const message of request.messages) {
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    const toolCalls = message.content
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({
        function: { arguments: JSON.stringify(block.input), name: block.name },
        id: block.id,
        type: 'function',
      }))
    if (message.role === 'assistant') {
      messages.push({
        content: text || null,
        role: 'assistant',
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
    } else {
      if (text) messages.push({ content: text, role: 'user' })
      for (const block of message.content) {
        if (block.type === 'tool_result') {
          messages.push({ content: block.content, role: 'tool', tool_call_id: block.toolUseId })
        }
      }
    }
  }
  return messages
}

function normalizeFinishReason(value: string): StopReason {
  if (value === 'tool_calls' || value === 'function_call') return 'tool_use'
  if (value === 'length') return 'max_tokens'
  if (value === 'stop') return 'end_turn'
  return 'stop_sequence'
}

function toUsage(value: Record<string, unknown> | undefined): Usage {
  if (!value) return {}
  return {
    ...(typeof value.prompt_tokens === 'number' ? { inputTokens: value.prompt_tokens } : {}),
    ...(typeof value.completion_tokens === 'number'
      ? { outputTokens: value.completion_tokens }
      : {}),
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
