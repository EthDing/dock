import { randomUUID } from 'node:crypto'
import { stripVTControlCharacters } from 'node:util'
import { describe, expect, it } from 'vitest'
import { TuiAltScreen } from '@dock/tui'
import { VirtualTerminal } from '../../packages/tui/test/virtual-terminal.js'
import { UserInteractionBroker } from '../../src/interaction/user-interaction-broker.js'
import { asSessionId } from '../../src/sessions/ids.js'
import { DockTuiApp, type DockUiController } from '../../src/ui/dock-tui-app.js'

const controller = (): DockUiController => ({
  abort() {},
  async close() {},
  async *submit() {},
  getViewInfo: () => ({
    sessionId: asSessionId(randomUUID()),
    cwd: '/work',
    modelReference: 'test:model',
    permissionMode: 'default',
    contextSummary: '',
  }),
})

describe('user interaction and unified tasks', () => {
  it('renders a broker question in the bottom panel and returns the selection', async () => {
    const terminal = new VirtualTerminal(80, 24)
    const broker = new UserInteractionBroker()
    const sessionId = asSessionId(randomUUID())
    const app = new DockTuiApp({
      controller: controller(),
      tui: new TuiAltScreen(terminal),
      userInteractionBroker: broker,
    })
    app.start()
    const answer = broker.request(
      {
        type: 'questions',
        requester: { label: 'Main', sessionId },
        questions: [
          {
            question: 'Choose one',
            header: 'Choice',
            multiSelect: false,
            options: [
              { label: 'Alpha', description: 'A' },
              { label: 'Beta', description: 'B' },
            ],
          },
        ],
      },
      new AbortController().signal,
    )
    await terminal.waitForRender()
    expect(stripVTControlCharacters(terminal.getViewport().join('\n'))).toContain('Choose one')
    terminal.sendInput('\r')
    await expect(answer).resolves.toEqual({ type: 'questions', answers: { 'Choose one': 'Alpha' } })
    await app.stop()
  })
  it('opens work tasks with Ctrl+T', async () => {
    const terminal = new VirtualTerminal(80, 24)
    const app = new DockTuiApp({
      controller: controller(),
      tui: new TuiAltScreen(terminal),
      taskCommands: {
        list: async () => [
          {
            id: randomUUID(),
            subject: 'Write docs',
            description: 'Document Dock',
            status: 'pending',
            blocks: [],
            blockedBy: [],
          },
        ],
        get: async () => undefined,
      },
    })
    app.start()
    terminal.sendInput('\x14')
    await terminal.waitForRender()
    const viewport = stripVTControlCharacters(terminal.getViewport().join('\n'))
    expect(viewport).toContain('Work')
    expect(viewport).toContain('Write docs · pending')
    expect(viewport).toContain('Agents')
    await app.stop()
  })
})
