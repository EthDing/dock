import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createSubagentRuntime, type AgentPolicy } from '../../src/agents/runtime.js'
import { SubagentManager } from '../../src/agents/manager.js'
import type { AgentMetadata, AgentSnapshot } from '../../src/agents/types.js'
import { createSessionId } from '../../src/sessions/ids.js'
import { getSessionPath, loadSession } from '../../src/sessions/session-store.js'
import { createUserMessage } from '../../src/messages/create-message.js'
import { MemoryManager } from '../../src/memory/memory-manager.js'
import { DockSandbox, createSandboxRuntimeConfig } from '../../src/sandbox/dock-sandbox.js'
import { PermissionModeState } from '../../src/permissions/permission-mode-state.js'
import { PermissionBroker } from '../../src/permissions/permission-broker.js'
import { SessionPermissionState } from '../../src/permissions/session-permission-state.js'
import type { ModelAdapter, ModelStreamEvent } from '../../src/model/types.js'
const response = (text: string): ModelStreamEvent[] => [
  { type: 'message_start', messageId: 'r' },
  { type: 'content_block_start', index: 0, block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', stopReason: 'end_turn', usage: {} },
  { type: 'message_stop' },
]
async function setup(
  model: ModelAdapter = {
    async *stream() {
      yield* response('done')
    },
  },
  contextWindow = 200000,
) {
  const cwd = await mkdtemp(join(tmpdir(), 'dock-agent-runtime-')),
    configDir = join(cwd, 'config'),
    sessionId = createSessionId()
  const memory = await MemoryManager.create({
    configDir,
    homeDir: cwd,
    projectRoot: cwd,
    settings: { autoMemoryEnabled: false },
  })
  const sandbox = new DockSandbox({
    settings: { enabled: false },
    config: createSandboxRuntimeConfig({ cwd, homeDir: cwd, settings: {} }),
  })
  const policy: AgentPolicy = {
    rules: { allow: [], ask: [], deny: [] },
    sessionPermissions: new SessionPermissionState(),
  }
  const broker = new PermissionBroker(),
    mode = new PermissionModeState('default')
  const resolveModel = vi.fn(async (_reference: string) => ({
    model,
    modelId: 'model',
    provider: { contextWindow, maxOutputTokens: 64 },
  }))
  const options = {
    resolveModel,
    loadUserContext: async () => ({ AGENTS: 'current rules', AUTO_MEMORY: 'not for fresh' }),
    policyFor: () => policy,
    permissionMode: mode,
    permissionBroker: broker,
    sandbox,
    memory,
    homeDir: cwd,
    persistApproval: vi.fn(async () => {}),
  }
  const manager = new SubagentManager({
    configDir,
    projectCwd: cwd,
    createRuntime: (metadata, parent) =>
      createSubagentRuntime({
        ...options,
        metadata,
        parent,
        manager,
        transcriptPath: getSessionPath({
          configDir,
          cwd,
          sessionId: metadata.storageSessionId,
          agentId: metadata.id,
        }),
      }),
  })
  const parent: AgentSnapshot = {
    sessionId,
    depth: 0,
    contextMode: 'main',
    cwd,
    modelReference: 'test:model',
    systemPrompt: ['main'],
    userContext: { AUTO_MEMORY: 'parent index' },
    tools: [],
    messages: [],
  }
  const metadata: AgentMetadata = {
    version: 1,
    id: randomUUID(),
    sessionId,
    storageSessionId: sessionId,
    depth: 1,
    contextMode: 'fresh',
    description: 'child',
    modelReference: 'test:other',
    cwd,
    systemPrompt: ['child'],
    status: 'starting',
    background: true,
    runId: randomUUID(),
    pid: process.pid,
    pending: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  const runtime = await createSubagentRuntime({
    ...options,
    metadata,
    manager,
    transcriptPath: 'unused',
  })
  return {
    cwd,
    configDir,
    sessionId,
    manager,
    parent,
    metadata,
    runtime,
    policy,
    broker,
    mode,
    options,
    resolveModel,
  }
}
it('loads fresh project context without memory and resolves the selected model', async () => {
  const s = await setup()
  expect(s.metadata.userContext).toEqual({ AGENTS: 'current rules' })
  expect(s.resolveModel).toHaveBeenCalledWith('test:other')
  const other = await createSubagentRuntime({
    ...s.options,
    metadata: { ...s.metadata, id: randomUUID() },
    manager: s.manager,
    transcriptPath: 'unused',
  })
  expect(other.fileReadState).not.toBe(s.runtime.fileReadState)
  await s.manager.close()
})
it('shares session grants across child runtimes but keeps explicit ask and deny authoritative', async () => {
  const s = await setup(),
    handler = vi.fn(async () => ({ behavior: 'allow_session' as const }))
  s.broker.setHandler(handler)
  const other = await createSubagentRuntime({
    ...s.options,
    metadata: { ...s.metadata, id: randomUUID() },
    manager: s.manager,
    transcriptPath: 'unused',
  })
  const first = s.runtime.tools.find((t) => t.name === 'Write'),
    second = other.tools.find((t) => t.name === 'Write')
  if (!first || !second || !s.runtime.canUseTool || !other.canUseTool) throw Error('missing tools')
  const input = { file_path: join(s.cwd, 'file'), content: 'new' },
    execution = {
      signal: new AbortController().signal,
      parentMessageUuid: randomUUID(),
      toolUseId: 'write',
    }
  expect((await s.runtime.canUseTool(first, input, execution)).behavior).toBe('allow')
  expect((await other.canUseTool(second, input, execution)).behavior).toBe('allow')
  expect(handler).toHaveBeenCalledTimes(1)
  expect(handler.mock.calls[0]).toBeDefined()
  s.policy.rules.ask = ['Write']
  await s.runtime.canUseTool(first, input, execution)
  await other.canUseTool(second, input, execution)
  expect(handler).toHaveBeenCalledTimes(3)
  s.policy.rules.deny = ['Write']
  expect((await other.canUseTool(second, input, execution)).behavior).toBe('deny')
  expect(handler).toHaveBeenCalledTimes(3)
  await s.manager.close()
})
it('keeps inherited fork schemas executable through central denial when rules change', async () => {
  const s = await setup()
  s.policy.rules.deny = ['Read']
  const fork = await createSubagentRuntime({
    ...s.options,
    metadata: { ...s.metadata, contextMode: 'fork' },
    manager: s.manager,
    transcriptPath: 'unused',
  })
  const read = fork.tools.find((t) => t.name === 'Read')
  if (!read || !fork.canUseTool) throw Error('fork lost its inherited tool implementation')
  expect(
    (
      await fork.canUseTool(
        read,
        { file_path: join(s.cwd, 'x') },
        { signal: new AbortController().signal, parentMessageUuid: randomUUID(), toolUseId: 'r' },
      )
    ).behavior,
  ).toBe('deny')
  await s.manager.close()
})
it('compacts only the child transcript and never runs time-based clearing or extraction', async () => {
  let summaries = 0,
    normal = 0
  const s = await setup(
    {
      async *stream(request) {
        if (JSON.stringify(request.messages.at(-1)).includes('Primary Request and Intent')) {
          summaries++
          yield* response('<summary>Continue the delegated task.</summary>')
        } else {
          normal++
          yield* response('child complete')
        }
      },
    },
    16000,
  )
  const history = [createUserMessage({ content: [{ type: 'text', text: 'x'.repeat(90000) }] })]
  const before = JSON.stringify(history)
  const child = await s.manager.spawn(
    { ...s.parent, messages: history, tools: s.runtime.tools },
    { prompt: 'task', description: 'compact task', context: 'fork' },
  )
  const result = await s.manager.wait(child.id)
  expect(result.status).toBe('completed')
  expect(summaries).toBe(1)
  expect(normal).toBe(1)
  const saved = await loadSession({
    configDir: s.configDir,
    cwd: s.cwd,
    sessionId: s.sessionId,
    agentId: child.id,
  })
  expect(saved.records.some((r) => r.type === 'compact_boundary')).toBe(true)
  expect(
    saved.records.some((r) => r.type === 'tool_result_clear' || r.type === 'file-history-snapshot'),
  ).toBe(false)
  expect(JSON.stringify(history)).toBe(before)
  await s.manager.close()
})
