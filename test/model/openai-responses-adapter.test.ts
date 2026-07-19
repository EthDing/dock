import { describe, expect, it, vi } from 'vitest'
import { OpenAIResponsesAdapter } from '../../src/model/openai-responses-adapter.js'
import type { ModelStreamEvent } from '../../src/model/types.js'

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe('OpenAIResponsesAdapter', () => {
  it('normalizes Responses text streaming events', async () => {
    const create = vi.fn(async () =>
      (async function* () {
        yield { type: 'response.created', response: { id: 'resp_1' } }
        yield { type: 'response.output_text.delta', output_index: 0, delta: 'hello' }
        yield {
          type: 'response.completed',
          response: { usage: { input_tokens: 3, output_tokens: 2 } },
        }
      })(),
    )
    const adapter = new OpenAIResponsesAdapter({ responses: { create } } as never)

    const events = await collect(
      adapter.stream(
        {
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
          modelId: 'gpt-test',
          systemPrompt: ['system'],
          tools: [],
        },
        { signal: new AbortController().signal },
      ),
    )

    expect(events).toEqual([
      { type: 'message_start', messageId: 'resp_1' },
      { type: 'content_block_start', index: 0, block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        stopReason: 'end_turn',
        usage: { inputTokens: 3, outputTokens: 2 },
      },
      { type: 'message_stop' },
    ])
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-test', stream: true }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })
})
