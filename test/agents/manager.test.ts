import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SubagentManager } from '../../src/agents/manager.js'
import type { AgentSnapshot } from '../../src/agents/types.js'
import { createSessionId } from '../../src/sessions/ids.js'
import { createUserMessage } from '../../src/messages/create-message.js'
import type { ModelAdapter, ModelRequest, ModelStreamEvent } from '../../src/model/types.js'
import { FileReadState } from '../../src/tools/file-read-state.js'

const response = (text: string): ModelStreamEvent[] => [
  { type: 'message_start', messageId: 'm' },
  { type: 'content_block_start', index: 0, block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 5 } },
  { type: 'message_stop' },
]
function parent(): AgentSnapshot {
  return {
    sessionId: createSessionId(),
    depth: 0,
    contextMode: 'main',
    cwd: '/work',
    modelReference: 'test:model',
    systemPrompt: ['parent'],
    userContext: { AGENTS: 'rules', AUTO_MEMORY: 'index' },
    tools: [],
    messages: [createUserMessage({ content: [{ type: 'text', text: 'parent history' }] })],
  }
}
async function setup(
  model: ModelAdapter,
  options: { backgroundEnabled?: boolean; maxConcurrent?: number; configDir?: string } = {},
) {
  return new SubagentManager({
    configDir: options.configDir ?? (await mkdtemp(join(tmpdir(), 'dock-agents-'))),
    projectCwd: '/work',
    ...options,
    createRuntime: async () => ({
      model,
      modelId: 'model',
      tools: [],
      fileReadState: new FileReadState(),
    }),
  })
}
async function until(predicate: () => boolean) {
  const end = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}
describe('subagent lifecycle', () => {
  it('runs with isolated context and durably emits one completion notification', async () => {
    const requests: ModelRequest[] = []
    const manager = await setup({
      async *stream(request) {
        requests.push(request)
        yield* response('finished')
      },
    })
    const p = parent(),
      agent = await manager.spawn(p, { prompt: 'task', description: 'Task' })
    expect(agent.id).toBeDefined()
    expect((await manager.wait(agent.id)).status).toBe('completed')
    expect(JSON.stringify(requests[0]?.messages)).not.toContain('parent history')
    expect(JSON.stringify(requests[0]?.messages)).not.toContain('index')
    const notifications = await manager.pendingNotifications(p.sessionId)
    expect(notifications).toHaveLength(1)
    expect((await manager.pendingNotifications(p.sessionId))[0]?.uuid).toBe(notifications[0]?.uuid)
    await manager.ackNotifications(
      p.sessionId,
      notifications.map((m) => m.uuid),
    )
    expect(await manager.pendingNotifications(p.sessionId)).toEqual([])
    await manager.close()
  })
  it('delivers a message arriving during a text-only response before declaring completion', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
        release = resolve
      }),
      requests: ModelRequest[] = []
    const manager = await setup({
      async *stream(request) {
        requests.push(request)
        if (requests.length === 1) await gate
        yield* response('done')
      },
    })
    const p = parent(),
      agent = await manager.spawn(p, { prompt: 'task', description: 'Task' })
    await until(() => requests.length === 1)
    await manager.send(p.sessionId, agent.id, 'new direction')
    release()
    await manager.wait(agent.id)
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1]?.messages)).toContain('new direction')
    expect(await manager.pendingNotifications(p.sessionId)).toHaveLength(1)
    await manager.close()
  })
  it('preserves user cancellation and requires an explicit user resume', async () => {
    let calls = 0
    const manager = await setup({
      async *stream(_request, { signal }) {
        calls++
        if (calls === 1)
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
          )
        yield* response('resumed')
      },
    })
    const p = parent(),
      agent = await manager.spawn(p, { prompt: 'task', description: 'Task' })
    await until(() => calls === 1)
    await manager.stop(p.sessionId, agent.id, 'user')
    await expect(manager.send(p.sessionId, agent.id, 'continue')).rejects.toThrow('user')
    await manager.send(p.sessionId, agent.id, 'continue', { fromUser: true })
    expect((await manager.wait(agent.id)).status).toBe('completed')
    expect(calls).toBe(2)
    await manager.close()
  })
  it('reserves concurrent slots before asynchronous setup and checks depth/fork rules', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const manager = await setup(
      {
        async *stream() {
          await gate
          yield* response('done')
        },
      },
      { maxConcurrent: 1 },
    )
    const p = parent(),
      first = manager.spawn(p, { prompt: 'one', description: 'One' })
    const second = manager.spawn(p, { prompt: 'two', description: 'Two' })
    await expect(second).rejects.toThrow('Concurrent')
    await expect(
      manager.spawn({ ...p, depth: 3 }, { prompt: 'deep', description: 'Deep' }),
    ).rejects.toThrow('depth')
    await expect(
      manager.spawn(
        { ...p, contextMode: 'fork', depth: 1 },
        { prompt: 'fork', description: 'Fork', context: 'fork' },
      ),
    ).rejects.toThrow('fork')
    release()
    await manager.wait((await first).id)
    await manager.close()
  })
  it('backgrounds a foreground task without changing identity or retaining parent cancellation', async () => {
    let release!: () => void,
      started = false
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const manager = await setup(
      {
        async *stream() {
          started = true
          await gate
          yield* response('done')
        },
      },
      { backgroundEnabled: false },
    )
    const p = parent(),
      abort = new AbortController()
    const pending = manager.spawn(
      p,
      { prompt: 'work', description: 'Work' },
      { signal: abort.signal },
    )
    await until(() => started)
    await manager.backgroundForeground(p.sessionId)
    const agent = await pending
    abort.abort()
    expect((await manager.list(p.sessionId))[0]?.status).toBe('running')
    release()
    expect((await manager.wait(agent.id)).id).toBe(agent.id)
    await manager.close()
  })

  it('does not report inherited parent text as a failed fork result', async () => {
    const manager = await setup({
      async *stream() {
        yield* []
        throw new Error('API offline')
      },
    })
    const p = parent()
    const inherited = {
      ...p,
      messages: [
        ...p.messages,
        {
          type: 'assistant' as const,
          uuid: crypto.randomUUID() as `${string}-${string}-${string}-${string}-${string}`,
          timestamp: new Date().toISOString(),
          message: {
            role: 'assistant' as const,
            id: 'parent',
            stopReason: 'end_turn' as const,
            usage: {},
            content: [{ type: 'text' as const, text: 'PARENT RESULT' }],
          },
        },
      ],
    }
    const agent = await manager.spawn(inherited, {
      prompt: 'task',
      description: 'Task',
      context: 'fork',
    })
    const result = await manager.wait(agent.id)
    expect(result.status).toBe('failed')
    expect(result.report ?? '').not.toContain('PARENT RESULT')
    await manager.close()
  })
})
it('restarts into recoverable stopped state and retains the same transcript and ID', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'dock-agent-restart-'))
  let started = false
  const first = await setup(
    {
      async *stream(_request, { signal }) {
        started = true
        await new Promise<void>((_, reject) =>
          signal.addEventListener('abort', () => reject(Error('shutdown')), { once: true }),
        )
        yield* response('unreachable')
      },
    },
    { configDir },
  )
  const p = parent(),
    agent = await first.spawn(p, { prompt: 'remember original task', description: 'Task' })
  await until(() => started)
  await first.close()
  const requests: ModelRequest[] = []
  const second = await setup(
    {
      async *stream(r) {
        requests.push(r)
        yield* response('resumed result')
      },
    },
    { configDir },
  )
  expect((await second.list(p.sessionId))[0]).toMatchObject({
    id: agent.id,
    status: 'stopped',
    stoppedBy: 'shutdown',
  })
  await second.send(p.sessionId, agent.id, 'continue')
  expect((await second.wait(agent.id)).status).toBe('completed')
  expect(JSON.stringify(requests[0])).toContain('remember original task')
  const events = await second.pendingNotifications(p.sessionId)
  await second.ackNotifications(
    p.sessionId,
    events.map((m) => m.uuid),
  )
  await second.close()
  const third = await setup(
    {
      async *stream() {
        yield* response('not called')
      },
    },
    { configDir },
  )
  expect(await third.pendingNotifications(p.sessionId)).toEqual([])
  await third.close()
})

it('rebinds live tasks on clear while keeping their output location and excluding other sessions', async () => {
  let release!: () => void,
    started = false
  const gate = new Promise<void>((r) => {
    release = r
  })
  const manager = await setup({
    async *stream() {
      started = true
      await gate
      yield* response('done')
    },
  })
  const p = parent(),
    agent = await manager.spawn(p, { prompt: 'task', description: 'Task' })
  await until(() => started)
  const next = createSessionId()
  await manager.retargetAfterClear(p.sessionId, next)
  release()
  await manager.wait(agent.id)
  expect(await manager.list(p.sessionId)).toEqual([])
  expect((await manager.list(next))[0]?.outputFile).toBe(agent.outputFile)
  expect(await manager.pendingNotifications(p.sessionId)).toEqual([])
  expect(await manager.pendingNotifications(next)).toHaveLength(1)
  await expect(manager.send(p.sessionId, agent.id, 'wrong session')).rejects.toThrow(
    'in this session',
  )
  await manager.close()
})

it('recovers a completed notification whose final enqueue was interrupted', async () => {
  const { readFile, writeFile } = await import('node:fs/promises')
  const configDir = await mkdtemp(join(tmpdir(), 'dock-agent-notify-restart-'))
  const first = await setup(
    {
      async *stream() {
        yield* response('done')
      },
    },
    { configDir },
  )
  const p = parent(),
    agent = await first.spawn(p, { prompt: 'task', description: 'Task' })
  await first.wait(agent.id)
  await first.close()
  const metaPath = agent.outputFile.replace(/\.jsonl$/, '.json')
  const meta = JSON.parse(await readFile(metaPath, 'utf8'))
  delete meta.notifiedRunId
  await writeFile(metaPath, JSON.stringify(meta))
  const indexPath = join(agent.outputFile, '..', 'index.json')
  const index = JSON.parse(await readFile(indexPath, 'utf8'))
  index.pending = []
  await writeFile(indexPath, JSON.stringify(index))
  const second = await setup(
    {
      async *stream() {
        yield* response('never')
      },
    },
    { configDir },
  )
  await second.loadSession(p.sessionId)
  expect(await second.pendingNotifications(p.sessionId)).toHaveLength(1)
  await second.close()
})
it('repairs only a crash-interrupted tool batch before resuming the model', async () => {
  const { readFile, writeFile } = await import('node:fs/promises')
  const { SessionWriter } = await import('../../src/sessions/session-store.js')
  const { createAssistantMessage } = await import('../../src/messages/create-message.js')
  const configDir = await mkdtemp(join(tmpdir(), 'dock-agent-batch-recovery-'))
  const first = await setup(
    {
      async *stream() {
        yield* response('done')
      },
    },
    { configDir },
  )
  const p = parent(),
    agent = await first.spawn(p, { prompt: 'task', description: 'Task' })
  await first.wait(agent.id)
  await first.close()
  const writer = await SessionWriter.open({
    configDir,
    cwd: '/work',
    sessionId: p.sessionId,
    agentId: agent.id,
  })
  await writer.recordTranscript([
    createAssistantMessage({
      role: 'assistant',
      id: 'crashed',
      content: [
        { type: 'tool_use', name: 'Read', id: 'interrupted-read', input: { file_path: '/work/x' } },
      ],
      stopReason: 'tool_use',
      usage: {},
    }),
  ])
  await writer.close()
  const path = agent.outputFile.replace(/\.jsonl$/, '.json'),
    meta = JSON.parse(await readFile(path, 'utf8'))
  meta.status = 'running'
  await writeFile(path, JSON.stringify(meta))
  const requests: ModelRequest[] = []
  const second = await setup(
    {
      async *stream(request) {
        requests.push(request)
        yield* response('recovered')
      },
    },
    { configDir },
  )
  await second.loadSession(p.sessionId)
  await second.send(p.sessionId, agent.id, 'continue')
  await second.wait(agent.id)
  const blocks =
    requests[0]?.messages.filter((m) => m.role === 'user').flatMap((m) => m.content) ?? []
  expect(
    blocks.filter((b) => b.type === 'tool_result' && b.toolUseId === 'interrupted-read'),
  ).toHaveLength(1)
  expect(JSON.stringify(blocks)).toContain('interrupted')
  await second.close()
})
it('drains a task still being registered when shutdown starts', async () => {
  let calls = 0
  const manager = await setup({
    async *stream() {
      calls++
      yield* response('done')
    },
  })
  const p = parent(),
    pending = manager.spawn(p, { prompt: 'task', description: 'Task' })
  await manager.close()
  const agent = await pending
  expect(agent.status).toBe('stopped')
  expect(calls).toBe(0)
})
