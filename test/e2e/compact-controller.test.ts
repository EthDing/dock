import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ContextManager } from '../../src/context/context-manager.js'
import { compactConversation } from '../../src/context/compaction.js'
import { createAssistantMessage, createUserMessage } from '../../src/messages/create-message.js'
import { FakeModelAdapter } from '../../src/model/fake-model.js'
import type { ModelAdapter, ModelStreamEvent } from '../../src/model/types.js'
import { SessionController } from '../../src/session-controller.js'
import { SessionWriter, loadSession } from '../../src/sessions/session-store.js'
import { createSessionId } from '../../src/sessions/ids.js'
import { FileHistory } from '../../src/checkpoint/file-history.js'

const response = (text: string): ModelStreamEvent[] => [
  { type: 'message_start', messageId: 'summary' },
  { type: 'content_block_start', index: 0, block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', stopReason: 'end_turn', usage: {} },
  { type: 'message_stop' },
]
async function setup() {
  const location = {
    configDir: await mkdtemp(join(tmpdir(), 'dock-compact-controller-')),
    cwd: '/work/test',
    sessionId: createSessionId(),
  }
  const writer = await SessionWriter.create(location)
  const fileHistory = new FileHistory(location)
  return { location, writer, fileHistory }
}
describe('two-stage controller compaction', () => {
  it('persists clearing before continuing and avoids a summary when clearing is sufficient', async () => {
    const { location, writer, fileHistory } = await setup()
    const history = Array.from({ length: 6 }, (_, i) => [
      createAssistantMessage(
        {
          id: String(i),
          role: 'assistant',
          stopReason: 'tool_use',
          usage: {},
          content: [{ type: 'tool_use', id: String(i), name: 'Read', input: {} }],
        },
        { now: () => new Date(Date.now() - 4_000_000) },
      ),
      createUserMessage({
        content: [
          {
            type: 'tool_result',
            toolUseId: String(i),
            content: i === 0 ? 'X'.repeat(200_000) : 'ok',
          },
        ],
      }),
    ]).flat()
    await writer.recordTranscript(history)
    const summarize = vi.fn(async () => {
      throw new Error('Must not summarize')
    })
    const contextManager = new ContextManager({
      contextWindow: 50_000,
      maxOutputTokens: 8192,
      summarize,
    })
    const model = new FakeModelAdapter([response('continued')])
    const controller = new SessionController({
      fileHistory,
      writer,
      model,
      modelId: 'test',
      systemPrompt: [],
      tools: [],
      initialMessages: history,
      contextManager,
    })
    for await (const _ of controller.submit('next')) {
      /* consume */
    }
    expect(summarize).not.toHaveBeenCalled()
    expect(JSON.stringify(model.requests[0]?.messages)).not.toContain('X'.repeat(100))
    await controller.close()
    const loaded = await loadSession(location)
    expect(loaded.records.some((r) => r.type === 'tool_result_clear')).toBe(true)
    expect(loaded.messages).toEqual(controller.messages)
  })
  it('runs automatic compaction before the main request and restores it after restart', async () => {
    const { location, writer, fileHistory } = await setup()
    const model = new FakeModelAdapter([
      response('<summary>condensed work</summary>'),
      response('continued'),
    ])
    const contextManager = new ContextManager({
      contextWindow: 25_000,
      maxOutputTokens: 8192,
      summarize: (input) => compactConversation({ ...input, model }),
    })
    const controller = new SessionController({
      fileHistory,
      writer,
      model,
      modelId: 'test',
      systemPrompt: ['fixed'],
      tools: [],
      contextManager,
    })
    const events = []
    for await (const event of controller.submit('X'.repeat(20_000))) events.push(event)
    expect(events.map((e) => e.type)).toContain('compact')
    expect(model.requests).toHaveLength(2)
    expect(JSON.stringify(model.requests[1]?.messages)).not.toContain('X'.repeat(100))
    await controller.close()
    expect((await loadSession(location)).messages).toEqual(controller.messages)
  })
  it('does not publish new history or restored state if persistence fails', async () => {
    const { location, writer, fileHistory } = await setup()
    const initial = [createUserMessage({ content: [{ type: 'text', text: 'old' }] })]
    await writer.recordTranscript(initial)
    const model = new FakeModelAdapter([response('summary')])
    const commit = vi.fn()
    const contextManager = new ContextManager({
      contextWindow: 200_000,
      maxOutputTokens: 8192,
      summarize: (input) => compactConversation({ ...input, model }),
      prepareRestoration: async () => ({ attachments: [], commit }),
    })
    const controller = new SessionController({
      fileHistory,
      writer,
      model,
      modelId: 'test',
      systemPrompt: [],
      tools: [],
      contextManager,
      initialMessages: initial,
    })
    vi.spyOn(writer, 'recordCompaction').mockRejectedValueOnce(new Error('disk full'))
    await expect(controller.compact()).rejects.toThrow('disk full')
    expect(controller.messages).toEqual(initial)
    expect(commit).not.toHaveBeenCalled()
    await controller.close()
    expect((await loadSession(location)).messages).toEqual(initial)
  })
  it('close waits for an interrupted compaction before releasing its writer', async () => {
    const { writer, fileHistory } = await setup()
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    let settled = false
    const model: ModelAdapter = {
      async *stream(_request, { signal }) {
        started()
        await new Promise<void>((_, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              setTimeout(() => reject(new Error('aborted')), 25)
            },
            { once: true },
          ),
        )
        yield* []
      },
    }
    const contextManager = new ContextManager({
      contextWindow: 200_000,
      maxOutputTokens: 8192,
      summarize: (input) => compactConversation({ ...input, model }),
    })
    const controller = new SessionController({
      fileHistory,
      writer,
      model,
      modelId: 'test',
      systemPrompt: [],
      tools: [],
      contextManager,
      initialMessages: [createUserMessage({ content: [] })],
    })
    const pending = controller.compact().catch(() => {
      settled = true
    })
    await startedPromise
    await controller.close()
    expect(settled).toBe(true)
    await pending
  })
})
