import type { UUID } from 'node:crypto'
import {
  type Component,
  Editor,
  Key,
  matchesKey,
  type TuiAltScreen,
  type TuiInputListenerResult,
} from '@dock/tui'
import type { AgentSnapshot, AgentUiUpdate, AgentView } from '../agents/types.js'
import type { MemoryNotificationBroker } from '../memory/memory-notification-broker.js'
import type { TranscriptMessage } from '../messages/create-message.js'
import type { PermissionMode } from '../permissions/evaluate-permission.js'
import type {
  PermissionApproval,
  PermissionBroker,
  PermissionRequest,
} from '../permissions/permission-broker.js'
import type { DockSandboxMode } from '../sandbox/dock-sandbox.js'
import type {
  SandboxNetworkPermissionBroker,
  SandboxNetworkRequest,
  SandboxNetworkResponse,
} from '../sandbox/network-permission-broker.js'
import { CommandRegistry } from './commands.js'
import { Brand, type LogoRows } from './components/brand.js'
import { FullscreenView } from './components/fullscreen-view.js'
import { type Choice, InteractionPanel } from './components/interaction-panel.js'
import { TaskList } from './components/task-list.js'
import { TranscriptView } from './components/transcript.js'
import type { SessionViewInfo, UiEvent } from './contracts.js'
import { muted, safeText } from './presentation.js'
import { editorTheme } from './themes.js'
import { TranscriptState } from './transcript-state.js'

export type DockUiController = {
  getSnapshot?: () => AgentSnapshot
  processNotifications?: () => AsyncIterable<UiEvent>
  getViewInfo?: () => SessionViewInfo
  displayMessages?: readonly TranscriptMessage[]
  abort: (reason?: unknown) => void
  close: () => Promise<void>
  submit: (text: string) => AsyncIterable<UiEvent>
  compact?: (instructions?: string) => Promise<void>
  contextSummary?: () => string
  permissionMode?: string
  rename?: (name: string) => Promise<void>
  rewind?: (
    uuid: `${string}-${string}-${string}-${string}-${string}`,
    options: { conversation: boolean; files: boolean },
  ) => Promise<void>
  rewindPoints?: () => Array<{
    label: string
    uuid: `${string}-${string}-${string}-${string}-${string}`
  }>
  setPermissionMode?: (mode: PermissionMode) => void
  messages?: readonly TranscriptMessage[]
}

export type DockSessionCommands = {
  branch: (name?: string) => Promise<void>
  clear: () => Promise<void>
  listSessions: () => Promise<Array<{ label: string; value: string }>>
  resume: (idOrName: string) => Promise<void>
  setModel: (reference: string) => Promise<void>
}

export type DockSandboxCommands = {
  getMode: () => DockSandboxMode
  setMode: (mode: DockSandboxMode) => Promise<void>
}

export type DockAgentCommands = {
  list: () => Promise<AgentView[]>
  launch: (prompt: string) => Promise<AgentView>
  snapshot: (id: string) => Promise<{
    agent: AgentView
    messages: readonly TranscriptMessage[]
    sequence?: number
    runId?: string
  }>
  subscribe?: (listener: (update: AgentUiUpdate) => void) => () => void
  stop: (id: string) => Promise<AgentView>
  send: (id: string, text: string) => Promise<unknown>
  background: () => Promise<void>
  close: () => Promise<void>
}

export class DockTuiApp {
  readonly #controller: DockUiController
  readonly #tui: TuiAltScreen
  readonly #editor: Editor
  readonly #screen: FullscreenView
  readonly #commands = new CommandRegistry()
  readonly #sessionCommands: DockSessionCommands | undefined
  readonly #sandboxCommands: DockSandboxCommands | undefined
  readonly #agents: DockAgentCommands | undefined
  readonly #preview: { logoRows?: () => LogoRows; helper?: string | (() => string) } | undefined
  #main: TranscriptState
  #mainView: TranscriptView
  #child: TranscriptState | undefined
  #childView: TranscriptView | undefined
  #activeAgent: AgentView | undefined
  #activeRun: string | undefined
  #taskList: TaskList | undefined
  #panel: InteractionPanel | undefined
  #panelCount = 0
  #panelTail: Promise<unknown> = Promise.resolve()
  #cancelPanel: (() => void) | undefined
  #unsubscribe: (() => void) | undefined
  #generation = 0
  #viewTicket = 0
  #snapshotBuffer: { id: string; updates: AgentUiUpdate[] } | undefined
  readonly #endedRuns = new Set<string>()
  readonly #drafts = new Map<string, string>()
  readonly #queue: Array<{ text: string; target?: string }> = []
  #busy = false
  #mainTask: Promise<void> | undefined
  #closing = false
  #pendingNotifications = false
  #refreshTimer: ReturnType<typeof setTimeout> | undefined
  #lastEscape = 0
  #resolveStopped!: () => void
  readonly #stopped: Promise<void>
  readonly #brand: Brand
  readonly #mainBody: Component
  readonly #childBody: Component

  constructor(options: {
    controller: DockUiController
    tui: TuiAltScreen
    agentCommands?: DockAgentCommands
    sessionCommands?: DockSessionCommands
    sandboxCommands?: DockSandboxCommands
    permissionBroker?: PermissionBroker
    sandboxNetworkPermissionBroker?: SandboxNetworkPermissionBroker
    memoryNotificationBroker?: MemoryNotificationBroker
    startupNotices?: readonly string[]
    preview?: { logoRows?: () => LogoRows; helper?: string | (() => string) }
  }) {
    this.#controller = options.controller
    this.#tui = options.tui
    this.#agents = options.agentCommands
    this.#sessionCommands = options.sessionCommands
    this.#sandboxCommands = options.sandboxCommands
    this.#preview = options.preview
    this.#stopped = new Promise((resolve) => {
      this.#resolveStopped = resolve
    })
    this.#main = new TranscriptState(this.#info().sessionId)
    this.#main.setMessages(this.#controller.displayMessages ?? this.#controller.messages ?? [])
    this.#mainView = new TranscriptView(this.#main)
    for (const text of options.startupNotices ?? []) this.#main.notice(`Warning: ${text}`)
    this.#brand = new Brand(
      () => this.#info(),
      () => this.#tui.terminal.rows,
      () => this.#preview?.logoRows?.() ?? 5,
    )
    this.#mainBody = {
      render: (width) => [...this.#brand.render(width), ...this.#mainView.render(width)],
      invalidate: () => this.#mainView.invalidate(),
    }
    this.#childBody = {
      render: (width) => [
        ...new Brand(
          () => ({
            ...this.#info(),
            cwd: this.#activeAgent?.cwd ?? '',
            modelReference: this.#activeAgent?.modelReference ?? '',
          }),
          () => this.#tui.terminal.rows,
          () => 3,
        ).render(width),
        muted(
          `Agent ${safeText(this.#activeAgent?.name ?? this.#activeAgent?.description ?? '')} · ${this.#activeAgent?.status ?? ''}`,
        ),
        muted(safeText(this.#activeAgent?.id ?? '')),
        muted(safeText(this.#activeAgent?.outputFile ?? '')),
        '',
        ...(this.#childView?.render(width) ?? []),
      ],
      invalidate: () => this.#childView?.invalidate(),
    }
    this.#editor = new Editor(this.#tui, editorTheme)
    this.#screen = new FullscreenView({
      tui: this.#tui,
      editor: this.#editor,
      body: () => this.#taskList ?? (this.#activeAgent ? this.#childBody : this.#mainBody),
      panel: () => this.#panel,
      status: () => this.#status(),
      target: () => this.#targetLabel(),
      helper: () =>
        typeof this.#preview?.helper === 'function'
          ? this.#preview.helper()
          : (this.#preview?.helper ?? '/help · Ctrl+O details · /search · /tasks'),
    })
    this.#registerCommands()
    this.#editor.setAutocompleteProvider(this.#commands.autocomplete)
    this.#seedHistory()
    this.#editor.onSubmit = (text) => {
      this.#editor.addToHistory(text)
      void this.submit(text).catch((e) => this.#error(e))
    }
    this.#tui.setFocus(this.#editor)
    this.#tui.addInputListener((data) => this.#input(data), { prepend: true })
    options.permissionBroker?.setHandler((request) => this.#requestPermission(request))
    options.sandboxNetworkPermissionBroker?.setHandler((request) => this.#requestNetwork(request))
    options.memoryNotificationBroker?.setHandler((notification) => {
      if (
        this.#closing ||
        (notification.sessionId && notification.sessionId !== this.#info().sessionId)
      )
        return
      this.#main.notice(
        `Saved ${notification.paths.length} ${notification.paths.length === 1 ? 'memory' : 'memories'}`,
      )
      this.#refresh()
    })
    this.#subscribe()
  }
  get screen(): FullscreenView {
    return this.#screen
  }
  get transcript(): TranscriptState {
    return this.#main
  }
  start(): void {
    try {
      this.#tui.start()
    } catch (error) {
      this.#tui.stop()
      throw error
    }
  }
  waitUntilStopped(): Promise<void> {
    return this.#stopped
  }
  async stop(): Promise<void> {
    if (this.#closing) return this.#stopped
    this.#closing = true
    this.#generation++
    this.#viewTicket++
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer)
    this.#cancelPanel?.()
    this.#controller.abort('shutdown')
    try {
      await this.#agents?.close()
      await this.#controller.close()
      await this.#mainTask
    } finally {
      this.#editor.setText('')
      this.#tui.stop()
      this.#resolveStopped()
    }
  }
  #info(): SessionViewInfo {
    return (
      this.#controller.getViewInfo?.() ?? {
        cwd: '',
        modelReference: '',
        permissionMode: this.#controller.permissionMode ?? 'default',
        contextSummary: this.#controller.contextSummary?.() ?? '',
      }
    )
  }
  #status(): string {
    const state = this.#activeAgent ? this.#child : this.#main
    const status = this.#panel
      ? 'awaiting input'
      : state?.status === 'compacting'
        ? 'compacting'
        : this.#busy
          ? 'working'
          : (state?.status ?? 'ready')
    return [
      this.#controller.permissionMode ?? 'default',
      status,
      this.#preview ? 'No backend' : this.#info().modelReference,
      this.#queue.length ? `${this.#queue.length} queued` : '',
    ]
      .filter(Boolean)
      .join(' · ')
  }
  #targetLabel(): string {
    return this.#activeAgent
      ? `To agent ${safeText(this.#activeAgent.name ?? this.#activeAgent.description)} · ${this.#activeAgent.id} · commands affect main`
      : this.#info().contextSummary || 'Main conversation'
  }
  #refresh(): void {
    if (this.#closing || this.#refreshTimer) return
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = undefined
      if (!this.#closing) this.#tui.requestRender()
    }, 50)
    this.#refreshTimer.unref?.()
  }
  #error(error: unknown): void {
    if (!this.#closing) {
      ;(this.#child ?? this.#main).notice(
        error instanceof Error ? error.message : String(error),
        true,
      )
      this.#refresh()
    }
  }
  #notice(text: string): void {
    this.#main.notice(text)
    this.#refresh()
  }
  #input(data: string): TuiInputListenerResult {
    if (this.#closing) return { consume: true }
    if (this.#tui.isSearching) return undefined
    if (this.#panel) {
      this.#panel.handleInput(data)
      this.#tui.requestRender()
      if (matchesKey(data, Key.ctrl('c'))) this.#cancelPanel?.()
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('c'))) {
      if (this.#tui.hasTextSelection) void this.#tui.copySelectedText().catch((e) => this.#error(e))
      else if (this.#busy) this.#controller.abort('interrupt')
      else void this.stop()
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('b'))) {
      void this.#agents?.background().catch((e) => this.#error(e))
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('o'))) {
      const view = this.#childView ?? this.#mainView
      view.detailed = !view.detailed
      this.#tui.requestRender()
      return { consume: true }
    }
    if (this.#taskList) {
      if (matchesKey(data, Key.escape)) {
        this.#returnMain()
        return { consume: true }
      }
      if (this.#editor.getText()) return undefined
      if (matchesKey(data, Key.up))
        this.#taskList.selected = Math.max(0, this.#taskList.selected - 1)
      else if (matchesKey(data, Key.down))
        this.#taskList.selected = Math.min(
          this.#taskList.items.length - 1,
          this.#taskList.selected + 1,
        )
      else if (matchesKey(data, Key.enter)) {
        const item = this.#taskList.items[this.#taskList.selected]
        if (item) void this.#openTask(item.id).catch((e) => this.#error(e))
      } else if (data === 'x') {
        const item = this.#taskList.items[this.#taskList.selected]
        if (item)
          void this.#agents
            ?.stop(item.id)
            .then(() => this.#loadTasks())
            .catch((e) => this.#error(e))
      } else return undefined
      this.#screen.scroll.scrollTo(Math.max(0, this.#taskList?.selected ?? 0) * 2)
      this.#tui.requestRender()
      return { consume: true }
    }
    if (matchesKey(data, Key.escape)) {
      if (this.#activeAgent || this.#snapshotBuffer) {
        this.#returnMain()
        return { consume: true }
      }
      if (this.#editor.isShowingAutocomplete()) return undefined
      if (this.#mainView.detailed) {
        this.#mainView.detailed = false
        this.#tui.requestRender()
        return { consume: true }
      }
      if (this.#busy) {
        this.#controller.abort('interrupt')
        return { consume: true }
      }
      if (!this.#editor.getText() && Date.now() - this.#lastEscape <= 500) {
        void this.#rewind().catch((e) => this.#error(e))
        this.#lastEscape = 0
        return { consume: true }
      }
      this.#lastEscape = Date.now()
    }
    if (matchesKey(data, Key.shift('tab')) && !this.#busy && this.#controller.setPermissionMode) {
      const modes: PermissionMode[] = ['default', 'acceptEdits', 'plan'],
        current = this.#controller.permissionMode as PermissionMode
      this.#controller.setPermissionMode(
        modes[(modes.indexOf(current) + 1) % modes.length] ?? 'default',
      )
      this.#tui.requestRender()
      return { consume: true }
    }
    return undefined
  }
  async submit(text: string): Promise<void> {
    await this.#submit(text, this.#activeAgent?.id)
  }
  async #submit(text: string, target?: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed || this.#closing) return
    if (trimmed === '/exit') {
      await this.stop()
      return
    }
    const command = trimmed.startsWith('/')
    if (!command && target) {
      await this.#agents?.send(target, trimmed)
      this.#editor.setText('')
      this.#drafts.set(target, '')
      return
    }
    const immediate = /^\/(tasks|search|help)(?:\s|$)/.test(trimmed)
    if ((this.#busy || this.#panelCount) && !immediate) {
      this.#queue.push({ text: trimmed, ...(target ? { target } : {}) })
      this.#editor.setText('')
      this.#refresh()
      return
    }
    this.#editor.setText('')
    if (command) {
      await this.#commands.execute(trimmed)
      return
    }
    this.#main.addPrompt(trimmed)
    await this.#run(this.#controller.submit(trimmed))
  }
  async #run(events: AsyncIterable<UiEvent>): Promise<void> {
    this.#busy = true
    const generation = this.#generation,
      state = this.#main
    state.status = 'working'
    this.#refresh()
    const work = (async () => {
      try {
        for await (const event of events) {
          if (generation !== this.#generation || this.#closing) continue
          state.apply(event)
          this.#refresh()
        }
      } catch (error) {
        state.apply({
          type: 'turn_end',
          result: {
            reason: 'model_error',
            error: error instanceof Error ? error.message : String(error),
          },
        })
      } finally {
        if (state.status === 'working') state.status = 'ready'
        this.#busy = false
        this.#refresh()
        this.#tui.requestRender()
      }
    })()
    this.#mainTask = work
    await work
    if (this.#mainTask === work) this.#mainTask = undefined
    await this.#drain()
  }
  async #drain(): Promise<void> {
    if (this.#closing || this.#busy || this.#panelCount) return
    const queued = this.#queue.shift()
    if (queued) {
      await this.#submit(queued.text, queued.target)
      return
    }
    if (this.#pendingNotifications && this.#controller.processNotifications) {
      this.#pendingNotifications = false
      await this.#run(this.#controller.processNotifications())
    }
  }
  notifyTasksChanged(): void {
    if (this.#closing) return
    this.#pendingNotifications = true
    queueMicrotask(() => {
      void this.#drain().catch((e) => this.#error(e))
    })
  }
  async #operation(work: () => Promise<void>): Promise<void> {
    this.#busy = true
    this.#refresh()
    try {
      await work()
    } finally {
      this.#busy = false
      this.#refresh()
      await this.#drain()
    }
  }
  #reload(reset = false): void {
    const info = this.#info()
    if (reset || info.sessionId !== this.#main.sessionId) {
      this.#generation++
      this.#viewTicket++
      this.#returnMain()
      this.#main = new TranscriptState(info.sessionId)
      this.#main.setMessages(this.#controller.displayMessages ?? this.#controller.messages ?? [])
      this.#mainView = new TranscriptView(this.#main)
      this.#editor.setText(this.#drafts.get(`main:${info.sessionId}`) ?? '')
      this.#subscribe()
      this.#screen.scroll.scrollToEnd()
      this.#seedHistory()
    } else
      for (const message of this.#controller.displayMessages ?? this.#controller.messages ?? [])
        this.#main.addMessage(message)
    this.#refresh()
    this.notifyTasksChanged()
  }
  #seedHistory(): void {
    for (const message of this.#controller.messages ?? [])
      if (message.type === 'user' && !message.isMeta && !message.isCompactSummary) {
        const text = message.message.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
        if (text) this.#editor.addToHistory(text)
      }
  }
  #registerCommands(): void {
    const add = (name: string, description: string, run: (args: string) => Promise<void>) =>
      this.#commands.register(name, description, run)
    add('exit', 'Close Dock', async () => this.stop())
    add('help', 'Commands and keyboard shortcuts', async () => {
      this.#notice(
        `${this.#commands.help()}\nCtrl+O details · /search search · PgUp/PgDn scroll · Ctrl+End follow · Esc back/interrupt`,
      )
    })
    add('search', 'Search the visible conversation', async () => {
      this.#tui.openSearch()
    })
    if (this.#controller.contextSummary)
      add('context', 'Show context usage', async () =>
        this.#notice(this.#controller.contextSummary?.() ?? ''),
      )
    if (this.#controller.compact)
      add('compact', 'Compact context [instructions]', async (args) =>
        this.#operation(async () => {
          this.#main.status = 'compacting'
          this.#refresh()
          try {
            await this.#controller.compact?.(args || undefined)
            this.#reload()
            this.#main.status = 'ready'
          } catch (error) {
            const text = error instanceof Error ? error.message : String(error)
            this.#main.notice(
              /cancel|abort/i.test(text) ? 'Compaction cancelled' : `Compaction failed: ${text}`,
              true,
            )
            this.#main.status = 'failed'
          }
        }),
      )
    if (this.#controller.rename)
      add('rename', 'Rename session <name>', async (args) => {
        if (!args) {
          this.#notice('Usage: /rename <name>')
          return
        }
        await this.#controller.rename?.(args)
        this.#notice('Session renamed')
      })
    if (this.#controller.setPermissionMode)
      add('permissions', 'Change permission mode', async () => {
        const modes: PermissionMode[] = ['default', 'acceptEdits', 'plan']
        if (this.#controller.permissionMode === 'bypassPermissions') modes.push('bypassPermissions')
        if (this.#controller.permissionMode === 'dontAsk') modes.push('dontAsk')
        const selected = await this.#choose(
          'Permission mode',
          'Main conversation',
          modes.map((value) => ({ label: value, value })),
        )
        if (selected) this.#controller.setPermissionMode?.(selected as PermissionMode)
      })
    if (this.#sandboxCommands)
      add('sandbox', 'Configure Bash sandbox', async () => {
        const selected = await this.#choose('Bash sandbox', 'Main conversation', [
          { label: 'Enabled · auto-allow', value: 'auto-allow' },
          { label: 'Enabled · permissions', value: 'regular-permissions' },
          { label: 'Disabled', value: 'off' },
        ])
        if (selected) {
          await this.#sandboxCommands?.setMode(selected as DockSandboxMode)
          this.#notice(`Sandbox mode: ${this.#sandboxCommands?.getMode()}`)
        }
      })
    if (this.#controller.rewind && this.#controller.rewindPoints)
      add('rewind', 'Rewind supported checkpoints', async () => this.#rewind())
    if (this.#sessionCommands) {
      add('clear', 'Start a new conversation', async () =>
        this.#operation(async () => {
          await this.#sessionCommands?.clear()
          this.#reload(true)
        }),
      )
      add('resume', 'Resume session [id or name]', async (args) =>
        this.#operation(async () => {
          let selected = args
          if (!selected) {
            const sessions = (await this.#sessionCommands?.listSessions()) ?? []
            selected = (await this.#choose('Resume session', '', sessions)) || ''
          }
          if (selected) {
            await this.#sessionCommands?.resume(selected)
            this.#reload(true)
          }
        }),
      )
      add('branch', 'Fork this session [name]', async (args) =>
        this.#operation(async () => {
          await this.#sessionCommands?.branch(args || undefined)
          this.#reload(true)
        }),
      )
      add('model', 'Switch model <provider:model>', async (args) => {
        if (!args) {
          this.#notice('Usage: /model <provider:model-id>')
          return
        }
        await this.#operation(async () => {
          await this.#sessionCommands?.setModel(args)
          this.#reload()
          this.#notice(`Main model: ${args}`)
        })
      })
    }
    if (this.#agents) {
      add('tasks', 'View, stop or continue subagents', async (args) => this.#tasksCommand(args))
      add('subtask', 'Fork a background task <prompt>', async (args) => {
        if (!args) {
          this.#notice('Usage: /subtask <task>')
          return
        }
        await this.#operation(async () => {
          const task = await this.#agents?.launch(args)
          if (task) this.#notice(`Agent ${task.id} · ${task.status}`)
        })
      })
    }
  }
  async #rewind(): Promise<void> {
    if (!this.#controller.rewind || !this.#controller.rewindPoints) return
    if (this.#busy) {
      this.#queue.push({ text: '/rewind' })
      return
    }
    await this.#operation(async () => {
      const points = this.#controller.rewindPoints?.() ?? []
      const id = await this.#choose(
        'Rewind',
        'Only tracked file edits are recoverable. Bash and ordinary subagent edits are not covered.',
        points.map((p) => ({ label: p.label, value: p.uuid })),
      )
      if (!id) return
      const mode = await this.#choose('Restore what?', 'Main session checkpoint', [
        { label: 'Conversation and tracked files', value: 'both' },
        { label: 'Conversation only', value: 'conversation' },
        { label: 'Tracked files only', value: 'files' },
      ])
      if (!mode) return
      await this.#controller.rewind?.(id as UUID, {
        conversation: mode !== 'files',
        files: mode !== 'conversation',
      })
      this.#reload(mode !== 'files')
      this.#notice('Rewound checkpoint')
    })
  }
  async #choose(
    title: string,
    body: string,
    choices: readonly Choice[],
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (!choices.length) {
      this.#notice(`${title}: no entries`)
      return undefined
    }
    this.#panelCount++
    const job = this.#panelTail.then(async () => {
      if (this.#closing || signal?.aborted) return undefined
      return new Promise<string | undefined>((resolve) => {
        const panel = new InteractionPanel(title, body, choices)
        this.#panel = panel
        let done = false
        const finish = (value?: string) => {
          if (done) return
          done = true
          signal?.removeEventListener('abort', cancel)
          this.#panel = undefined
          this.#cancelPanel = undefined
          this.#tui.setFocus(this.#editor)
          this.#tui.requestRender()
          resolve(value)
        }
        const cancel = () => finish()
        this.#cancelPanel = cancel
        panel.onSelect = finish
        panel.onCancel = cancel
        signal?.addEventListener('abort', cancel, { once: true })
        this.#editor.focused = false
        this.#tui.requestRender()
        if (signal?.aborted) cancel()
      })
    })
    this.#panelTail = job.catch(() => {})
    try {
      return await job
    } finally {
      this.#panelCount--
      this.#refresh()
      queueMicrotask(() => {
        void this.#drain().catch((e) => this.#error(e))
      })
    }
  }
  async #requestPermission(request: PermissionRequest): Promise<PermissionApproval> {
    const owner = request.requester
      ? `Agent ${request.requester.label} [${request.requester.agentId}]`
      : 'Main agent'
    const state = request.requester?.agentId === this.#activeAgent?.id ? this.#child : this.#main
    if (!request.sessionId || request.sessionId === this.#info().sessionId)
      state?.setPermission(request.toolUseId, true)
    const rule = request.tool.getPermissionRule?.(request.input)
    const options: Choice[] = [
      { label: 'Yes', value: 'once' },
      { label: 'Yes, for this session', value: 'session' },
      ...(rule ? [{ label: "Yes, and don't ask again", value: 'always' }] : []),
      { label: 'No', value: 'no' },
    ]
    try {
      const selected = await this.#choose(
        `Permission required · ${request.tool.name}`,
        `${owner + (request.sessionId ? `\nSession: ${request.sessionId}` : '')}\n${request.decision.message ?? ''}\n${JSON.stringify(request.input, null, 2)}`,
        options,
        request.signal,
      )
      if (selected === 'once') return { behavior: 'allow_once' }
      if (selected === 'session') return { behavior: 'allow_session' }
      if (selected === 'always' && rule) return { behavior: 'allow_always', rule }
      return { behavior: 'deny' }
    } finally {
      state?.setPermission(request.toolUseId, false)
    }
  }
  async #requestNetwork(request: SandboxNetworkRequest): Promise<SandboxNetworkResponse> {
    const value = await this.#choose(
      `Network permission required · ${request.host}`,
      `Shared sandbox proxy · ${request.host}${request.port ? `:${request.port}` : ''}`,
      [
        { label: 'Yes', value: 'once' },
        { label: "Yes, and don't ask again", value: 'persist' },
        { label: 'No', value: 'no' },
      ],
    )
    return { allow: value === 'once' || value === 'persist', persist: value === 'persist' }
  }
  async #tasksCommand(args: string): Promise<void> {
    if (!this.#agents) return
    const [action, id, ...rest] = args.split(/\s+/)
    if (!action) {
      this.#saveDraft()
      this.#activeAgent = undefined
      this.#childView = undefined
      this.#taskList = new TaskList()
      await this.#loadTasks()
      this.#screen.scroll.scrollToStart()
      return
    }
    if (action === 'stop' && id) {
      await this.#agents.stop(id)
      this.#notice(`Stopped agent ${id}`)
      await this.#loadTasks()
      return
    }
    if ((action === 'continue' || action === 'send') && id) {
      const text = rest.join(' ') || (action === 'continue' ? 'Continue your task.' : '')
      if (!text) throw new Error('A message is required')
      await this.#agents.send(id, text)
      this.#notice(`Message sent to ${id}`)
      return
    }
    await this.#openTask(action)
  }
  async #loadTasks(): Promise<void> {
    const generation = this.#generation,
      items = (await this.#agents?.list()) ?? []
    if (generation !== this.#generation || this.#closing) return
    this.#taskList?.update(items)
    this.#refresh()
  }
  #saveDraft(): void {
    this.#drafts.set(
      this.#activeAgent?.id ?? `main:${this.#main.sessionId}`,
      this.#editor.getText(),
    )
    this.#editor.setText('')
  }
  #returnMain(): void {
    this.#saveDraft()
    this.#viewTicket++
    this.#snapshotBuffer = undefined
    this.#taskList = undefined
    this.#activeAgent = undefined
    this.#childView = undefined
    this.#child = undefined
    this.#activeRun = undefined
    this.#editor.setText(this.#drafts.get(`main:${this.#info().sessionId}`) ?? '')
    this.#tui.setFocus(this.#editor)
    this.#screen.scroll.scrollToEnd()
    this.#refresh()
  }
  async #openTask(id: string): Promise<void> {
    if (!this.#agents) return
    const ticket = ++this.#viewTicket,
      generation = this.#generation
    this.#snapshotBuffer = { id, updates: [] }
    const snapshot = await this.#agents.snapshot(id)
    if (ticket !== this.#viewTicket || generation !== this.#generation || this.#closing) return
    this.#saveDraft()
    this.#taskList = undefined
    this.#activeAgent = snapshot.agent
    this.#child = new TranscriptState(this.#info().sessionId)
    this.#child.setMessages(snapshot.messages)
    this.#childView = new TranscriptView(this.#child)
    this.#activeRun = snapshot.runId
    const updates = this.#snapshotBuffer?.updates ?? []
    this.#snapshotBuffer = undefined
    for (const update of updates)
      if (update.sequence > (snapshot.sequence ?? 0)) this.#applyAgent(update)
    this.#editor.setText(this.#drafts.get(snapshot.agent.id) ?? '')
    this.#screen.scroll.scrollToEnd()
    this.#refresh()
  }
  #subscribe(): void {
    this.#unsubscribe?.()
    const generation = this.#generation
    this.#unsubscribe = this.#agents?.subscribe?.((update) => {
      if (
        this.#closing ||
        generation !== this.#generation ||
        update.sessionId !== this.#info().sessionId
      )
        return
      if (this.#snapshotBuffer?.id === update.agentId) this.#snapshotBuffer.updates.push(update)
      else this.#applyAgent(update)
      if (this.#taskList) {
        const items = this.#taskList.items.filter((a) => a.id !== update.agentId)
        items.push(update.agent)
        this.#taskList.update(items)
      }
      this.#refresh()
    })
  }
  #applyAgent(update: AgentUiUpdate): void {
    if (update.agentId !== this.#activeAgent?.id || !this.#child) return
    this.#activeAgent = update.agent
    if (this.#activeRun !== update.runId) {
      this.#activeRun = update.runId
      this.#child.apply({ type: 'turn_start' })
    }
    if (update.event)
      this.#child.apply({ ...update.event, sessionId: update.sessionId, operationId: update.runId })
    if (
      ['completed', 'failed', 'stopped'].includes(update.agent.status) &&
      !this.#endedRuns.has(update.runId)
    ) {
      this.#endedRuns.add(update.runId)
      this.#child.apply({
        type: 'turn_end',
        result: {
          reason:
            update.agent.status === 'completed'
              ? 'completed'
              : update.agent.status === 'stopped'
                ? 'aborted'
                : 'model_error',
          ...(update.agent.error ? { error: update.agent.error } : {}),
        },
      })
    }
  }
}
