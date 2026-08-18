import { TuiAltScreen } from '@dock/tui'
import { expect, it, vi } from 'vitest'
import { VirtualTerminal } from '../../packages/tui/test/virtual-terminal.js'
import { createUserMessage } from '../../src/messages/create-message.js'
import { DockTuiApp, type DockUiController } from '../../src/ui/dock-tui-app.js'

it('keeps the composer fixed while scrolling and preserves manual scroll across new output', async () => {
  const terminal = new VirtualTerminal(90, 26),
    tui = new TuiAltScreen(terminal)
  const controller: DockUiController = {
    abort: vi.fn(),
    close: async () => {},
    messages: Array.from({ length: 40 }, (_, i) =>
      createUserMessage({ content: [{ type: 'text', text: `history-${i}` }] }),
    ),
    async *submit() {
      yield { type: 'turn_end', result: { reason: 'completed' } }
    },
  }
  const app = new DockTuiApp({ controller, tui })
  app.start()
  await terminal.waitForRender()
  expect(terminal.getViewport().join('\n')).toContain('default')
  terminal.sendInput('\x1b[5~')
  await terminal.waitForRender()
  expect(terminal.getViewport().join('\n')).toContain('default')
  expect(tui.isFollowingOutput).toBe(false)
  const top = tui.viewportTop
  app.transcript.addMessage(
    createUserMessage({ content: [{ type: 'text', text: 'new output must not steal scroll' }] }),
  )
  tui.requestRender()
  await terminal.waitForRender()
  expect(tui.viewportTop).toBe(top)
  expect(terminal.getViewport().join('\n')).not.toContain('new output must not steal scroll')
  terminal.sendInput('\x1b[1;5H')
  await terminal.waitForRender()
  expect(tui.viewportTop).toBe(0)
  terminal.sendInput('\x1b[1;5F')
  await terminal.waitForRender()
  expect(tui.isFollowingOutput).toBe(true)
  terminal.resize(38, 15)
  await terminal.waitForRender()
  expect(terminal.getViewport().join('\n')).toContain('default')
  await app.stop()
})
it('shows model errors and cancels search without aborting a main turn', async () => {
  const terminal = new VirtualTerminal(80, 24),
    tui = new TuiAltScreen(terminal),
    abort = vi.fn()
  const app = new DockTuiApp({
    tui,
    controller: {
      abort,
      close: async () => {},
      async *submit() {
        yield { type: 'turn_end', result: { reason: 'model_error', error: 'API offline' } }
      },
    },
  })
  app.start()
  await app.submit('hello')
  await terminal.waitForRender()
  expect(terminal.getViewport().join('\n')).toContain('API offline')
  await app.submit('/search')
  await terminal.waitForRender()
  terminal.sendInput('\x1b')
  await terminal.waitForRender()
  expect(abort).not.toHaveBeenCalled()
  await app.stop()
})
it('keeps the editing cursor visible in a very short terminal and during multiline paste', async () => {
  const terminal = new VirtualTerminal(32, 6),
    tui = new TuiAltScreen(terminal)
  const app = new DockTuiApp({
    tui,
    controller: { abort() {}, async close() {}, async *submit() {} },
  })
  app.start()
  terminal.sendInput('\x1b[200~第一行\nsecond\n第三行\nEND中文\x1b[201~')
  await terminal.waitForRender()
  expect(terminal.getViewport().join('\n')).toContain('END中文')
  expect(terminal.getCursorPosition().y).toBeLessThan(6)
  for (const rows of [10, 4, 12, 6]) {
    terminal.resize(24, rows)
    await terminal.waitForRender()
    expect(terminal.getViewport().join('\n')).toContain('END中文')
    expect(terminal.getCursorPosition().y).toBeLessThan(rows)
  }
  await app.stop()
})
