import { describe, expect, it, vi } from 'vitest'
import { OpenAIChatAdapter } from '../../src/model/openai-chat-adapter.js'
import type { ModelStreamEvent } from '../../src/model/types.js'

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe('OpenAIChatAdapter', () => {
  it('normalizes chat-completion text chunks', async () => {
    const create = vi.fn(async () =>
      (async function* () {
        yield { id: 'chat_1', choices: [{ delta: { content: 'hello' }, finish_reason: null }] }
        yield {
          id: 'chat_1',
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 2 },
        }
      })(),
    )
    const adapter = new OpenAIChatAdapter({ chat: { completions: { create } } } as never)

    const events = await collect(
      adapter.stream(
        {
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
          modelId: 'compatible-model',
          systemPrompt: ['system'],
          tools: [],
        },
        { signal: new AbortController().signal },
      ),
    )

    expect(events).toEqual([
      { type: 'message_start', messageId: 'chat_1' },
      { type: 'content_block_start', index: 0, block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        stopReason: 'end_turn',
        usage: { inputTokens: 4, outputTokens: 2 },
      },
      { type: 'message_stop' },
    ])
  })
})
