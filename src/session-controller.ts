import type { UUID } from 'node:crypto'
import { buildModelRequest } from './agent/request.js'
import { type AgentEvent, type AgentLoopResult, runAgentLoop } from './agent/run-agent-loop.js'
import type { AgentSnapshot } from './agents/types.js'
import type { FileHistory } from './checkpoint/file-history.js'
import { buildPostCompactMessages } from './context/compaction.js'
import type { ContextManager } from './context/context-manager.js'
import type { UserTranscriptMessage } from './messages/create-message.js'
import { createUserMessage, type TranscriptMessage } from './messages/create-message.js'
import type { ModelAdapter } from './model/types.js'
import type { PermissionModeState } from './permissions/permission-mode-state.js'
import type { SessionWriter } from './sessions/session-store.js'
import type { AgentTool, CanUseTool } from './tools/types.js'
import type { SkillActivator } from './skills/activation.js'
import type { SkillDefinition, SkillDiagnostic } from './skills/registry.js'
import type { SessionViewInfo } from './ui/contracts.js'

export class SessionController {
  readonly #identity:
    | (() => Omit<AgentSnapshot, 'messages' | 'systemPrompt' | 'userContext' | 'tools'>)
    | undefined
  readonly #inbox:
    | {
        peek: (seen: readonly TranscriptMessage[]) => Promise<readonly UserTranscriptMessage[]>
        ack: (ids: readonly string[]) => Promise<void>
      }
    | undefined
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
  readonly #skillActivator: SkillActivator | undefined
  readonly #skills: readonly SkillDefinition[]
  readonly #skillDiagnostics: readonly SkillDiagnostic[]
  #messages: TranscriptMessage[]
  #displayMessages: TranscriptMessage[]
  #activeAbortController: AbortController | undefined
  #closed = false
  #activeDone: Promise<void> | undefined
  #finishActive: (() => void) | undefined

  constructor(options: {
    getAgentIdentity?: () => Omit<
      AgentSnapshot,
      'messages' | 'systemPrompt' | 'userContext' | 'tools'
    >
    inbox?: {
      peek: (seen: readonly TranscriptMessage[]) => Promise<readonly UserTranscriptMessage[]>
      ack: (ids: readonly string[]) => Promise<void>
    }
    canUseTool?: CanUseTool
    contextManager?: ContextManager
    fileHistory: FileHistory
    initialMessages?: readonly TranscriptMessage[]
    initialDisplayMessages?: readonly TranscriptMessage[]
    maxOutputTokens?: number
    model: ModelAdapter
    modelId: string
    permissionModeState?: PermissionModeState
    systemPrompt: readonly string[]
    tools: readonly AgentTool[]
    turnComplete?: TurnCompleteWork
    skillActivator?: SkillActivator
    skills?: readonly SkillDefinition[]
    skillDiagnostics?: readonly SkillDiagnostic[]
    userContext?: Readonly<Record<string, string>>
    writer: SessionWriter
  }) {
    this.#identity = options.getAgentIdentity
    this.#inbox = options.inbox
    this.#canUseTool = options.canUseTool
    this.#contextManager = options.contextManager
    this.#fileHistory = options.fileHistory
    this.#messages = [...(options.initialMessages ?? [])]
    this.#displayMessages = [...(options.initialDisplayMessages ?? options.initialMessages ?? [])]
    this.#maxOutputTokens = options.maxOutputTokens
    this.#model = options.model
    this.#modelId = options.modelId
    this.#permissionModeState = options.permissionModeState
    this.#systemPrompt = options.systemPrompt
    this.#tools = options.tools
    this.#turnComplete = options.turnComplete
    this.#skillActivator = options.skillActivator
    this.#skills = options.skills ?? []
    this.#skillDiagnostics = options.skillDiagnostics ?? []
    this.#userContext = options.userContext
    this.#writer = options.writer
  }

  get messages(): readonly TranscriptMessage[] {
    return this.#messages
  }

  get displayMessages(): readonly TranscriptMessage[] {
    return this.#displayMessages
  }
  getViewInfo(): SessionViewInfo {
    const identity = this.#identity?.()
    return {
      sessionId: identity?.sessionId,
      cwd: identity?.cwd ?? '',
      modelReference: identity?.modelReference ?? this.#modelId,
      permissionMode: this.permissionMode,
      contextSummary: this.contextSummary(),
    }
  }
  #appendDisplay(messages: readonly TranscriptMessage[]): void {
    const known = new Set(this.#displayMessages.map((m) => m.uuid))
    this.#displayMessages.push(...messages.filter((m) => !known.has(m.uuid)))
  }
  getSnapshot(): AgentSnapshot {
    if (!this.#identity) throw new Error('Agent identity is unavailable')
    return {
      ...this.#identity(),
      messages: [...this.#messages],
      systemPrompt: this.#systemPrompt,
      userContext: this.#userContext,
      tools: this.#tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
      maxOutputTokens: this.#maxOutputTokens,
    }
  }

  async *processNotifications(): AsyncGenerator<AgentEvent, AgentLoopResult> {
    if (!(await this.#inbox?.peek(this.#messages))?.length)
      return { reason: 'completed', messages: this.#messages }
    return yield* this.#run()
  }

  async *submit(
    text: string,
    options: { maxTurns?: number } = {},
  ): AsyncGenerator<AgentEvent, AgentLoopResult> {
    return yield* this.#run({ text, userInitiated: true, ...options })
  }

  get skills(): readonly SkillDefinition[] {
    return this.#skills
  }

  get skillDiagnostics(): readonly SkillDiagnostic[] {
    return this.#skillDiagnostics
  }

  async *activateSkill(
    name: string,
    invocationInput?: string,
  ): AsyncGenerator<AgentEvent, AgentLoopResult> {
    if (!this.#skillActivator) throw new Error('Skills are unavailable')
    this.#skillActivator.sync(this.#messages)
    const activation = await this.#skillActivator.activate(name, invocationInput)
    if (activation.isError) throw new Error(activation.content)
    const initialMessage = activation.context
      ? createUserMessage(
          { content: [{ type: 'text', text: activation.context.text }] },
          { isMeta: true, skillContext: activation.context.skillContext },
        )
      : createUserMessage(
          { content: [{ type: 'text', text: activation.content }] },
          { isMeta: true },
        )
    return yield* this.#run({ initialMessage, userInitiated: true })
  }

  async *#run(
    options: {
      initialMessage?: UserTranscriptMessage
      maxTurns?: number
      text?: string
      userInitiated?: boolean
    } = {},
  ): AsyncGenerator<AgentEvent, AgentLoopResult> {
    const abortController = this.#beginOperation()
    let generator: ReturnType<typeof runAgentLoop> | undefined
    try {
      if (options.text !== undefined || options.initialMessage) {
        const userMessage =
          options.initialMessage ??
          createUserMessage({ content: [{ text: options.text ?? '', type: 'text' }] })
        await this.#fileHistory.makeSnapshot(userMessage.uuid)
        this.#messages.push(userMessage)
        await this.#writer.recordTranscript([userMessage])
        this.#appendDisplay([userMessage])
        yield { type: 'user_message', message: userMessage }
      }
      generator = runAgentLoop({
        ...(this.#canUseTool ? { canUseTool: this.#canUseTool } : {}),
        ...(this.#contextManager ? { contextManager: this.#contextManager } : {}),
        ...(this.#identity ? { getAgentIdentity: this.#identity } : {}),
        ...(this.#inbox
          ? {
              getPendingMessages: (seen: readonly TranscriptMessage[]) =>
                this.#inbox?.peek(seen) ?? Promise.resolve([]),
            }
          : {}),
        messages: this.#messages,
        ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
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
          this.#appendDisplay([event.message])
          if (!this.#messages.some((m) => m.uuid === event.message.uuid))
            this.#messages.push(event.message)
          if (event.type === 'user_message' && event.message.agentEventKey)
            await this.#inbox?.ack([event.message.uuid])
        } else if (event.type === 'compact') {
          await this.#writer.recordCompaction(event.messages, event.compaction)
          this.#appendDisplay(event.messages)
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
      if (options.userInitiated && next.value.reason === 'completed')
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
      this.#appendDisplay(messages)
      result.commit()
      this.#messages = [...messages]
      if (result.userContext !== undefined) this.#userContext = result.userContext
    } catch (error) {
      if (abort.signal.aborted) throw new DOMException('Compaction cancelled', 'AbortError')
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
      .filter(
        (message) =>
          message.type === 'user' &&
          !message.isCompactSummary &&
          !message.isMeta &&
          message.message.content.some((b) => b.type === 'text'),
      )
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
      const displayIndex = this.#displayMessages.findIndex((m) => m.uuid === targetUuid)
      if (displayIndex >= 0)
        this.#displayMessages = this.#displayMessages.slice(0, displayIndex + 1)
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
