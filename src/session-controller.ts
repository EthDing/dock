import type { UUID } from 'node:crypto'
import { buildModelRequest } from './agent/request.js'
import { type AgentEvent, type AgentLoopResult, runAgentLoop } from './agent/run-agent-loop.js'
import type { FileHistory } from './checkpoint/file-history.js'
import { buildPostCompactMessages } from './context/compaction.js'
import type { ContextManager } from './context/context-manager.js'
import { createUserMessage, type TranscriptMessage } from './messages/create-message.js'
import type { ModelAdapter } from './model/types.js'
import type { PermissionModeState } from './permissions/permission-mode-state.js'
import type { SessionWriter } from './sessions/session-store.js'
import type { AgentTool, CanUseTool } from './tools/types.js'

export class SessionController {
  readonly #fileHistory: FileHistory
  readonly #model: ModelAdapter
  readonly #modelId: string
  readonly #maxOutputTokens: number | undefined
  readonly #systemPrompt: readonly string[]
  readonly #tools: readonly AgentTool[]
  #userContext: Readonly<Record<string, string>> | undefined
  readonly #writer: SessionWriter
  readonly #canUseTool: CanUseTool | undefined
  readonly #contextManager: ContextManager | undefined
  readonly #permissionModeState: PermissionModeState | undefined
  readonly #turnComplete: TurnCompleteWork | undefined
  #messages: TranscriptMessage[]
  #activeAbortController: AbortController | undefined
  #closed = false
  #activeDone: Promise<void> | undefined
  #finishActive: (() => void) | undefined

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
    const abortController = this.#beginOperation()
    let generator: ReturnType<typeof runAgentLoop> | undefined
    try {
      const userMessage = createUserMessage({ content: [{ text, type: 'text' }] })
      await this.#fileHistory.makeSnapshot(userMessage.uuid)
      this.#messages.push(userMessage)
      await this.#writer.recordTranscript([userMessage])
      generator = runAgentLoop({
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
          await this.#writer.recordCompaction(event.messages, event.compaction)
          this.#messages = [...event.messages]
          if (event.compaction?.userContext !== undefined)
            this.#userContext = event.compaction.userContext
        }
        if (event.type === 'tool_results_cleared') {
          await this.#writer.recordToolResultClearing(event.toolUseIds)
          this.#messages = [...event.messages]
        }
        yield event
        next = await generator.next()
      }
      this.#messages = [...next.value.messages]
      await this.#writer.recordTranscript(this.#messages)
      if (next.value.reason === 'completed')
        this.#turnComplete?.schedule(this.#messages, this.#userContext)
      return next.value
    } finally {
      abortController.abort('turn finished')
      await generator?.return({ reason: 'aborted', messages: this.#messages })
      this.#endOperation()
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
    const analysis = this.#contextManager.analyze(
      this.#messages,
      this.#systemPrompt,
      this.#tools,
      this.#userContext,
    )
    return `${analysis.estimatedTokens.toLocaleString()} estimated tokens · compact at ${analysis.threshold.toLocaleString()}`
  }

  async compact(instructions?: string): Promise<void> {
    this.#assertOpen()
    if (!this.#contextManager) throw new Error('Context management is disabled')
    const abort = this.#beginOperation()
    try {
      const request = buildModelRequest(this.#messages, {
        modelId: this.#modelId,
        systemPrompt: this.#systemPrompt,
        tools: this.#tools,
        ...(this.#userContext ? { userContext: this.#userContext } : {}),
        ...(this.#maxOutputTokens ? { maxOutputTokens: this.#maxOutputTokens } : {}),
      })
      const result = await this.#contextManager.compact(
        this.#messages,
        request,
        abort.signal,
        'manual',
        instructions,
      )
      abort.signal.throwIfAborted()
      const messages = buildPostCompactMessages(result)
      await this.#writer.recordCompaction(messages, result)
      result.commit()
      this.#messages = [...messages]
      if (result.userContext !== undefined) this.#userContext = result.userContext
    } catch (error) {
      if (abort.signal.aborted) throw new Error('Compaction cancelled')
      throw error
    } finally {
      this.#endOperation()
    }
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
    await this.#activeDone
    // The transcript lock cannot be released while turn-complete work may still
    // use controller-owned resources or emit its final notification.
    await this.#turnComplete?.drain()
    await this.#writer.close()
  }

  #beginOperation(): AbortController {
    this.#assertOpen()
    if (this.#activeAbortController) throw new Error('A turn is already running')
    const controller = new AbortController()
    this.#activeAbortController = controller
    this.#activeDone = new Promise((resolve) => {
      this.#finishActive = resolve
    })
    return controller
  }

  #endOperation(): void {
    this.#activeAbortController = undefined
    this.#finishActive?.()
    this.#finishActive = undefined
    this.#activeDone = undefined
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Session controller is closed')
  }
}

export type TurnCompleteWork = {
  drain: (timeoutMs?: number) => Promise<void>
  schedule: (
    messages: readonly TranscriptMessage[],
    userContext?: Readonly<Record<string, string>>,
  ) => void
}
