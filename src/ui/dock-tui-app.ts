import type { UiEvent, SessionViewInfo } from './contracts.js'
import type { AgentSnapshot, AgentView } from '../agents/types.js'
import { Editor, Key, Markdown, matchesKey, SelectList, Spacer, Text, type TUI } from '@dock/tui'
import type {
  MemoryNotification,
  MemoryNotificationBroker,
} from '../memory/memory-notification-broker.js'
import type { TranscriptMessage } from '../messages/create-message.js'
import type { ToolUseBlock } from '../model/types.js'
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
import { editorTheme, markdownTheme, selectListTheme } from './themes.js'

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
  snapshot: (id: string) => Promise<{ agent: AgentView; messages: readonly TranscriptMessage[] }>
  stop: (id: string) => Promise<AgentView>
  send: (id: string, text: string) => Promise<unknown>
  background: () => Promise<void>
  close: () => Promise<void>
}

export class DockTuiApp {
  readonly #controller: DockUiController
  readonly #editor: Editor
  readonly #status: Text
  readonly #tui: TUI
  readonly #sessionCommands: DockSessionCommands | undefined
  readonly #sandboxCommands: DockSandboxCommands | undefined
  readonly #permissionCycle: PermissionMode[]
  readonly #queue: string[] = []
  readonly #stopped: Promise<void>
  readonly #resolveStopped: () => void
  readonly #agentCommands: DockAgentCommands | undefined
  #closing = false
  #pendingTasks = false
  readonly #cancelModals = new Set<() => void>()
  #modal = 0
  #modalTail: Promise<unknown> = Promise.resolve()
  #busy = false
  #lastEscapeAt = 0

  constructor(options: {
    controller: DockUiController
    agentCommands?: DockAgentCommands
    memoryNotificationBroker?: MemoryNotificationBroker
    permissionBroker?: PermissionBroker
    sandboxNetworkPermissionBroker?: SandboxNetworkPermissionBroker
    sandboxCommands?: DockSandboxCommands
    sessionCommands?: DockSessionCommands
    startupNotices?: readonly string[]
    tui: TUI
  }) {
    this.#agentCommands = options.agentCommands
    this.#controller = options.controller
    this.#tui = options.tui
    this.#sessionCommands = options.sessionCommands
    this.#sandboxCommands = options.sandboxCommands
    let resolveStopped!: () => void
    this.#stopped = new Promise((resolve) => {
      resolveStopped = resolve
    })
    this.#resolveStopped = resolveStopped
    this.#editor = new Editor(this.#tui, editorTheme)
    this.#status = new Text(`${this.#controller.permissionMode ?? 'default'} · ready`, 1, 0)
    this.#permissionCycle = ['default', 'acceptEdits', 'plan']
    if (this.#controller.permissionMode === 'bypassPermissions') {
      this.#permissionCycle.push('bypassPermissions')
    }

    this.#tui.addChild(new Text('Dock', 1, 0))
    this.#tui.addChild(new Spacer(1))
    for (const notice of options.startupNotices ?? []) {
      this.#tui.addChild(new Text(`Warning: ${notice}`, 1, 0))
    }
    this.#tui.addChild(this.#status)
    this.#tui.addChild(this.#editor)
    this.#tui.setFocus(this.#editor)
    this.#editor.onSubmit = (text) => {
      void this.submit(text).catch((error) => this.#showError(error))
    }
    this.#tui.addInputListener((data) => {
      if (matchesKey(data, Key.ctrl('b'))) {
        void this.#agentCommands?.background().catch((error) => this.#showError(error))
        return { consume: true }
      }
      if (this.#modal > 0 && matchesKey(data, Key.escape)) return undefined
      if (matchesKey(data, Key.ctrl('c'))) {
        if (this.#busy) this.#controller.abort('interrupt')
        else void this.stop()
        return { consume: true }
      }
      if (matchesKey(data, Key.escape) && this.#busy) {
        this.#controller.abort('interrupt')
        return { consume: true }
      }
      if (matchesKey(data, Key.shift('tab')) && !this.#busy) {
        this.#cyclePermissionMode()
        return { consume: true }
      }
      if (
        matchesKey(data, Key.escape) &&
        !this.#busy &&
        !this.#editor.getText() &&
        Date.now() - this.#lastEscapeAt <= 500
      ) {
        this.#lastEscapeAt = 0
        void this.#selectRewindPoint()
        return { consume: true }
      }
      if (matchesKey(data, Key.escape)) this.#lastEscapeAt = Date.now()
      return undefined
    })
    options.permissionBroker?.setHandler((request) => this.#requestPermission(request))
    options.sandboxNetworkPermissionBroker?.setHandler((request) =>
      this.#requestSandboxNetwork(request),
    )
    options.memoryNotificationBroker?.setHandler((notification) =>
      this.#renderMemoryNotification(notification),
    )
  }

  start(): void {
    this.#tui.start()
  }

  async stop(): Promise<void> {
    if (this.#closing) return this.#stopped
    this.#closing = true
    for (const cancel of this.#cancelModals) cancel()
    this.#controller.abort('shutdown')
    try {
      await this.#agentCommands?.close()
      await this.#controller.close()
    } finally {
      this.#tui.stop()
      this.#resolveStopped()
    }
  }

  waitUntilStopped(): Promise<void> {
    return this.#stopped
  }

  async submit(text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed || this.#closing) return
    if (trimmed === '/exit') {
      await this.stop()
      return
    }
    if (trimmed === '/tasks' || trimmed.startsWith('/tasks ')) {
      await this.#tasksCommand(trimmed.slice('/tasks'.length).trim())
      return
    }
    if (this.#busy) {
      this.#queue.push(trimmed)
      this.#status.setText(
        `${this.#controller.permissionMode ?? 'default'} · working · ${this.#queue.length} queued`,
      )
      this.#tui.requestRender()
      return
    }
    if (trimmed === '/subtask' || trimmed.startsWith('/subtask ')) {
      const prompt = trimmed.slice('/subtask'.length).trim()
      if (!prompt) {
        this.#insertTranscript(new Text('Usage: /subtask <task> — fork the current context', 1, 0))
        this.#tui.requestRender()
        return
      }
      if (!this.#agentCommands) throw new Error('Subagents unavailable')
      this.#busy = true
      try {
        const agent = await this.#agentCommands.launch(prompt)
        this.#insertTranscript(
          new Text(`Agent ${agent.id} · ${agent.status} · ${agent.outputFile}`, 1, 0),
        )
      } finally {
        this.#busy = false
        this.#tui.requestRender()
        this.notifyTasksChanged()
      }
      const queued = this.#queue.shift()
      if (queued) await this.submit(queued)
      return
    }
    if (trimmed === '/clear') {
      await this.#changeSession(async () => {
        await this.#sessionCommands?.clear()
        this.#clearTranscript()
      })
      return
    }
    if (trimmed === '/context') {
      this.#insertTranscript(new Text(this.#controller.contextSummary?.() ?? 'Unavailable', 1, 0))
      this.#tui.requestRender()
      return
    }
    if (trimmed === '/compact' || trimmed.startsWith('/compact ')) {
      this.#busy = true
      this.#editor.disableSubmit = false
      this.#status.setText(`${this.#controller.permissionMode ?? 'default'} · compacting`)
      this.#tui.requestRender()
      try {
        if (!this.#controller.compact) throw new Error('Compaction is unavailable')
        await this.#controller.compact(trimmed.slice('/compact'.length).trim() || undefined)
        this.#insertTranscript(new Text('Conversation compacted', 1, 0))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.#insertTranscript(
          new Text(
            /cancel|abort/i.test(message)
              ? 'Compaction cancelled'
              : `Compaction failed: ${message}`,
            1,
            0,
          ),
        )
      } finally {
        this.#busy = false
        this.#editor.disableSubmit = false
        this.#setReadyStatus()
        this.#tui.requestRender()
      }
      const queued = this.#queue.shift()
      if (queued) await this.submit(queued)
      else this.#flushTasks()
      return
    }
    if (trimmed.startsWith('/rename ')) {
      await this.#controller.rename?.(trimmed.slice('/rename '.length).trim())
      this.#insertTranscript(new Text('Session renamed', 1, 0))
      this.#tui.requestRender()
      return
    }
    if (trimmed === '/rename') {
      this.#insertTranscript(new Text('Usage: /rename <name>', 1, 0))
      this.#tui.requestRender()
      return
    }
    if (trimmed === '/permissions') {
      await this.#selectPermissionMode()
      return
    }
    if (trimmed === '/sandbox') {
      await this.#selectSandboxMode()
      return
    }
    if (trimmed === '/rewind') {
      await this.#selectRewindPoint()
      return
    }
    if (trimmed === '/resume' || trimmed.startsWith('/resume ')) {
      await this.#resumeSession(trimmed.slice('/resume'.length).trim())
      return
    }
    if (trimmed === '/branch' || trimmed.startsWith('/branch ')) {
      await this.#changeSession(async () => {
        await this.#sessionCommands?.branch(trimmed.slice('/branch'.length).trim() || undefined)
        this.#renderControllerHistory()
      })
      return
    }
    if (trimmed.startsWith('/model ')) {
      await this.#changeSession(async () => {
        await this.#sessionCommands?.setModel(trimmed.slice('/model '.length).trim())
        this.#renderControllerHistory()
      })
      return
    }
    if (trimmed === '/model') {
      this.#insertTranscript(new Text('Usage: /model <provider:model-id>', 1, 0))
      this.#tui.requestRender()
      return
    }
    this.#insertTranscript(new Markdown(`**You**\n\n${trimmed}`, 1, 0, markdownTheme))
    await this.#renderRun(this.#controller.submit(trimmed))
  }

  async #renderRun(events: AsyncIterable<UiEvent>): Promise<void> {
    this.#busy = true
    this.#editor.disableSubmit = false
    this.#status.setText(`${this.#controller.permissionMode ?? 'default'} · working`)
    const toolNames = new Map<string, string>()
    let assistant: Markdown | undefined
    let assistantText = ''
    let thinking: Text | undefined
    let thinkingText = ''

    try {
      for await (const event of events) {
        if (event.type === 'assistant_message') {
          assistant = undefined
          assistantText = ''
          thinking = undefined
          thinkingText = ''
        }
        if (event.type === 'user_message' && event.message.agentEventKey) {
          this.#insertTranscript(
            new Text(`Subagent ${event.message.agentEventKey.split(':')[0]} update received`, 1, 0),
          )
        }
        if (
          event.type === 'model_stream' &&
          event.event.type === 'content_block_delta' &&
          event.event.delta.type === 'text_delta'
        ) {
          assistantText += event.event.delta.text
          if (!assistant) {
            assistant = new Markdown('', 1, 0, markdownTheme)
            this.#insertTranscript(assistant)
          }
          assistant.setText(`**Dock**\n\n${assistantText}`)
        } else if (
          event.type === 'model_stream' &&
          event.event.type === 'content_block_delta' &&
          event.event.delta.type === 'thinking_delta'
        ) {
          thinkingText += event.event.delta.thinking
          if (!thinking) {
            thinking = new Text('', 1, 0)
            this.#insertTranscript(thinking)
          }
          thinking.setText(`Thinking: ${thinkingText}`)
        } else if (event.type === 'tool_execution_start') {
          toolNames.set(event.toolUse.id, event.toolUse.name)
          this.#renderToolStart(event.toolUse)
        } else if (event.type === 'tool_result') {
          let detail = event.result.isError ? `  Error: ${event.result.content}` : '  Done'
          if (toolNames.get(event.result.toolUseId) === 'Agent' && !event.result.isError) {
            try {
              const task = JSON.parse(String(event.result.content)) as {
                id: string
                status: string
                outputFile: string
              }
              detail = `  Agent ${task.id} · ${task.status}\n  ${task.outputFile}`
            } catch {
              /* Non-JSON results retain the generic tool completion display. */
            }
          }
          this.#insertTranscript(new Text(detail, 1, 0))
        } else if (event.type === 'compaction_status') {
          if (event.status === 'started')
            this.#status.setText(`${this.#controller.permissionMode ?? 'default'} · compacting`)
          else {
            this.#insertTranscript(
              new Text(
                event.status === 'cancelled'
                  ? 'Compaction cancelled'
                  : `Compaction failed: ${event.message ?? 'Unknown error'}`,
                1,
                0,
              ),
            )
            this.#status.setText(`${this.#controller.permissionMode ?? 'default'} · working`)
          }
        } else if (event.type === 'compact') {
          this.#status.setText(`${this.#controller.permissionMode ?? 'default'} · working`)
          this.#insertTranscript(new Text('  Conversation compacted', 1, 0))
        }
        this.#tui.requestRender()
      }
    } catch (error) {
      this.#insertTranscript(
        new Text(`Error: ${error instanceof Error ? error.message : String(error)}`, 1, 0),
      )
    } finally {
      this.#busy = false
      this.#editor.disableSubmit = false
      this.#setReadyStatus()
      this.#tui.requestRender()
    }

    const queued = this.#queue.shift()
    if (queued) await this.submit(queued)
    else this.#flushTasks()
  }

  notifyTasksChanged(): void {
    if (this.#closing) return
    this.#pendingTasks = true
    queueMicrotask(() => this.#flushTasks())
  }

  #flushTasks(): void {
    if (!this.#pendingTasks || this.#busy || this.#modal > 0 || this.#closing) return
    this.#pendingTasks = false
    if (this.#controller.processNotifications) {
      void this.#renderRun(this.#controller.processNotifications()).catch((error) =>
        this.#showError(error),
      )
    }
  }

  async #tasksCommand(args: string): Promise<void> {
    if (!this.#agentCommands) throw new Error('Subagents unavailable')
    const [action, id, ...rest] = args.split(/\s+/)
    if (!action) {
      const tasks = await this.#agentCommands.list()
      this.#insertTranscript(
        new Text(
          tasks
            .map((a) => `${a.id} · ${a.name ?? a.description} · ${a.status}\n  ${a.outputFile}`)
            .join('\n') || 'No subagents in this session',
          1,
          0,
        ),
      )
      this.#insertTranscript(
        new Text(
          '/tasks <id> · /tasks stop <id> · /tasks continue <id> [message] · /tasks send <id> <message>\nSubagent edits are not restored by the parent /rewind.',
          1,
          0,
        ),
      )
    } else if (action === 'stop' && id) {
      const a = await this.#agentCommands.stop(id)
      this.#insertTranscript(new Text(`Stopped agent ${a.id}`, 1, 0))
    } else if ((action === 'send' || action === 'continue') && id) {
      const message = rest.join(' ') || (action === 'continue' ? 'Continue your task.' : '')
      if (!message) throw new Error('A message is required')
      await this.#agentCommands.send(id, message)
      this.#insertTranscript(new Text(`Message sent to ${id}`, 1, 0))
    } else {
      const { agent, messages } = await this.#agentCommands.snapshot(action)
      this.#insertTranscript(new Text(`${agent.id} · ${agent.status} · ${agent.outputFile}`, 1, 0))
      for (const m of messages) {
        const text = m.message.content
          .map((b) =>
            b.type === 'text'
              ? b.text
              : b.type === 'tool_use'
                ? b.name
                : b.type === 'tool_result'
                  ? String(b.content)
                  : '',
          )
          .filter(Boolean)
          .join('\n')
        if (text) this.#insertTranscript(new Text(`${m.type}: ${text}`, 1, 0))
      }
    }
    this.#tui.requestRender()
  }

  #insertTranscript(component: Markdown | Text): void {
    this.#tui.children.splice(this.#tui.children.length - 2, 0, component)
  }

  #renderMemoryNotification(notification: MemoryNotification): void {
    if (notification.type !== 'saved') return
    const count = notification.paths.length
    this.#insertTranscript(new Text(`Saved ${count} ${count === 1 ? 'memory' : 'memories'}`, 1, 0))
    this.#tui.requestRender()
  }

  #renderToolStart(toolUse: ToolUseBlock): void {
    const path = typeof toolUse.input.file_path === 'string' ? toolUse.input.file_path : undefined
    const command = typeof toolUse.input.command === 'string' ? toolUse.input.command : undefined
    const pattern = typeof toolUse.input.pattern === 'string' ? toolUse.input.pattern : undefined
    const detail =
      path ??
      command ??
      pattern ??
      (typeof toolUse.input.description === 'string' ? toolUse.input.description : undefined)
    this.#insertTranscript(
      new Text(`● ${toolUse.name}${detail ? `(${truncateDisplay(detail)})` : ''}`, 1, 0),
    )
    if (toolUse.name !== 'Edit') return
    const oldString = toolUse.input.old_string
    const newString = toolUse.input.new_string
    if (typeof oldString === 'string') {
      this.#insertTranscript(new Text(`  - ${truncateDisplay(oldString)}`, 1, 0))
    }
    if (typeof newString === 'string') {
      this.#insertTranscript(new Text(`  + ${truncateDisplay(newString)}`, 1, 0))
    }
  }

  #clearTranscript(): void {
    this.#tui.children.splice(2, Math.max(0, this.#tui.children.length - 4))
    this.#tui.requestRender(true)
  }

  async #requestPermission(request: PermissionRequest): Promise<PermissionApproval> {
    return this.#withModal(() => this.#showPermission(request))
  }

  async #showPermission(request: PermissionRequest): Promise<PermissionApproval> {
    if (this.#closing || request.signal.aborted) return { behavior: 'deny' }
    this.#status.setText(
      `Permission required · ${request.tool.name}` +
        (request.requester ? ` · ${request.requester.label} [${request.requester.agentId}]` : ''),
    )
    this.#tui.requestRender()
    return new Promise<PermissionApproval>((resolve) => {
      const list = new SelectList(
        [
          { description: 'Run only this tool call', label: 'Yes', value: 'once' },
          {
            description: 'Share this call approval within the current session, including subagents',
            label: 'Yes, for this session',
            value: 'session',
          },
          ...(request.tool.getPermissionRule?.(request.input)
            ? [
                {
                  description: 'Add an exact allow rule to project-local settings',
                  label: "Yes, and don't ask again",
                  value: 'always',
                },
              ]
            : []),
          { description: 'Return a denial to the model', label: 'No', value: 'no' },
        ],
        request.tool.getPermissionRule?.(request.input) ? 4 : 3,
        selectListTheme,
      )
      const title = new Text(
        [
          request.requester
            ? `Agent: ${request.requester.label} [${request.requester.agentId}]`
            : 'Main agent',
          `${request.tool.name}: ${truncateDisplay(JSON.stringify(request.input))}`,
        ].join('\n'),
        0,
        0,
      )
      const overlay = this.#tui.showOverlay(
        {
          render: (width) => [...title.render(width), ...list.render(width)],
          handleInput: (data) => list.handleInput(data),
          invalidate: () => {
            title.invalidate()
            list.invalidate()
          },
        },
        { anchor: 'bottom-center', width: '70%' },
      )
      let settled = false
      const finish = (approval: PermissionApproval) => {
        if (settled) return
        settled = true
        this.#cancelModals.delete(onAbort)
        request.signal.removeEventListener('abort', onAbort)
        overlay.hide()
        this.#status.setText(`${this.#controller.permissionMode ?? 'default'} · working`)
        this.#tui.requestRender(true)
        resolve(approval)
      }
      const onAbort = () => finish({ behavior: 'deny' })
      this.#cancelModals.add(onAbort)
      list.onSelect = (item) => {
        const rule = request.tool.getPermissionRule?.(request.input)
        finish(
          item.value === 'once'
            ? { behavior: 'allow_once' }
            : item.value === 'session'
              ? { behavior: 'allow_session' }
              : item.value === 'always' && rule
                ? { behavior: 'allow_always', rule }
                : { behavior: 'deny' },
        )
      }
      list.onCancel = () => finish({ behavior: 'deny' })
      request.signal.addEventListener('abort', onAbort, { once: true })
      if (request.signal.aborted) finish({ behavior: 'deny' })
    })
  }

  async #requestSandboxNetwork(request: SandboxNetworkRequest): Promise<SandboxNetworkResponse> {
    this.#status.setText(`Network permission required · ${request.host}`)
    this.#tui.requestRender()
    const selected = await this.#select([
      { description: 'Allow this connection', label: 'Yes', value: 'yes' },
      {
        description: `Add ${request.host} to local settings`,
        label: "Yes, and don't ask again",
        value: 'persist',
      },
      { description: 'Block this connection', label: 'No', value: 'no' },
    ])
    this.#status.setText(
      `${this.#controller.permissionMode ?? 'default'} · ${this.#busy ? 'working' : 'ready'}`,
    )
    return { allow: selected === 'yes' || selected === 'persist', persist: selected === 'persist' }
  }

  #showError(error: unknown): void {
    this.#insertTranscript(
      new Text(`Error: ${error instanceof Error ? error.message : String(error)}`, 1, 0),
    )
    this.#setReadyStatus()
    this.#tui.requestRender()
  }

  async #selectPermissionMode(): Promise<void> {
    if (!this.#controller.setPermissionMode) return
    const values = [...this.#permissionCycle]
    if (this.#controller.permissionMode === 'dontAsk') values.push('dontAsk')
    const selected = await this.#select(
      values.map((value) => ({ description: '', label: value, value })),
    )
    if (!selected) return
    this.#controller.setPermissionMode(selected as PermissionMode)
    this.#setReadyStatus()
  }

  async #selectSandboxMode(): Promise<void> {
    if (!this.#sandboxCommands) return
    const selected = await this.#select([
      {
        description: 'Sandboxed Bash runs without ordinary approval prompts',
        label: 'Enabled · auto-allow',
        value: 'auto-allow',
      },
      {
        description: 'Sandboxed Bash still uses the regular permission flow',
        label: 'Enabled · permissions',
        value: 'regular-permissions',
      },
      {
        description: 'Run Bash without OS sandbox isolation',
        label: 'Disabled',
        value: 'off',
      },
    ])
    if (!selected) return
    await this.#sandboxCommands.setMode(selected as DockSandboxMode)
    this.#insertTranscript(new Text(`Sandbox mode: ${this.#sandboxCommands.getMode()}`, 1, 0))
    this.#tui.requestRender()
  }

  #cyclePermissionMode(): void {
    if (!this.#controller.setPermissionMode) return
    const current = this.#controller.permissionMode ?? 'default'
    const next =
      this.#permissionCycle[
        (this.#permissionCycle.indexOf(current as PermissionMode) + 1) %
          this.#permissionCycle.length
      ] ?? 'default'
    this.#controller.setPermissionMode(next)
    this.#setReadyStatus()
    this.#tui.requestRender()
  }

  #setReadyStatus(): void {
    this.#status.setText(`${this.#controller.permissionMode ?? 'default'} · ready`)
  }

  async #selectRewindPoint(): Promise<void> {
    if (!this.#controller.rewind || !this.#controller.rewindPoints) return
    const points = this.#controller.rewindPoints()
    const selected = await this.#select(
      points.map((point) => ({ description: '', label: point.label, value: point.uuid })),
    )
    const point = points.find((candidate) => candidate.uuid === selected)
    if (!point) return
    await this.#controller.rewind(point.uuid, { conversation: true, files: true })
    this.#insertTranscript(new Text(`Rewound to: ${point.label}`, 1, 0))
    this.#tui.requestRender(true)
  }

  async #resumeSession(value: string): Promise<void> {
    if (!this.#sessionCommands) return
    let selected = value
    if (!selected) {
      const sessions = await this.#sessionCommands.listSessions()
      selected =
        (await this.#select(sessions.map((session) => ({ ...session, description: '' })))) ?? ''
    }
    if (!selected) return
    await this.#changeSession(async () => {
      await this.#sessionCommands?.resume(selected)
      this.#renderControllerHistory()
    })
  }

  async #changeSession(change: () => Promise<void>): Promise<void> {
    this.#busy = true
    try {
      await change()
    } finally {
      this.#busy = false
      this.#setReadyStatus()
      this.notifyTasksChanged()
    }
    const queued = this.#queue.shift()
    if (queued) await this.submit(queued)
  }

  #renderControllerHistory(): void {
    this.#clearTranscript()
    for (const entry of this.#controller.messages ?? []) {
      const text = entry.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
      if (!text) continue
      this.#insertTranscript(
        new Markdown(
          `**${entry.type === 'user' ? 'You' : 'Dock'}**\n\n${text}`,
          1,
          0,
          markdownTheme,
        ),
      )
    }
    this.#tui.requestRender(true)
    this.notifyTasksChanged()
  }

  async #withModal<T>(show: () => Promise<T>): Promise<T> {
    this.#modal++
    const next = this.#modalTail.then(show, show)
    this.#modalTail = next.catch(() => {})
    try {
      return await next
    } finally {
      this.#modal--
      this.#flushTasks()
    }
  }

  async #select(
    items: Array<{ description: string; label: string; value: string }>,
  ): Promise<string | undefined> {
    return this.#withModal(
      () =>
        new Promise((resolve) => {
          if (this.#closing) {
            resolve(undefined)
            return
          }
          const list = new SelectList(items, Math.min(items.length, 10), selectListTheme)
          const overlay = this.#tui.showOverlay(list, { anchor: 'bottom-center', width: '70%' })
          let settled = false
          const cancel = () => finish()
          const finish = (value?: string) => {
            if (settled) return
            settled = true
            this.#cancelModals.delete(cancel)
            overlay.hide()
            this.#tui.requestRender(true)
            resolve(value)
          }
          this.#cancelModals.add(cancel)
          list.onSelect = (item) => finish(item.value)
          list.onCancel = () => finish()
        }),
    )
  }
}

function truncateDisplay(value: string): string {
  const normalized = value.replaceAll('\n', '↵')
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`
}
