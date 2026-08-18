import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@dock/tui'
import * as modelFactory from '../../src/model/create-model-adapter.js'
import type { ModelAdapter, ModelRequest, ModelStreamEvent } from '../../src/model/types.js'
import { saveProviderCredential } from '../../src/config/credentials.js'
import { startDock } from '../../src/start-dock.js'
import { getProjectSessionsDirectory, loadSession } from '../../src/sessions/session-store.js'
import { asSessionId } from '../../src/sessions/ids.js'

class TerminalStub implements Terminal {
  columns = 100
  rows = 30
  kittyProtocolActive = false
  output = ''
  input: ((data: string) => void) | undefined
  start(input: (data: string) => void) {
    this.input = input
  }
  stop() {}
  async drainInput() {}
  write(data: string) {
    this.output += data
  }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  send(text: string) {
    this.input?.(text)
    this.input?.('\r')
  }
}
const answer = (text: string): ModelStreamEvent[] => [
  { type: 'message_start', messageId: 'm' },
  { type: 'content_block_start', index: 0, block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', stopReason: 'end_turn', usage: {} },
  { type: 'message_stop' },
]
async function until(predicate: () => boolean) {
  const end = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > end) throw Error('timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}
describe('subagents through real startup and simulated terminal', () => {
  it('creates a fork, wakes the idle parent without a checkpoint, and supports /tasks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-subagent-start-')),
      cwd = join(root, 'repo'),
      homeDir = join(root, 'home'),
      configDir = join(homeDir, '.dock')
    await mkdir(join(cwd, '.git'), { recursive: true })
    await mkdir(configDir, { recursive: true })
    await writeFile(
      join(configDir, 'settings.json'),
      JSON.stringify({
        model: 'test:model',
        providers: { test: { protocol: 'openai-responses', apiKeyEnv: 'TEST_KEY' } },
        autoMemoryEnabled: false,
      }),
    )
    const requests: ModelRequest[] = []
    const model: ModelAdapter = {
      async *stream(request) {
        requests.push(request)
        const tail = JSON.stringify(request.messages.at(-1))
        yield* answer(
          tail.includes('task-notification')
            ? 'PARENT-NOTICED'
            : tail.includes('child job')
              ? 'CHILD-DONE'
              : 'HELLO',
        )
      },
    }
    await saveProviderCredential({ homeDir, providerName: 'test', apiKey: 'test-only' })
    const spy = vi
      .spyOn(modelFactory, 'createModelAdapter')
      .mockImplementation((_provider, _environment, key) => {
        if (key !== 'test-only') throw Error('Stored credential missing during model switch')
        return model
      })
    const terminal = new TerminalStub()
    const running = startDock({
      args: [],
      cwd,
      homeDir,
      environment: {},
      terminal,
      workspaceTrustPrompter: async () => true,
    })
    try {
      await until(() => !!terminal.input)
      terminal.send('hello')
      await until(() => terminal.output.includes('HELLO'))
      terminal.send('/subtask child job')
      await until(() => terminal.output.includes('PARENT-NOTICED'))
      terminal.send('/tasks')
      await until(() => terminal.output.includes('completed'))
      const beforeSwitch = spy.mock.calls.length
      terminal.send('/model test:other')
      await until(() => spy.mock.calls.length > beforeSwitch)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(terminal.output).not.toContain('Stored credential missing')
      terminal.send('/exit')
      await running
      expect(requests.some((r) => r.tools?.some((t) => t.name === 'Agent'))).toBe(true)
      const sessions = await readdir(getProjectSessionsDirectory({ configDir, cwd }))
      const savedName = sessions.find((n) => n.endsWith('.jsonl'))
      if (!savedName) throw new Error('Missing session transcript')
      const id = asSessionId(savedName.slice(0, -6))
      const saved = await loadSession({ configDir, cwd, sessionId: id })
      expect(saved.fileHistorySnapshots).toHaveLength(1)
      expect(saved.messages.some((m) => m.type === 'user' && m.agentEventKey && m.isMeta)).toBe(
        true,
      )
    } finally {
      terminal.input?.('\u0003')
      await running
      spy.mockRestore()
    }
  })
})
it('delegates through Agent, applies child edits without a parent checkpoint, and returns a foreground report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dock-subagent-tools-')),
    cwd = join(root, 'repo'),
    homeDir = join(root, 'home'),
    configDir = join(homeDir, '.dock')
  await mkdir(join(cwd, '.git'), { recursive: true })
  await mkdir(configDir, { recursive: true })
  await writeFile(
    join(configDir, 'settings.json'),
    JSON.stringify({
      model: 'test:model',
      providers: { test: { protocol: 'openai-responses', apiKeyEnv: 'TEST_KEY' } },
      autoMemoryEnabled: false,
      subagents: { backgroundEnabled: false },
      permissions: { defaultMode: 'acceptEdits' },
    }),
  )
  const target = join(cwd, 'child.txt')
  const call = (name: string, input: Record<string, unknown>): ModelStreamEvent[] => [
    { type: 'message_start', messageId: name },
    { type: 'content_block_start', index: 0, block: { type: 'tool_use', id: name, name } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partialJson: JSON.stringify(input) },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', stopReason: 'tool_use', usage: {} },
    { type: 'message_stop' },
  ]
  let mainCalls = 0,
    childCalls = 0
  const model: ModelAdapter = {
    async *stream(request) {
      if (request.systemPrompt.some((p) => p.startsWith('You are an agent for Dock'))) {
        childCalls++
        if (childCalls === 1) yield* call('Write', { file_path: target, content: 'child edit' })
        else yield* answer('CHILD-REPORT')
      } else {
        mainCalls++
        if (mainCalls === 1)
          yield* call('Agent', {
            prompt: 'Write the delegated file',
            description: 'Write child file',
          })
        else yield* answer('FOREGROUND-DONE')
      }
    },
  }
  const spy = vi.spyOn(modelFactory, 'createModelAdapter').mockReturnValue(model),
    terminal = new TerminalStub()
  const running = startDock({
    args: [],
    cwd,
    homeDir,
    environment: { TEST_KEY: 'test-only' },
    terminal,
    workspaceTrustPrompter: async () => true,
  })
  try {
    await until(() => !!terminal.input)
    terminal.send('delegate')
    await until(() => terminal.output.includes('FOREGROUND-DONE'))
    await until(
      () => terminal.output.lastIndexOf('ready') > terminal.output.lastIndexOf('FOREGROUND-DONE'),
    )
    expect(await readFile(target, 'utf8')).toBe('child edit')
    terminal.send('/exit')
    await running
    const names = await readdir(getProjectSessionsDirectory({ configDir, cwd })),
      name = names.find((n) => n.endsWith('.jsonl'))
    if (!name) throw Error('missing transcript')
    const saved = await loadSession({ configDir, cwd, sessionId: asSessionId(name.slice(0, -6)) })
    expect(saved.fileHistorySnapshots).toHaveLength(1)
    expect(saved.fileHistorySnapshots[0]?.trackedFileBackups ?? {}).toEqual({})
    expect(JSON.stringify(saved.messages)).toContain('CHILD-REPORT')
    expect(mainCalls).toBe(2)
    expect(childCalls).toBe(2)
  } finally {
    terminal.input?.('\u0003')
    await running
    spy.mockRestore()
  }
})
