import type { UUID } from 'node:crypto'
import { runAgentLoop, type AgentEvent, type AgentLoopResult } from './agent/run-agent-loop.js'
import type { FileHistory } from './checkpoint/file-history.js'
import type { ContextManager } from './context/context-manager.js'
import { createUserMessage, type TranscriptMessage } from './messages/create-message.js'
import type { ModelAdapter } from './model/types.js'
import type { SessionWriter } from './sessions/session-store.js'
import type { PermissionModeState } from './permissions/permission-mode-state.js'
import type { AgentTool, CanUseTool } from './tools/types.js'

export class SessionController {
  readonly #fileHistory: FileHistory
  readonly #model: ModelAdapter
  readonly #modelId: string
  readonly #maxOutputTokens: number | undefined
  readonly #systemPrompt: readonly string[]
  readonly #tools: readonly AgentTool[]
  readonly #userContext: Readonly<Record<string, string>> | undefined
  readonly #writer: SessionWriter
  readonly #canUseTool: CanUseTool | undefined
  readonly #contextManager: ContextManager | undefined
  readonly #permissionModeState: PermissionModeState | undefined
  readonly #turnComplete: TurnCompleteWork | undefined
  #messages: TranscriptMessage[]
  #activeAbortController: AbortController | undefined
  #closed = false

  constructor(options: {
    canUseTool?: CanUseTool
    contextManager?: ContextManager
    fileHistory: FileHistory
    initialMessages?: readonly TranscriptMessage[]
    maxOutputTokens?: number
    model: ModelAdapter
    modelId: string
    permissionModeState?: PermissionModeState
    systemPrompt: readonly string[]
    tools: readonly AgentTool[]
    turnComplete?: TurnCompleteWork
    userContext?: Readonly<Record<string, string>>
    writer: SessionWriter
  }) {
    this.#canUseTool = options.canUseTool
    this.#contextManager = options.contextManager
    this.#fileHistory = options.fileHistory
    this.#messages = [...(options.initialMessages ?? [])]
    this.#maxOutputTokens = options.maxOutputTokens
    this.#model = options.model
    this.#modelId = options.modelId
    this.#permissionModeState = options.permissionModeState
    this.#systemPrompt = options.systemPrompt
    this.#tools = options.tools
    this.#turnComplete = options.turnComplete
    this.#userContext = options.userContext
    this.#writer = options.writer
  }

  get messages(): readonly TranscriptMessage[] {
    return this.#messages
  }

  async *submit(text: string): AsyncGenerator<AgentEvent, AgentLoopResult> {
    this.#assertOpen()
    if (this.#activeAbortController) throw new Error('A turn is already running')
    const userMessage = createUserMessage({ content: [{ text, type: 'text' }] })
    await this.#fileHistory.makeSnapshot(userMessage.uuid)
    this.#messages.push(userMessage)
    await this.#writer.recordTranscript([userMessage])

    const abortController = new AbortController()
    this.#activeAbortController = abortController
    try {
      const generator = runAgentLoop({
        ...(this.#canUseTool ? { canUseTool: this.#canUseTool } : {}),
        ...(this.#contextManager ? { contextManager: this.#contextManager } : {}),
        messages: this.#messages,
        ...(this.#maxOutputTokens ? { maxOutputTokens: this.#maxOutputTokens } : {}),
        model: this.#model,
        modelId: this.#modelId,
        signal: abortController.signal,
        systemPrompt: this.#systemPrompt,
        tools: this.#tools,
        ...(this.#userContext ? { userContext: this.#userContext } : {}),
      })

      let next = await generator.next()
      while (!next.done) {
        const event = next.value
        if (event.type === 'assistant_message' || event.type === 'user_message') {
          await this.#writer.recordTranscript([event.message])
        } else if (event.type === 'compact') {
          await this.#writer.recordCompaction(event.messages)
        }
        yield event
        next = await generator.next()
      }
      this.#messages = [...next.value.messages]
      await this.#writer.recordTranscript(this.#messages)
      if (next.value.reason === 'completed') this.#turnComplete?.schedule(this.#messages)
      return next.value
    } finally {
      this.#activeAbortController = undefined
    }
  }

  abort(reason: unknown = 'interrupt'): void {
    this.#activeAbortController?.abort(reason)
  }

  get permissionMode(): string {
    return this.#permissionModeState?.value ?? 'default'
  }

  setPermissionMode(mode: Parameters<PermissionModeState['set']>[0]): void {
    if (!this.#permissionModeState) throw new Error('Permission mode is not configurable')
    this.#permissionModeState.set(mode)
  }

  contextSummary(): string {
    if (!this.#contextManager) return 'Context management is disabled'
    const analysis = this.#contextManager.analyze(this.#messages, this.#systemPrompt, [])
    return `${analysis.estimatedTokens.toLocaleString()} estimated tokens · compact at ${analysis.threshold.toLocaleString()}`
  }

  async compact(instructions?: string): Promise<void> {
    if (!this.#contextManager) throw new Error('Context management is disabled')
    const messages = await this.#contextManager.compact(this.#messages, instructions)
    await this.#writer.recordCompaction(messages)
    this.#messages = [...messages]
  }

  async rename(name: string): Promise<void> {
    await this.#writer.rename(name)
  }

  rewindPoints(): Array<{ label: string; uuid: UUID }> {
    return this.#messages
      .filter((message) => message.type === 'user' && !message.isCompactSummary)
      .map((message) => ({
        label:
          message.message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join(' ')
            .slice(0, 80) || message.uuid,
        uuid: message.uuid,
      }))
  }

  async rewind(
    targetUuid: UUID,
    options: { conversation: boolean; files: boolean },
  ): Promise<void> {
    this.#assertOpen()
    if (this.#activeAbortController) throw new Error('Cannot rewind while a turn is running')
    if (options.files) await this.#fileHistory.rewind(targetUuid)
    if (options.conversation) {
      await this.#writer.rewindConversation(targetUuid)
      const index = this.#messages.findIndex((message) => message.uuid === targetUuid)
      if (index < 0) throw new Error(`Message ${targetUuid} is not in the active conversation`)
      this.#messages = this.#messages.slice(0, index + 1)
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.abort('shutdown')
    this.#closed = true
    // The transcript lock cannot be released while turn-complete work may still
    // use controller-owned resources or emit its final notification.
    await this.#turnComplete?.drain()
    await this.#writer.close()
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Session controller is closed')
  }
}

export type TurnCompleteWork = {
  drain: (timeoutMs?: number) => Promise<void>
  schedule: (messages: readonly TranscriptMessage[]) => void
}
