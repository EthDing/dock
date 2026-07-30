import { Editor, Key, Markdown, SelectList, Spacer, Text, matchesKey, type TUI } from '@dock/tui'
import type { AgentEvent } from '../agent/run-agent-loop.js'
import type { PermissionBroker, PermissionRequest } from '../permissions/permission-broker.js'
import type { PermissionMode } from '../permissions/evaluate-permission.js'
import type {
  SandboxNetworkPermissionBroker,
  SandboxNetworkRequest,
  SandboxNetworkResponse,
} from '../sandbox/network-permission-broker.js'
import type { TranscriptMessage } from '../messages/create-message.js'
import type { ToolUseBlock } from '../model/types.js'
import { editorTheme, markdownTheme, selectListTheme } from './themes.js'

export type DockUiController = {
  abort: (reason?: unknown) => void
  close: () => Promise<void>
  submit: (text: string) => AsyncIterable<AgentEvent>
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

export class DockTuiApp {
  readonly #controller: DockUiController
  readonly #editor: Editor
  readonly #status: Text
  readonly #tui: TUI
  readonly #sessionCommands: DockSessionCommands | undefined
  readonly #permissionCycle: PermissionMode[]
  readonly #queue: string[] = []
  readonly #stopped: Promise<void>
  readonly #resolveStopped: () => void
  #busy = false
  #lastEscapeAt = 0

  constructor(options: {
    controller: DockUiController
    permissionBroker?: PermissionBroker
    sandboxNetworkPermissionBroker?: SandboxNetworkPermissionBroker
    sessionCommands?: DockSessionCommands
    startupNotices?: readonly string[]
    tui: TUI
  }) {
    this.#controller = options.controller
    this.#tui = options.tui
    this.#sessionCommands = options.sessionCommands
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
  }

  start(): void {
    this.#tui.start()
  }

  async stop(): Promise<void> {
    await this.#controller.close()
    this.#tui.stop()
    this.#resolveStopped()
  }

  waitUntilStopped(): Promise<void> {
    return this.#stopped
  }

  async submit(text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    if (trimmed === '/exit') {
      await this.stop()
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
    if (trimmed === '/clear') {
      await this.#sessionCommands?.clear()
      this.#clearTranscript()
      return
    }
    if (trimmed === '/context') {
      this.#insertTranscript(new Text(this.#controller.contextSummary?.() ?? 'Unavailable', 1, 0))
      this.#tui.requestRender()
      return
    }
    if (trimmed.startsWith('/compact')) {
      await this.#controller.compact?.(trimmed.slice('/compact'.length).trim() || undefined)
      this.#insertTranscript(new Text('Conversation compacted', 1, 0))
      this.#tui.requestRender()
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
    if (trimmed === '/rewind') {
      await this.#selectRewindPoint()
      return
    }
    if (trimmed === '/resume' || trimmed.startsWith('/resume ')) {
      await this.#resumeSession(trimmed.slice('/resume'.length).trim())
      return
    }
    if (trimmed === '/branch' || trimmed.startsWith('/branch ')) {
      await this.#sessionCommands?.branch(trimmed.slice('/branch'.length).trim() || undefined)
      this.#renderControllerHistory()
      return
    }
    if (trimmed.startsWith('/model ')) {
      await this.#sessionCommands?.setModel(trimmed.slice('/model '.length).trim())
      this.#renderControllerHistory()
      return
    }
    if (trimmed === '/model') {
      this.#insertTranscript(new Text('Usage: /model <provider:model-id>', 1, 0))
      this.#tui.requestRender()
      return
    }
    this.#busy = true
    this.#editor.disableSubmit = true
    this.#insertTranscript(new Markdown(`**You**\n\n${trimmed}`, 1, 0, markdownTheme))
    this.#status.setText(`${this.#controller.permissionMode ?? 'default'} · working`)
    let assistant: Markdown | undefined
    let assistantText = ''
    let thinking: Text | undefined
    let thinkingText = ''

    try {
      for await (const event of this.#controller.submit(trimmed)) {
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
          this.#renderToolStart(event.toolUse)
        } else if (event.type === 'tool_result') {
          this.#insertTranscript(
            new Text(event.result.isError ? `  Error: ${event.result.content}` : '  Done', 1, 0),
          )
        } else if (event.type === 'compact') {
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
  }

  #insertTranscript(component: Markdown | Text): void {
    this.#tui.children.splice(this.#tui.children.length - 2, 0, component)
  }

  #renderToolStart(toolUse: ToolUseBlock): void {
    const path = typeof toolUse.input.file_path === 'string' ? toolUse.input.file_path : undefined
    const command = typeof toolUse.input.command === 'string' ? toolUse.input.command : undefined
    const pattern = typeof toolUse.input.pattern === 'string' ? toolUse.input.pattern : undefined
    const detail = path ?? command ?? pattern
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

  async #requestPermission(request: PermissionRequest): Promise<boolean> {
    this.#status.setText(`Permission required · ${request.tool.name}`)
    this.#tui.requestRender()
    return new Promise<boolean>((resolve) => {
      const list = new SelectList(
        [
          { description: 'Run this tool call', label: 'Yes', value: 'yes' },
          { description: 'Return a denial to the model', label: 'No', value: 'no' },
        ],
        2,
        selectListTheme,
      )
      const overlay = this.#tui.showOverlay(list, { anchor: 'bottom-center', width: '70%' })
      let settled = false
      const finish = (approved: boolean) => {
        if (settled) return
        settled = true
        request.signal.removeEventListener('abort', onAbort)
        overlay.hide()
        this.#status.setText(`${this.#controller.permissionMode ?? 'default'} · working`)
        this.#tui.requestRender(true)
        resolve(approved)
      }
      const onAbort = () => finish(false)
      list.onSelect = (item) => finish(item.value === 'yes')
      list.onCancel = () => finish(false)
      request.signal.addEventListener('abort', onAbort, { once: true })
      if (request.signal.aborted) finish(false)
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
    await this.#sessionCommands.resume(selected)
    this.#renderControllerHistory()
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
  }

  async #select(
    items: Array<{ description: string; label: string; value: string }>,
  ): Promise<string | undefined> {
    return new Promise((resolve) => {
      const list = new SelectList(items, Math.min(items.length, 10), selectListTheme)
      const overlay = this.#tui.showOverlay(list, { anchor: 'bottom-center', width: '70%' })
      const finish = (value?: string) => {
        overlay.hide()
        this.#tui.requestRender(true)
        resolve(value)
      }
      list.onSelect = (item) => finish(item.value)
      list.onCancel = () => finish()
    })
  }
}

function truncateDisplay(value: string): string {
  const normalized = value.replaceAll('\n', '↵')
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`
}
