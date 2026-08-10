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
  options: { backgroundEnabled?: boolean; maxConcurrent?: number } = {},
) {
  return new SubagentManager({
    configDir: await mkdtemp(join(tmpdir(), 'dock-agents-')),
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
