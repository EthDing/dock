import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TuiAltScreen } from '@dock/tui'
import { expect, it, vi } from 'vitest'
import { VirtualTerminal } from '../../packages/tui/test/virtual-terminal.js'
import { FileHistory } from '../../src/checkpoint/file-history.js'
import { FakeModelAdapter } from '../../src/model/fake-model.js'
import type { ModelStreamEvent } from '../../src/model/types.js'
import { SessionController } from '../../src/session-controller.js'
import { createSessionId } from '../../src/sessions/ids.js'
import { loadSession, SessionWriter } from '../../src/sessions/session-store.js'
import { DockTuiApp } from '../../src/ui/dock-tui-app.js'
import { RuntimeController } from '../../src/ui/runtime-controller.js'

it('renders each keyboard submission once through the real controller and keeps intentional repeats', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dock-input-regression-'))
  const location = { cwd, configDir: join(cwd, 'config'), sessionId: createSessionId() }
  const writer = await SessionWriter.create(location)
  const prompts = ['你好', '你是什么模型', '你好']
  const responses: ModelStreamEvent[][] = prompts.map((_, i) => [
    { type: 'message_start', messageId: `reply-${i}` },
    { type: 'content_block_start', index: 0, block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `ANSWER-${i}` } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', stopReason: 'end_turn', usage: {} },
    { type: 'message_stop' },
  ])
  const model = new FakeModelAdapter(responses)
  const controller = new SessionController({
    writer,
    model,
    modelId: 'fake',
    systemPrompt: ['test'],
    tools: [],
    fileHistory: new FileHistory({
      ...location,
      onSnapshot: (snapshot, update) => writer.recordFileHistorySnapshot(snapshot, update),
    }),
    getAgentIdentity: () => ({
      sessionId: location.sessionId,
      cwd,
      modelReference: 'test:fake',
      depth: 0,
      contextMode: 'main',
    }),
  })
  const terminal = new VirtualTerminal(100, 40),
    tui = new TuiAltScreen(terminal)
  const app = new DockTuiApp({ tui, controller: new RuntimeController(controller) })
  const displayedUsers = () =>
    app.transcript.items.filter((item) => item.kind === 'message' && item.message.type === 'user')
  try {
    app.start()
    for (const [index, prompt] of prompts.entries()) {
      terminal.sendInput(prompt)
      terminal.sendInput('\r')
      await vi.waitFor(() => {
        expect(model.requests).toHaveLength(index + 1)
        expect(app.transcript.status).toBe('ready')
        expect(controller.messages).toHaveLength((index + 1) * 2)
      })
      await terminal.waitForRender()
      expect(displayedUsers()).toHaveLength(index + 1)
      const screen = terminal.getViewport().join('\n')
      expect(screen.split('你好').length - 1).toBe(
        prompts.slice(0, index + 1).filter((text) => text === '你好').length,
      )
      expect(screen.split('你是什么模型').length - 1).toBe(index > 0 ? 1 : 0)
      expect(
        app.transcript.items.map((item) => (item.kind === 'message' ? item.message.uuid : '')),
      ).toEqual(controller.displayMessages.map((message) => message.uuid))
    }
  } finally {
    await app.stop()
  }
  const loaded = await loadSession(location)
  expect(loaded.messages).toHaveLength(6)
  expect(loaded.displayMessages).toEqual(controller.displayMessages)
  expect(model.requests[2]?.messages.filter((message) => message.role === 'user')).toHaveLength(3)
})
