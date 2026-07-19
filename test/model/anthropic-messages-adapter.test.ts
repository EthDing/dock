import { describe, expect, it, vi } from 'vitest'
import { AnthropicMessagesAdapter } from '../../src/model/anthropic-messages-adapter.js'
import type { ModelStreamEvent } from '../../src/model/types.js'

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe('AnthropicMessagesAdapter', () => {
  it('normalizes Anthropic content-block streaming events', async () => {
    const create = vi.fn(async () =>
      (async function* () {
        yield {
          type: 'message_start',
          message: { id: 'msg_1', usage: { input_tokens: 10, output_tokens: 1 } },
        }
        yield {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool_1', name: 'Read', input: {} },
        }
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"file_path":"a"}' },
        }
        yield { type: 'content_block_stop', index: 0 }
        yield {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 5 },
        }
        yield { type: 'message_stop' }
      })(),
    )
    const adapter = new AnthropicMessagesAdapter({ messages: { create } } as never)

    const events = await collect(
      adapter.stream(
        {
          messages: [{ role: 'user', content: [{ type: 'text', text: 'read' }] }],
          modelId: 'claude-test',
          systemPrompt: ['system'],
          tools: [{ name: 'Read', description: 'read', inputSchema: { type: 'object' } }],
        },
        { signal: new AbortController().signal },
      ),
    )

    expect(events).toEqual([
      {
        type: 'message_start',
        messageId: 'msg_1',
        usage: { inputTokens: 10, outputTokens: 1 },
      },
      {
        type: 'content_block_start',
        index: 0,
        block: { type: 'tool_use', id: 'tool_1', name: 'Read' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partialJson: '{"file_path":"a"}' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', stopReason: 'tool_use', usage: { outputTokens: 5 } },
      { type: 'message_stop' },
    ])
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-test', stream: true }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })
})
