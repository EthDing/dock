import { randomUUID } from 'node:crypto'
import { matchesKey, ProcessTerminal, type Terminal, TuiAltScreen } from '@dock/tui'
import {
  createAssistantMessage,
  createUserMessage,
  type TranscriptMessage,
} from '../../messages/create-message.js'
import { PermissionBroker } from '../../permissions/permission-broker.js'
import { createSessionId } from '../../sessions/ids.js'
import type { AgentTool } from '../../tools/types.js'
import type { LogoRows } from '../components/brand.js'
import type { UiEvent } from '../contracts.js'
import { DockTuiApp, type DockUiController } from '../dock-tui-app.js'

export { type LogoRows, renderCaseLogo } from '../components/brand.js'
export type PreviewScene = 'welcome' | 'chat' | 'permission'

class PreviewSession implements DockUiController {
  sessionId = createSessionId()
  messages: TranscriptMessage[] = []
  permissionMode = 'default'
  requireApproval = false
  #abort = new AbortController()
  constructor(readonly broker: PermissionBroker) {}
  getViewInfo() {
    return {
      sessionId: this.sessionId,
      modelReference: 'deepseek-v4-flash',
      cwd: '~/code/dock',
      permissionMode: this.permissionMode,
      contextSummary: 'UI preview · No backend',
    }
  }
  reset() {
    this.sessionId = createSessionId()
    this.messages = []
  }
  abort() {
    this.#abort.abort()
  }
  async close() {
    this.abort()
  }
  async *submit(text: string): AsyncIterable<UiEvent> {
    this.#abort = new AbortController()
    const user = createUserMessage({ content: [{ type: 'text', text }] })
    this.messages.push(user)
    yield { type: 'user_message', message: user }
    const id = randomUUID()
    yield { type: 'model_stream', event: { type: 'message_start', messageId: id } }
    yield {
      type: 'model_stream',
      event: { type: 'content_block_start', index: 0, block: { type: 'text' } },
    }
    yield {
      type: 'model_stream',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '我先看看现有的显示逻辑。' },
      },
    }
    const call = {
      type: 'tool_use' as const,
      id: randomUUID(),
      name: 'Edit',
      input: {
        file_path: 'src/ui/themes.ts',
        old_string: 'plain output',
        new_string: 'compact output',
      },
    }
    const assistant = createAssistantMessage({
      role: 'assistant',
      id,
      usage: {},
      stopReason: 'tool_use',
      content: [{ type: 'text', text: '我先看看现有的显示逻辑。' }, call],
    })
    this.messages.push(assistant)
    yield { type: 'assistant_message', message: assistant }
    yield { type: 'tool_execution_start', toolUse: call }
    let allowed = true
    if (this.requireApproval) {
      const tool: AgentTool = {
        name: 'Edit',
        description: 'Preview only',
        inputSchema: {},
        isConcurrencySafe: () => false,
        execute: async () => ({ content: 'No file changes' }),
      }
      const result = await this.broker.requestApproval(
        tool,
        call.input,
        { behavior: 'ask', source: 'fallback' },
        this.#abort.signal,
        undefined,
        { sessionId: this.sessionId, toolUseId: call.id, parentMessageUuid: assistant.uuid },
      )
      allowed = result.behavior !== 'deny'
    }
    const result = {
      type: 'tool_result' as const,
      toolUseId: call.id,
      content: allowed
        ? 'Updated styles (example)\nNo project files were changed.'
        : 'The example edit was declined.',
      isError: !allowed,
    }
    yield {
      type: 'tool_result',
      result,
      outcome: this.#abort.signal.aborted ? 'aborted' : allowed ? 'success' : 'denied',
    }
    const toolMessage = createUserMessage({ content: [result] })
    this.messages.push(toolMessage)
    yield { type: 'user_message', message: toolMessage }
    if (allowed) {
      const done = createAssistantMessage({
        role: 'assistant',
        id: randomUUID(),
        usage: {},
        stopReason: 'end_turn',
        content: [{ type: 'text', text: '工具名与简短结果保留，完整内容可以用 Ctrl+O 查看。' }],
      })
      this.messages.push(done)
      yield { type: 'assistant_message', message: done }
    }
    yield {
      type: 'turn_end',
      result: { reason: this.#abort.signal.aborted ? 'aborted' : 'completed' },
    }
  }
}
export function startTuiPreview(
  options: { terminal?: Terminal; onStop?: () => void; start?: boolean } = {},
) {
  const terminal = options.terminal ?? new ProcessTerminal(),
    tui = new TuiAltScreen(terminal),
    broker = new PermissionBroker(),
    session = new PreviewSession(broker)
  let logoRows: LogoRows = 5
  const app = new DockTuiApp({
    tui,
    controller: session,
    permissionBroker: broker,
    sessionCommands: {
      clear: async () => session.reset(),
      branch: async () => {},
      listSessions: async () => [],
      resume: async () => {},
      setModel: async () => {},
    },
    preview: {
      logoRows: () => logoRows,
      helper: () =>
        `F1 start · F2 chat · F3 permission · F4 icon ${Math.min(logoRows, terminal.rows < 20 ? 3 : 7)} rows · Ctrl+C exit`,
    },
  })
  const preview = {
    get logoRows() {
      return logoRows
    },
    setLogoRows(rows: LogoRows) {
      logoRows = rows
      tui.requestRender()
    },
    async setScene(scene: PreviewScene) {
      session.requireApproval = scene === 'permission'
      if (scene === 'welcome') await app.submit('/clear')
      else await app.submit('把工具输出显示得更紧凑一些。')
    },
  }
  tui.addInputListener(
    (data) => {
      if (matchesKey(data, 'f4')) preview.setLogoRows(logoRows === 3 ? 5 : logoRows === 5 ? 7 : 3)
      else if (matchesKey(data, 'f1')) void preview.setScene('welcome')
      else if (matchesKey(data, 'f2')) void preview.setScene('chat')
      else if (matchesKey(data, 'f3')) void preview.setScene('permission')
      else return undefined
      return { consume: true }
    },
    { prepend: true },
  )
  if (options.onStop) void app.waitUntilStopped().then(options.onStop)
  if (options.start !== false) {
    app.start()
    terminal.setTitle('Dock UI Preview · Fullscreen')
  }
  return { app, tui, preview, stop: () => app.stop() }
}
