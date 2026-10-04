import { stripVTControlCharacters } from 'node:util'
import { type Terminal, TuiAltScreen } from '@dock/tui'
import { describe, expect, it, vi } from 'vitest'
import { MemoryNotificationBroker } from '../../src/memory/memory-notification-broker.js'
import { PermissionBroker } from '../../src/permissions/permission-broker.js'
import type { DockSandboxMode } from '../../src/sandbox/dock-sandbox.js'
import { SandboxNetworkPermissionBroker } from '../../src/sandbox/network-permission-broker.js'
import type { AgentTool } from '../../src/tools/types.js'
import {
  type DockSessionCommands,
  DockTuiApp,
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
  it('registers dynamic Skill commands and forwards invocation input', async () => {
    const calls: Array<[string, string | undefined]> = []
    const controller: DockUiController = {
      abort: () => {},
      close: async () => {},
      skills: [
        {
          baseDir: '/skills/review',
          description: 'Review code',
          location: '/skills/review/SKILL.md',
          name: 'review',
          scope: 'user',
          source: 'user-dock',
        },
      ],
      async *activateSkill(name, input) {
        calls.push([name, input])
        yield* []
      },
      async *submit() {},
    }
    const app = new DockTuiApp({ controller, tui: new TuiAltScreen(new MemoryTerminal()) })

    await app.submit('/review src/app.ts')

    expect(calls).toEqual([['review', 'src/app.ts']])
  })

  it('offers permanent approval only when the tool provides a persistent rule', async () => {
    const controller: DockUiController = {
      abort: () => {},
      close: async () => {},
      async *submit() {},
    }
    const permissionBroker = new PermissionBroker()
    const terminal = new MemoryTerminal()
    const tui = new TuiAltScreen(terminal)
    const app = new DockTuiApp({ controller, permissionBroker, tui })
    app.start()
    const abortController = new AbortController()
    const write: AgentTool = {
      description: 'Write',
      execute: async () => ({ content: '' }),
      inputSchema: { type: 'object' },
      isConcurrencySafe: () => false,
      name: 'Write',
    }

    const writeApproval = permissionBroker.requestApproval(
      write,
      { file_path: '/work/file.ts' },
      { behavior: 'ask', source: 'fallback' },
      abortController.signal,
    )
    await vi.waitFor(() =>
      expect(stripVTControlCharacters(tui.render(80).join('\n'))).toContain(
        'Permission required · Write',
      ),
    )
    terminal.send('\u001b[B')
    terminal.send('\u001b[B')
    terminal.send('\r')
    await expect(writeApproval).resolves.toEqual({ behavior: 'deny' })

    const bash: AgentTool = {
      ...write,
      getPermissionRule: (input) => `Bash(${String(input.command)})`,
      name: 'Bash',
    }
    const bashApproval = permissionBroker.requestApproval(
      bash,
      { command: 'pnpm test' },
      { behavior: 'ask', source: 'fallback' },
      abortController.signal,
    )
    await vi.waitFor(() =>
      expect(stripVTControlCharacters(tui.render(80).join('\n'))).toContain(
        'Permission required · Bash',
      ),
    )
    terminal.send('\u001b[B')
    terminal.send('\u001b[B')
    terminal.send('\r')
    await expect(bashApproval).resolves.toEqual({
      behavior: 'allow_always',
      rule: 'Bash(pnpm test)',
    })
    await app.stop()
  })

  it('renders background memory notifications without a submitted turn', async () => {
    const controller: DockUiController = {
      abort: () => {},
      close: async () => {},
      async *submit() {},
    }
    const memoryNotificationBroker = new MemoryNotificationBroker()
    const tui = new TuiAltScreen(new MemoryTerminal())
    new DockTuiApp({ controller, memoryNotificationBroker, tui })

    memoryNotificationBroker.notify({
      paths: ['/memory/feedback.md', '/memory/user.md'],
      type: 'saved',
    })

    expect(stripVTControlCharacters(tui.render(80).join('\n'))).toContain('Saved 2 memories')
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
    const tui = new TuiAltScreen(new MemoryTerminal())
    const app = new DockTuiApp({ controller, tui })

    await app.submit('hi')

    const rendered = stripVTControlCharacters(tui.render(80).join('\n'))
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
    const tui = new TuiAltScreen(new MemoryTerminal())
    const app = new DockTuiApp({ controller, tui })

    await app.submit('edit it')

    const rendered = stripVTControlCharacters(tui.render(80).join('\n'))
    expect(rendered).toContain('Edit /work/file.ts')
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
    const tui = new TuiAltScreen(new MemoryTerminal())
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
    const tui = new TuiAltScreen(terminal)
    const app = new DockTuiApp({ controller, tui })
    app.start()

    terminal.send('\u001b[Z')

    expect(permissionMode).toBe('acceptEdits')
    expect(stripVTControlCharacters(tui.render(80).join('\n'))).toContain('acceptEdits · ready')
    terminal.send('\u001b[Z')
    expect(permissionMode).toBe('plan')
    terminal.send('\u001b[Z')
    expect(permissionMode).toBe('auto')
    expect(stripVTControlCharacters(tui.render(80).join('\n'))).toContain('auto · ready')
    terminal.send('\u001b[Z')
    expect(permissionMode).toBe('default')
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
    const tui = new TuiAltScreen(terminal)
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
    const tui = new TuiAltScreen(terminal)
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
    const tui = new TuiAltScreen(terminal)
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

  it('marks manual compaction busy, routes Escape, and never reports cancellation as success', async () => {
    let rejectCompact!: (error: Error) => void
    const controller: DockUiController = {
      async *submit() {},
      close: async () => {},
      compact: () =>
        new Promise<void>((_, reject) => {
          rejectCompact = reject
        }),
      abort: () => rejectCompact(new DOMException('Compaction cancelled', 'AbortError')),
    }
    const terminal = new MemoryTerminal()
    const tui = new TuiAltScreen(terminal)
    const app = new DockTuiApp({ controller, tui })
    app.start()
    const pending = app.submit('/compact')
    await Promise.resolve()
    expect(stripVTControlCharacters(tui.render(80).join('\n'))).toContain('compacting')
    terminal.send('\u001b')
    await pending
    const rendered = stripVTControlCharacters(tui.render(80).join('\n'))
    expect(rendered).toContain('Compaction cancelled')
    expect(rendered).not.toContain('Conversation compacted')
    expect(app.transcript.status).toBe('interrupted')
    await app.stop()
  })
})
it('labels child permission prompts and Escape denies only that call, not the main turn', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => {
      release = r
    }),
    abort = vi.fn()
  const controller: DockUiController = {
    abort,
    close: async () => {},
    async *submit() {
      await gate
      yield* []
    },
  }
  const broker = new PermissionBroker(),
    terminal = new MemoryTerminal(),
    tui = new TuiAltScreen(terminal)
  const app = new DockTuiApp({ controller, permissionBroker: broker, tui })
  app.start()
  const main = app.submit('working')
  const approval = broker.requestApproval(
    {
      name: 'Write',
      description: 'write',
      inputSchema: {},
      isConcurrencySafe: () => false,
      execute: async () => ({ content: '' }),
    },
    {},
    { behavior: 'ask', source: 'fallback' },
    new AbortController().signal,
    { agentId: 'stable-child-id', label: 'Child task' },
  )
  await vi.waitFor(() =>
    expect(stripVTControlCharacters(tui.render(80).join('\n'))).toContain('Child task'),
  )
  terminal.send('\u001b')
  expect(await approval).toEqual({ behavior: 'deny' })
  expect(abort).not.toHaveBeenCalled()
  release()
  await main
  await app.stop()
})

it('closes an outstanding network permission dialog during shutdown', async () => {
  const controller: DockUiController = {
    abort: () => {},
    close: async () => {},
    async *submit() {},
  }
  const broker = new SandboxNetworkPermissionBroker(),
    tui = new TuiAltScreen(new MemoryTerminal())
  const app = new DockTuiApp({ controller, sandboxNetworkPermissionBroker: broker, tui })
  app.start()
  const pending = broker.request({ host: 'example.invalid', port: 443 })
  await Promise.resolve()
  await app.stop()
  expect(await pending).toEqual({ allow: false, persist: false })
})
it('holds completion delivery until a session switch finishes', async () => {
  let release!: () => void,
    calls = 0
  const gate = new Promise<void>((r) => {
    release = r
  })
  const controller: DockUiController = {
    abort: () => {},
    close: async () => {},
    async *submit() {},
    async *processNotifications() {
      calls++
      yield* []
    },
  }
  const commands: DockSessionCommands = {
    branch: async () => {},
    clear: async () => {},
    listSessions: async () => [],
    resume: async () => {},
    setModel: async () => {
      await gate
    },
  }
  const app = new DockTuiApp({
    controller,
    sessionCommands: commands,
    tui: new TuiAltScreen(new MemoryTerminal()),
  })
  const changing = app.submit('/model test:new')
  app.notifyTasksChanged()
  await Promise.resolve()
  await Promise.resolve()
  expect(calls).toBe(0)
  release()
  await changing
  await vi.waitFor(() => expect(calls).toBe(1))
  await app.stop()
})
it('shows the stable identity and state returned by Agent instead of only Done', async () => {
  const controller: DockUiController = {
    abort: () => {},
    close: async () => {},
    async *submit() {
      yield {
        type: 'tool_execution_start',
        toolUse: {
          type: 'tool_use',
          id: 'call',
          name: 'Agent',
          input: { description: 'Inspect files' },
        },
      }
      yield {
        type: 'tool_result',
        result: {
          type: 'tool_result',
          toolUseId: 'call',
          content: JSON.stringify({
            id: 'stable-child',
            status: 'running',
            outputFile: '/tmp/child.jsonl',
          }),
        },
      }
    },
  }
  const tui = new TuiAltScreen(new MemoryTerminal()),
    app = new DockTuiApp({ controller, tui })
  await app.submit('delegate')
  expect(stripVTControlCharacters(tui.render(100).join('\n'))).toContain('stable-child')
  expect(stripVTControlCharacters(tui.render(100).join('\n'))).toContain('running')
  await app.stop()
})
it('accepts /tasks from the terminal while the main model is still running', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => {
      release = r
    }),
    list = vi.fn(async () => [])
  const controller: DockUiController = {
    abort: () => release(),
    close: async () => {},
    async *submit() {
      await gate
      yield* []
    },
  }
  const terminal = new MemoryTerminal(),
    app = new DockTuiApp({
      controller,
      tui: new TuiAltScreen(terminal),
      agentCommands: {
        list,
        launch: async () => {
          throw Error('unused')
        },
        snapshot: async () => {
          throw Error('unused')
        },
        stop: async () => {
          throw Error('unused')
        },
        send: async () => {},
        background: async () => {},
        close: async () => {},
      },
    })
  app.start()
  const active = app.submit('working')
  terminal.send('/tasks')
  terminal.send('\r')
  try {
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce())
  } finally {
    release()
    await active
    await app.stop()
  }
})
it('does not attach an unseen child permission request to a main tool with the same call ID', async () => {
  const broker = new PermissionBroker(),
    terminal = new MemoryTerminal(),
    tui = new TuiAltScreen(terminal)
  const app = new DockTuiApp({
    tui,
    permissionBroker: broker,
    controller: { abort() {}, async close() {}, async *submit() {} },
  })
  const tool: AgentTool = {
    name: 'Read',
    description: 'read',
    inputSchema: {},
    isConcurrencySafe: () => true,
    execute: async () => ({ content: '' }),
  }
  app.start()
  app.transcript.apply({
    type: 'tool_execution_start',
    toolUse: { type: 'tool_use', id: 'same', name: 'Read', input: {} },
  })
  const pending = broker.requestApproval(
    tool,
    {},
    { behavior: 'ask', source: 'fallback' },
    new AbortController().signal,
    { agentId: 'other-child', label: 'Other' },
    { toolUseId: 'same' },
  )
  await vi.waitFor(() =>
    expect(stripVTControlCharacters(tui.render(80).join('\n'))).toContain('Permission required'),
  )
  expect(app.transcript.tool('same')?.status).toBe('running')
  terminal.send('\x1b')
  await pending
  await app.stop()
})
