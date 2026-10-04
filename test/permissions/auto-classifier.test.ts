import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutoClassifier, classifierTranscript } from '../../src/permissions/auto-classifier.js'
import { FakeModelAdapter } from '../../src/model/fake-model.js'
import { createAssistantMessage, createUserMessage } from '../../src/messages/create-message.js'
import type { ModelAdapter } from '../../src/model/types.js'
import { execution, response, review } from './auto-fixtures.js'

const classifier = (model: ModelAdapter, timeoutMs = 1000) =>
  new AutoClassifier({
    repository: '/work',
    resolveModel: async () => ({ model, modelId: 'test:model' }),
    timeoutMs,
  })
afterEach(() => vi.useRealTimers())
describe('auto classifier', () => {
  it('allows after one fast call without a reasoning pass', async () => {
    const model = new FakeModelAdapter([response('ALLOW')])
    await expect(
      classifier(model).classify('Bash', { command: 'npm test' }, execution()),
    ).resolves.toEqual({ behavior: 'allow' })
    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]?.tools).toEqual([])
  })
  it.each(['ALLOW', 'BLOCK'])(
    're-evaluates a fast block and accepts the second %s decision',
    async (decision) => {
      const model = new FakeModelAdapter([response('BLOCK'), response(review(decision))])
      expect(
        (await classifier(model).classify('Bash', { command: 'npm test' }, execution())).behavior,
      ).toBe(decision === 'ALLOW' ? 'allow' : 'deny')
      expect(model.requests).toHaveLength(2)
      expect(model.requests[0]?.systemPrompt).toEqual(model.requests[1]?.systemPrompt)
      expect(model.requests[0]?.messages[0]).toEqual(model.requests[1]?.messages[0])
      expect(model.requests[0]?.messages[1]).not.toEqual(model.requests[1]?.messages[1])
      expect(model.requests.map((r) => r.cachePrefixMessageCount)).toEqual([1, 1])
    },
  )
  it('sends only real user text and executable tool inputs, excluding synthetic context and results', async () => {
    const messages = [
      createUserMessage({ content: [{ type: 'text', text: 'Run the tests' }] }),
      createUserMessage({ content: [{ type: 'text', text: 'META-POISON' }] }, { isMeta: true }),
      createUserMessage(
        { content: [{ type: 'text', text: 'SUMMARY-POISON' }] },
        { isCompactSummary: true },
      ),
      createAssistantMessage({
        role: 'assistant',
        id: 'a',
        usage: {},
        stopReason: 'tool_use',
        content: [
          { type: 'text', text: 'PROSE-POISON' },
          { type: 'thinking', thinking: 'THINKING-POISON' },
          {
            type: 'tool_use',
            id: 'b',
            name: 'Bash',
            input: { command: 'npm test', description: 'DESCRIPTION-POISON' },
          },
          {
            type: 'tool_use',
            id: 'a',
            name: 'Agent',
            input: { prompt: 'Check the tests', description: 'AGENT-DESCRIPTION-POISON' },
          },
        ],
      }),
      createUserMessage({
        content: [{ type: 'tool_result', toolUseId: 'b', content: 'RESULT-POISON' }],
      }),
    ]
    expect(classifierTranscript(messages)).toEqual([
      { type: 'user', text: 'Run the tests' },
      { type: 'tool_call', name: 'Bash', input: { command: 'npm test' } },
      { type: 'tool_call', name: 'Agent', input: { prompt: 'Check the tests' } },
    ])
    const model = new FakeModelAdapter([response('ALLOW')])
    const monitor = new AutoClassifier({
      repository: '/work',
      resolveModel: async () => ({ model, modelId: 'test' }),
      getMessages: async () => messages,
    })
    await monitor.classify(
      'Bash',
      { command: 'npm test', description: 'PENDING-POISON' },
      execution(),
    )
    expect(JSON.stringify(model.requests)).not.toContain('POISON')
  })
  it.each(['', 'yes', 'ALLOW because safe', '{"decision":"ALLOW"}', 'BLOCK\nALLOW'])(
    'fails closed on malformed fast output %j without a second pass',
    async (text) => {
      const model = new FakeModelAdapter([response(text)])
      expect((await classifier(model).classify('Bash', {}, execution())).behavior).toBe('deny')
      expect(model.requests).toHaveLength(1)
    },
  )
  it.each([
    'not-json',
    '{}',
    '{"decision":"ALLOW","reason":"ok"}',
    review('UNKNOWN'),
    '{"reasoning":"ok","decision":"ALLOW","reason":"","extra":true}',
  ])('fails closed on malformed review %j', async (text) => {
    const model = new FakeModelAdapter([response('BLOCK'), response(text)])
    expect((await classifier(model).classify('Bash', {}, execution())).behavior).toBe('deny')
  })
  it('fails closed on provider errors without exposing the error', async () => {
    const monitor = new AutoClassifier({
      repository: '/work',
      resolveModel: async () => {
        throw new Error('private-provider-detail')
      },
    })
    const result = await monitor.classify('Bash', {}, execution())
    expect(result.behavior).toBe('deny')
    expect(JSON.stringify(result)).not.toContain('private-provider-detail')
  })
  it('fails closed if the second request errors', async () => {
    expect(
      (
        await classifier(new FakeModelAdapter([response('BLOCK')])).classify(
          'Bash',
          {},
          execution(),
        )
      ).behavior,
    ).toBe('deny')
  })
  it('fails closed on truncated responses even if text says ALLOW', async () => {
    const events = response('ALLOW').map((event) =>
      event.type === 'message_delta' ? { ...event, stopReason: 'max_tokens' as const } : event,
    )
    expect(
      (await classifier(new FakeModelAdapter([events])).classify('Bash', {}, execution())).behavior,
    ).toBe('deny')
  })
  it('bounds even a hung resolver and aborts a hung model that ignores cancellation', async () => {
    vi.useFakeTimers()
    for (const resolveModel of [
      () => new Promise<never>(() => {}),
      async () => ({
        modelId: 'test',
        model: {
          async *stream() {
            await new Promise(() => {})
            yield* response('ALLOW')
          },
        },
      }),
    ]) {
      const monitor = new AutoClassifier({ repository: '/work', resolveModel, timeoutMs: 50 })
      const pending = monitor.classify('Bash', {}, execution())
      await vi.advanceTimersByTimeAsync(51)
      expect((await pending).behavior).toBe('deny')
    }
  })
  it('fails closed on cancellation before or during a request', async () => {
    for (const before of [true, false]) {
      const abort = new AbortController()
      if (before) abort.abort()
      const pending = classifier({
        async *stream() {
          await new Promise(() => {})
          yield* response('ALLOW')
        },
      }).classify('Bash', {}, { ...execution(), signal: abort.signal })
      abort.abort()
      expect((await pending).behavior).toBe('deny')
    }
  })
})
