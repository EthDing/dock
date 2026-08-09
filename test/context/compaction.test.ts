import { describe, expect, it } from 'vitest'
import { compactConversation, truncateHeadForRetry } from '../../src/context/compaction.js'
import { createAssistantMessage, createUserMessage } from '../../src/messages/create-message.js'
import { FakeModelAdapter } from '../../src/model/fake-model.js'
import type { ModelAdapter, ModelRequest, ModelStreamEvent } from '../../src/model/types.js'

function response(text: string, tool = false): ModelStreamEvent[] {
  return [
    { type: 'message_start', messageId: 'summary' },
    {
      type: 'content_block_start',
      index: 0,
      block: tool ? { type: 'tool_use', id: 'call', name: 'Read' } : { type: 'text' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: tool ? { type: 'input_json_delta', partialJson: '{}' } : { type: 'text_delta', text },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      stopReason: tool ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 50, outputTokens: 10 },
    },
    { type: 'message_stop' },
  ]
}
const messages = [
  createUserMessage({ content: [{ type: 'text', text: 'Keep the exact user request' }] }),
]
const request: ModelRequest = {
  modelId: 'model',
  systemPrompt: ['Original system'],
  messages: messages.map((m) => m.message),
  maxOutputTokens: 8192,
  tools: [
    { name: 'Read', description: 'Read files', inputSchema: {} },
    { name: 'Bash', description: 'Bash', inputSchema: {} },
  ],
}
const base = { messages, request, trigger: 'manual' as const, signal: new AbortController().signal }
describe('ordinary compaction', () => {
  it('appends the full summary instruction to the original structured prefix', async () => {
    const model = new FakeModelAdapter([
      response('<analysis>draft</analysis><summary>Keep this</summary>'),
    ])
    const result = await compactConversation({ ...base, model, instructions: 'focus on tests' })
    expect(model.requests).toHaveLength(1)
    const sent = model.requests[0]
    if (!sent) throw new Error('Missing model request')
    expect(sent.systemPrompt).toEqual(request.systemPrompt)
    expect(sent.tools).toEqual(request.tools)
    expect(sent.maxOutputTokens).toBe(request.maxOutputTokens)
    expect(sent.messages.slice(0, -1)).toEqual(request.messages)
    expect(sent.cachePrefixMessageCount).toBe(request.messages.length)
    expect(JSON.stringify(sent.messages.at(-1))).toContain('focus on tests')
    expect(JSON.stringify(sent.messages.at(-1))).toContain('Primary Request and Intent')
    expect(result.summaryMessages).toHaveLength(1)
    expect(JSON.stringify(result.summaryMessages)).toContain('Keep this')
    expect(JSON.stringify(result.summaryMessages)).not.toContain('draft')
    expect(result.usage.inputTokens).toBe(50)
  })
  it('does not execute a requested tool and falls back once without a tool loop', async () => {
    const model = new FakeModelAdapter([response('', true), response('fallback summary')])
    const result = await compactConversation({ ...base, model })
    expect(model.requests).toHaveLength(2)
    expect(model.requests[1]?.tools.map((t) => t.name)).toEqual(['Read'])
    expect(model.requests[1]?.messages.at(-1)).toEqual(model.requests[0]?.messages.at(-1))
    expect(JSON.stringify(result.summaryMessages)).toContain('fallback summary')
  })
  it('does not restore a hidden Read tool, or commit empty and error text', async () => {
    const model = new FakeModelAdapter([response(''), response('API Error: failure')])
    await expect(
      compactConversation({ ...base, request: { ...request, tools: [] }, model }),
    ).rejects.toThrow()
    expect(model.requests[1]?.tools).toEqual([])
    expect(messages).toHaveLength(1)
  })
  it('does not retry cancellation', async () => {
    const abort = new AbortController()
    let calls = 0
    const model: ModelAdapter = {
      async *stream() {
        calls++
        abort.abort()
        yield* response('bad summary')
      },
    }
    await expect(compactConversation({ ...base, signal: abort.signal, model })).rejects.toThrow()
    expect(calls).toBe(1)
  })
  it('retries context overflow by complete API groups, at most three times', async () => {
    let calls = 0
    const model: ModelAdapter = {
      async *stream() {
        calls++
        yield* []
        throw new Error('maximum context length exceeded')
      },
    }
    const history = Array.from({ length: 9 }, (_, i) => [
      createUserMessage({ content: [{ type: 'text', text: `request ${i}` }] }),
      createAssistantMessage({
        content: [{ type: 'text', text: `answer ${i}` }],
        id: String(i),
        role: 'assistant',
        stopReason: 'end_turn',
        usage: {},
      }),
    ]).flat()
    await expect(
      compactConversation({
        ...base,
        messages: history,
        request: { ...request, messages: history.map((m) => m.message) },
        model,
      }),
    ).rejects.toThrow()
    expect(calls).toBe(4)
  })
  it('keeps tool uses with their results when trimming and keeps a nonempty user-first history', () => {
    const history = [
      createUserMessage({ content: [{ type: 'text', text: 'request' }] }),
      createAssistantMessage({
        id: 'tool',
        role: 'assistant',
        stopReason: 'tool_use',
        usage: {},
        content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }],
      }),
      createUserMessage({
        content: [{ type: 'tool_result', toolUseId: 't', content: 'contents' }],
      }),
      createAssistantMessage({
        id: 'final',
        role: 'assistant',
        stopReason: 'end_turn',
        usage: {},
        content: [{ type: 'text', text: 'done' }],
      }),
    ]
    const trimmed = truncateHeadForRetry(history)
    if (!trimmed) throw new Error('Expected retry history')
    expect(trimmed[0]?.type).toBe('user')
    expect(
      trimmed.some((m) => m.message.content.some((b) => b.type === 'tool_use' && b.id === 't')),
    ).toBe(true)
    expect(
      trimmed.some((m) =>
        m.message.content.some((b) => b.type === 'tool_result' && b.toolUseId === 't'),
      ),
    ).toBe(true)
  })

  it('repairs a partially missing result batch in one immediate user message', () => {
    const history = [
      createUserMessage({ content: [{ type: 'text', text: 'request' }] }),
      createAssistantMessage({
        id: 'tools',
        role: 'assistant',
        stopReason: 'tool_use',
        usage: {},
        content: ['a', 'b'].map((id) => ({
          type: 'tool_use' as const,
          id,
          name: 'Read',
          input: {},
        })),
      }),
      createUserMessage({ content: [{ type: 'tool_result', toolUseId: 'a', content: 'found a' }] }),
      createAssistantMessage({
        id: 'tail',
        role: 'assistant',
        stopReason: 'end_turn',
        usage: {},
        content: [{ type: 'text', text: 'tail' }],
      }),
    ]
    const trimmed = truncateHeadForRetry(history) ?? []
    const index = trimmed.findIndex((m) => m.type === 'assistant' && m.message.id === 'tools')
    expect(
      trimmed[index + 1]?.message.content
        .filter((b) => b.type === 'tool_result')
        .map((b) => b.toolUseId)
        .sort(),
    ).toEqual(['a', 'b'])
  })

  it('falls back when the fork returns only a discarded draft', async () => {
    const model = new FakeModelAdapter([
      response('<analysis>draft only</analysis>'),
      response('<summary>actual summary</summary>'),
    ])
    const result = await compactConversation({ ...base, model })
    expect(model.requests).toHaveLength(2)
    expect(JSON.stringify(result.summaryMessages)).toContain('actual summary')
  })
})
