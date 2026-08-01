import { TuiMainScreen, type Terminal } from '@dock/tui'
import { describe, expect, it } from 'vitest'
import {
  DockTuiApp,
  type DockSessionCommands,
  type DockUiController,
} from '../../src/ui/dock-tui-app.js'
import { SandboxNetworkPermissionBroker } from '../../src/sandbox/network-permission-broker.js'
import type { DockSandboxMode } from '../../src/sandbox/dock-sandbox.js'
import { MemoryNotificationBroker } from '../../src/memory/memory-notification-broker.js'

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
  it('renders background memory notifications without a submitted turn', async () => {
    const controller: DockUiController = {
      abort: () => {},
      close: async () => {},
      async *submit() {},
    }
    const memoryNotificationBroker = new MemoryNotificationBroker()
    const tui = new TuiMainScreen(new MemoryTerminal())
    new DockTuiApp({ controller, memoryNotificationBroker, tui })

    memoryNotificationBroker.notify({
      paths: ['/memory/feedback.md', '/memory/user.md'],
      type: 'saved',
    })

    expect(tui.render(80).join('\n')).toContain('Saved 2 memories')
  })

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

  it('renders tool details and an Edit diff', async () => {
    const controller: DockUiController = {
      abort: () => {},
      close: async () => {},
      async *submit() {
        yield {
          type: 'tool_execution_start' as const,
          toolUse: {
            type: 'tool_use' as const,
            id: 'edit-1',
            name: 'Edit',
            input: {
              file_path: '/work/file.ts',
              old_string: 'const before = true',
              new_string: 'const after = true',
            },
          },
        }
        yield {
          type: 'tool_result' as const,
          result: { type: 'tool_result' as const, toolUseId: 'edit-1', content: 'Updated' },
        }
      },
    }
    const tui = new TuiMainScreen(new MemoryTerminal())
    const app = new DockTuiApp({ controller, tui })

    await app.submit('edit it')

    const rendered = tui.render(80).join('\n')
    expect(rendered).toContain('Edit(/work/file.ts)')
    expect(rendered).toContain('- const before = true')
    expect(rendered).toContain('+ const after = true')
    expect(rendered).toContain('Done')
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

  it('interrupts an active turn with Escape', async () => {
    let aborted = false
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const controller: DockUiController = {
      abort: () => {
        aborted = true
        release()
      },
      close: async () => {},
      async *submit() {
        await blocked
        yield { type: 'compact' as const, messages: [] }
      },
    }
    const terminal = new MemoryTerminal()
    const tui = new TuiMainScreen(terminal)
    const app = new DockTuiApp({ controller, tui })
    app.start()

    const turn = app.submit('wait')
    await Promise.resolve()
    terminal.send('\u001b')
    await turn

    expect(aborted).toBe(true)
    await app.stop()
  })

  it('renders sandbox network approval requests', async () => {
    const controller: DockUiController = {
      abort: () => {},
      close: async () => {},
      async *submit() {},
    }
    const broker = new SandboxNetworkPermissionBroker()
    const terminal = new MemoryTerminal()
    const tui = new TuiMainScreen(terminal)
    const app = new DockTuiApp({
      controller,
      sandboxNetworkPermissionBroker: broker,
      tui,
    })
    app.start()

    const response = broker.request({ host: 'example.com', port: 443 })
    await Promise.resolve()
    terminal.send('\r')

    await expect(response).resolves.toEqual({ allow: true, persist: false })
    await app.stop()
  })

  it('changes sandbox mode through /sandbox', async () => {
    const controller: DockUiController = {
      abort: () => {},
      close: async () => {},
      async *submit() {},
    }
    let mode: DockSandboxMode = 'off'
    const terminal = new MemoryTerminal()
    const tui = new TuiMainScreen(terminal)
    const app = new DockTuiApp({
      controller,
      sandboxCommands: {
        getMode: () => mode,
        setMode: async (nextMode) => {
          mode = nextMode
        },
      },
      tui,
    })
    app.start()

    const submission = app.submit('/sandbox')
    await Promise.resolve()
    terminal.send('\r')
    await submission

    expect(mode).toBe('auto-allow')
    await app.stop()
  })
})
