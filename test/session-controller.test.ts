import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionController } from '../src/session-controller.js'
import { FakeModelAdapter } from '../src/model/fake-model.js'
import { createSessionId } from '../src/sessions/ids.js'
import { loadSession, SessionWriter } from '../src/sessions/session-store.js'
import { FileHistory } from '../src/checkpoint/file-history.js'
import type { AgentTool } from '../src/tools/types.js'

describe('SessionController', () => {
  it('passes a headless max-turn limit through without executing the next tool round', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'dock-controller-max-turns-'))
    const cwd = '/work/project'
    const sessionId = createSessionId()
    const writer = await SessionWriter.create({ configDir, cwd, sessionId })
    const fileHistory = new FileHistory({ configDir, cwd, sessionId })
    const execute = vi.fn(async () => ({ content: 'ok' }))
    const tool: AgentTool = {
      name: 'Test',
      description: 'test',
      inputSchema: { type: 'object' },
      isConcurrencySafe: () => false,
      execute,
    }
    const toolResponse = (id: string) => [
      { type: 'message_start' as const, messageId: id },
      {
        type: 'content_block_start' as const,
        index: 0,
        block: { type: 'tool_use' as const, id: `${id}-tool`, name: 'Test' },
      },
      {
        type: 'content_block_delta' as const,
        index: 0,
        delta: { type: 'input_json_delta' as const, partialJson: '{}' },
      },
      { type: 'content_block_stop' as const, index: 0 },
      { type: 'message_delta' as const, stopReason: 'tool_use' as const, usage: {} },
      { type: 'message_stop' as const },
    ]
    const model = new FakeModelAdapter([toolResponse('first'), toolResponse('second')])
    const controller = new SessionController({
      fileHistory,
      model,
      modelId: 'test-model',
      systemPrompt: [],
      tools: [tool],
      writer,
    })

    const iterator = controller.submit('run', { maxTurns: 1 })
    let next = await iterator.next()
    while (!next.done) next = await iterator.next()

    expect(next.value.reason).toBe('max_turns')
    expect(execute).toHaveBeenCalledOnce()
    await controller.close()
  })

  it('persists a complete user and assistant turn', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'dock-controller-'))
    const cwd = '/work/project'
    const sessionId = createSessionId()
    const writer = await SessionWriter.create({ configDir, cwd, sessionId })
    const fileHistory = new FileHistory({
      configDir,
      cwd,
      onSnapshot: (snapshot, isUpdate) => writer.recordFileHistorySnapshot(snapshot, isUpdate),
      sessionId,
    })
    const model = new FakeModelAdapter([
      [
        { type: 'message_start', messageId: 'provider-message' },
        { type: 'content_block_start', index: 0, block: { type: 'text' } },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hello' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', stopReason: 'end_turn', usage: { outputTokens: 1 } },
        { type: 'message_stop' },
      ],
    ])
    const controller = new SessionController({
      fileHistory,
      model,
      modelId: 'test-model',
      systemPrompt: [],
      tools: [],
      writer,
    })

    for await (const _event of controller.submit('hi')) {
      // Drain the streamed turn.
    }
    await controller.close()
    const loaded = await loadSession({ configDir, cwd, sessionId })

    expect(loaded.messages.map(({ type }) => type)).toEqual(['user', 'assistant'])
    expect(loaded.messages[1]).toMatchObject({
      type: 'assistant',
      message: { id: 'provider-message', content: [{ type: 'text', text: 'hello' }] },
    })
    expect(loaded.fileHistorySnapshots).toHaveLength(1)
  })

  it('schedules turn-complete work without blocking the submitted turn and drains on close', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'dock-controller-finalizer-'))
    const cwd = '/work/project'
    const sessionId = createSessionId()
    const writer = await SessionWriter.create({ configDir, cwd, sessionId })
    const fileHistory = new FileHistory({ configDir, cwd, sessionId })
    const model = new FakeModelAdapter([
      [
        { type: 'message_start', messageId: 'provider-message' },
        { type: 'content_block_start', index: 0, block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', stopReason: 'end_turn', usage: {} },
        { type: 'message_stop' },
      ],
    ])
    const turnComplete = { drain: vi.fn(async () => {}), schedule: vi.fn() }
    const controller = new SessionController({
      fileHistory,
      model,
      modelId: 'test-model',
      systemPrompt: [],
      tools: [],
      turnComplete,
      writer,
    })

    for await (const _event of controller.submit('hi')) {
      // Drain the main turn only.
    }
    expect(turnComplete.schedule).toHaveBeenCalledOnce()

    await controller.close()
    expect(turnComplete.drain).toHaveBeenCalledOnce()
  })
})

it('consumes system notifications without a user checkpoint or memory extraction', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'dock-inbox-')),
    cwd = '/work',
    sessionId = createSessionId()
  const writer = await SessionWriter.create({ configDir, cwd, sessionId })
  const fileHistory = new FileHistory({ configDir, cwd, sessionId })
  const snapshot = vi.spyOn(fileHistory, 'makeSnapshot')
  const { createUserMessage } = await import('../src/messages/create-message.js')
  let pending = [
    {
      ...createUserMessage({ content: [{ type: 'text', text: 'child completed' }] }),
      isMeta: true as const,
      agentEventKey: 'child:run',
    },
  ]
  const ack = vi.fn(async (ids: readonly string[]) => {
    pending = pending.filter((m) => !ids.includes(m.uuid))
  })
  const model = new FakeModelAdapter([
    [
      { type: 'message_start', messageId: 'reply' },
      { type: 'content_block_start', index: 0, block: { type: 'text' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'acknowledged' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', stopReason: 'end_turn', usage: {} },
      { type: 'message_stop' },
    ],
  ])
  const turnComplete = { drain: vi.fn(async () => {}), schedule: vi.fn() }
  const controller = new SessionController({
    fileHistory,
    writer,
    model,
    modelId: 'test',
    systemPrompt: [],
    tools: [],
    turnComplete,
    inbox: { peek: async () => pending, ack },
  })
  for await (const _ of controller.processNotifications()) {
  }
  expect(snapshot).not.toHaveBeenCalled()
  expect(turnComplete.schedule).not.toHaveBeenCalled()
  expect(ack).toHaveBeenCalled()
  expect(controller.rewindPoints()).toEqual([])
  await controller.close()
  expect((await loadSession({ configDir, cwd, sessionId })).messages).toHaveLength(2)
})
