import { TuiMainScreen, type Terminal } from '@dock/tui'
import { describe, expect, it } from 'vitest'
import {
  DockTuiApp,
  type DockSessionCommands,
  type DockUiController,
} from '../../src/ui/dock-tui-app.js'

class MemoryTerminal implements Terminal {
  columns = 80
  rows = 24
  kittyProtocolActive = false
  output = ''
  input: ((data: string) => void) | undefined
  start(onInput: (data: string) => void): void {
    this.input = onInput
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.output += data
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  send(data: string): void {
    this.input?.(data)
  }
}

describe('DockTuiApp', () => {
  it('renders submitted user text and streamed assistant text', async () => {
    const controller: DockUiController = {
      abort: () => {},
      close: async () => {},
      async *submit() {
        yield {
          type: 'model_stream' as const,
          event: {
            type: 'content_block_delta' as const,
            index: 0,
            delta: { type: 'text_delta' as const, text: 'hello from Dock' },
          },
        }
      },
    }
    const tui = new TuiMainScreen(new MemoryTerminal())
    const app = new DockTuiApp({ controller, tui })

    await app.submit('hi')

    const rendered = tui.render(80).join('\n')
    expect(rendered).toContain('hi')
    expect(rendered).toContain('hello from Dock')
  })

  it('routes session commands without sending them to the model', async () => {
    const calls: string[] = []
    const controller: DockUiController = {
      abort: () => {},
      close: async () => {},
      messages: [],
      submit() {
        throw new Error('model should not be called')
      },
    }
    const sessionCommands: DockSessionCommands = {
      branch: async (name) => {
        calls.push(`branch:${name ?? ''}`)
      },
      clear: async () => {
        calls.push('clear')
      },
      listSessions: async () => [],
      resume: async (value) => {
        calls.push(`resume:${value}`)
      },
      setModel: async (value) => {
        calls.push(`model:${value}`)
      },
    }
    const tui = new TuiMainScreen(new MemoryTerminal())
    const app = new DockTuiApp({ controller, sessionCommands, tui })

    await app.submit('/clear')
    await app.submit('/resume saved')
    await app.submit('/branch experiment')
    await app.submit('/model openai:gpt-test')

    expect(calls).toEqual(['clear', 'resume:saved', 'branch:experiment', 'model:openai:gpt-test'])
  })

  it('cycles permission modes with Shift+Tab', async () => {
    let permissionMode = 'default'
    const controller: DockUiController = {
      abort: () => {},
      close: async () => {},
      get permissionMode() {
        return permissionMode
      },
      setPermissionMode(mode) {
        permissionMode = mode
      },
      async *submit() {},
    }
    const terminal = new MemoryTerminal()
    const tui = new TuiMainScreen(terminal)
    const app = new DockTuiApp({ controller, tui })
    app.start()

    terminal.send('\u001b[Z')

    expect(permissionMode).toBe('acceptEdits')
    expect(tui.render(80).join('\n')).toContain('acceptEdits · ready')
    await app.stop()
  })
})
