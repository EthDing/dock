import { randomUUID } from 'node:crypto'
import { stripVTControlCharacters } from 'node:util'
import { TuiAltScreen } from '@dock/tui'
import { expect, it, vi } from 'vitest'
import { VirtualTerminal } from '../../packages/tui/test/virtual-terminal.js'
import type { AgentUiUpdate, AgentView } from '../../src/agents/types.js'
import { createAssistantMessage, createUserMessage } from '../../src/messages/create-message.js'
import { createSessionId } from '../../src/sessions/ids.js'
import { CommandRegistry } from '../../src/ui/commands.js'
import { InteractionPanel } from '../../src/ui/components/interaction-panel.js'
import { type DockAgentCommands, DockTuiApp } from '../../src/ui/dock-tui-app.js'

it('keeps the selected approval visible even with only one row', () => {
  const panel = new InteractionPanel('Permission', 'long\n'.repeat(40), [
    { label: 'Yes', value: 'yes' },
    { label: 'No', value: 'no' },
  ])
  panel.maxHeight = 1
  panel.handleInput('\x1b[B')
  expect(stripVTControlCharacters(panel.render(30).join('\n'))).toBe('› No')
})

it('copies selected transcript text without interrupting and restores terminal modes on exit', async () => {
  const terminal = new VirtualTerminal(80, 26),
    writes: string[] = []
  const write = terminal.write.bind(terminal)
  terminal.write = (data) => {
    writes.push(data)
    write(data)
  }
  const copy = vi.fn(async (_text: string) => true),
    abort = vi.fn()
  const tui = new TuiAltScreen(terminal, undefined, undefined, { copySelection: copy })
  const app = new DockTuiApp({
    tui,
    controller: {
      abort,
      async close() {},
      async *submit() {},
      messages: [createUserMessage({ content: [{ type: 'text', text: 'COPYME 中文' }] })],
    },
  })
  app.start()
  await terminal.waitForRender()
  const row = terminal.getViewport().findIndex((line) => line.includes('COPYME')) + 1
  const col = (terminal.getViewport()[row - 1]?.indexOf('COPYME') ?? 0) + 1
  expect(row).toBeGreaterThan(0)
  terminal.sendInput(`\x1b[<0;${col};${row}M`)
  terminal.sendInput(`\x1b[<32;${col + 5};${row}M`)
  terminal.sendInput(`\x1b[<0;${col + 5};${row}m`)
  await vi.waitFor(() => expect(copy).toHaveBeenCalled())
  expect(copy.mock.calls.some(([text]) => text.includes('COPYME'))).toBe(true)
  terminal.sendInput('\x03')
  expect(abort).not.toHaveBeenCalled()
  await app.stop()
  const bytes = writes.join('')
  expect(bytes).toContain('\x1b[?1049h')
  expect(bytes).toContain('\x1b[?1049l')
  expect(bytes).toContain('\x1b[?1006l')
  expect(bytes).toContain('\x1b[?25h')
})

it('keeps task drafts and scoped live progress separate from main turns and stale subscriptions', async () => {
  let sessionId = createSessionId()
  const originalSession = sessionId,
    listeners: Array<(event: AgentUiUpdate) => void> = [],
    unsubscribe = vi.fn()
  const agent: AgentView = {
    id: randomUUID(),
    runId: randomUUID(),
    sessionId,
    cwd: '/child',
    modelReference: 'fake:child',
    depth: 1,
    contextMode: 'fresh',
    description: 'Worker',
    status: 'running',
    background: true,
    outputFile: '/tmp/child.jsonl',
  }
  const send = vi.fn(async () => {})
  const agents: DockAgentCommands = {
    async list() {
      return [agent]
    },
    async launch() {
      return agent
    },
    async snapshot() {
      return { agent, messages: [], sequence: 0, runId: agent.runId }
    },
    subscribe(listener) {
      listeners.push(listener)
      return unsubscribe
    },
    send,
    async stop() {
      return agent
    },
    async background() {},
    async close() {},
  }
  const terminal = new VirtualTerminal(100, 28),
    tui = new TuiAltScreen(terminal)
  const app = new DockTuiApp({
    tui,
    agentCommands: agents,
    controller: {
      abort() {},
      async close() {},
      submit() {
        throw new Error('no model call')
      },
      getViewInfo: () => ({
        sessionId,
        cwd: '/main',
        modelReference: 'fake:main',
        permissionMode: 'default',
        contextSummary: 'context',
      }),
    },
    sessionCommands: {
      async clear() {
        sessionId = createSessionId()
      },
      async branch() {},
      async listSessions() {
        return []
      },
      async resume() {},
      async setModel() {},
    },
  })
  app.start()
  await app.submit(`/tasks ${agent.id}`)
  app.screen.options.editor.setText('child draft')
  terminal.sendInput('\x1b')
  expect(app.screen.options.editor.getText()).toBe('')
  await app.submit(`/tasks ${agent.id}`)
  expect(app.screen.options.editor.getText()).toBe('child draft')
  const message = createAssistantMessage({
    role: 'assistant',
    id: 'response',
    stopReason: 'end_turn',
    usage: {},
    content: [{ type: 'text', text: 'live child answer' }],
  })
  const event: AgentUiUpdate = {
    sessionId: originalSession,
    agentId: agent.id,
    runId: agent.runId,
    sequence: 1,
    agent,
    event: { type: 'assistant_message', message },
  }
  listeners[0]?.(event)
  await vi.waitFor(() =>
    expect(stripVTControlCharacters(tui.render(100).join('\n'))).toContain('live child answer'),
  )
  expect(stripVTControlCharacters(tui.render(100).join('\n'))).toContain('/child')
  await app.submit('user followup')
  expect(send).toHaveBeenCalledWith(agent.id, 'user followup')
  await app.submit('/clear')
  expect(unsubscribe).toHaveBeenCalledTimes(1)
  listeners[0]?.(event)
  expect(stripVTControlCharacters(tui.render(100).join('\n'))).not.toContain('live child answer')
  expect(app.transcript.items).toHaveLength(0)
  await app.stop()
  expect(unsubscribe).toHaveBeenCalledTimes(2)
})

it('only completes registered commands and retains their arguments', async () => {
  const registry = new CommandRegistry(),
    run = vi.fn(async () => {})
  registry.register('tasks', 'View tasks', run)
  const suggestions = await registry.autocomplete.getSuggestions(['/ta'], 0, 3, {
    signal: new AbortController().signal,
  })
  expect(suggestions?.items.map((i) => i.value)).toEqual(['tasks'])
  const item = suggestions?.items[0]
  if (!item) throw new Error('missing completion')
  expect(registry.autocomplete.applyCompletion(['/ta id'], 0, 3, item, '/ta').lines).toEqual([
    '/tasks  id',
  ])
  await registry.execute('/tasks send id hello')
  expect(run).toHaveBeenCalledWith('send id hello')
  await expect(registry.execute('/hooks')).rejects.toThrow('Unknown command')
})
