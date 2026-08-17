import type { AgentSnapshot } from '../agents/types.js'
import { randomUUID, type UUID } from 'node:crypto'
import type { UiEvent, SessionViewInfo } from './contracts.js'
import type { AgentLoopResult } from '../agent/run-agent-loop.js'
import type { TranscriptMessage } from '../messages/create-message.js'
import type { PermissionMode } from '../permissions/evaluate-permission.js'
import type { DockUiController } from './dock-tui-app.js'

export type RuntimeSession = Required<
  Pick<
    DockUiController,
    | 'abort'
    | 'close'
    | 'compact'
    | 'contextSummary'
    | 'messages'
    | 'permissionMode'
    | 'rename'
    | 'rewind'
    | 'rewindPoints'
    | 'setPermissionMode'
    | 'submit'
  >
> &
  Pick<DockUiController, 'getSnapshot' | 'processNotifications' | 'getViewInfo' | 'displayMessages'>

export class RuntimeController implements DockUiController {
  #controller: RuntimeSession

  constructor(controller: RuntimeSession) {
    this.#controller = controller
  }

  get messages(): readonly TranscriptMessage[] {
    return this.#controller.messages
  }

  get permissionMode(): string {
    return this.#controller.permissionMode
  }

  abort(reason?: unknown): void {
    this.#controller.abort(reason)
  }

  get displayMessages(): readonly TranscriptMessage[] {
    return this.#controller.displayMessages ?? this.#controller.messages
  }
  getViewInfo(): SessionViewInfo {
    return (
      this.#controller.getViewInfo?.() ?? {
        cwd: '',
        modelReference: '',
        permissionMode: this.permissionMode,
        contextSummary: this.contextSummary(),
      }
    )
  }
  async *submit(text: string): AsyncIterable<UiEvent> {
    yield* this.#events(this.#controller.submit(text))
  }
  async *#events(source: AsyncIterable<UiEvent>): AsyncIterable<UiEvent> {
    const operationId = randomUUID(),
      sessionId = this.getViewInfo().sessionId
    const iterator = source[Symbol.asyncIterator]()
    try {
      yield { type: 'turn_start', sessionId, operationId }
      let next = await iterator.next()
      while (!next.done) {
        yield { ...next.value, sessionId, operationId }
        next = await iterator.next()
      }
      const result = next.value as AgentLoopResult | undefined
      yield {
        type: 'turn_end',
        result: {
          reason: result?.reason ?? 'completed',
          ...(result?.error ? { error: result.error } : {}),
        },
        sessionId,
        operationId,
      }
    } catch (error) {
      yield {
        type: 'turn_end',
        result: {
          reason: 'model_error',
          error: error instanceof Error ? error.message : String(error),
        },
        sessionId,
        operationId,
      }
    } finally {
      await iterator.return?.()
    }
  }

  getSnapshot(): AgentSnapshot {
    if (!this.#controller.getSnapshot) throw new Error('Agent identity unavailable')
    return this.#controller.getSnapshot()
  }
  async *processNotifications(): AsyncIterable<UiEvent> {
    if (this.#controller.processNotifications)
      yield* this.#events(this.#controller.processNotifications())
  }

  async close(): Promise<void> {
    await this.#controller.close()
  }

  async replace(factory: () => Promise<RuntimeSession>): Promise<void> {
    await this.#controller.close()
    this.#controller = await factory()
  }

  compact(instructions?: string): Promise<void> {
    return this.#controller.compact(instructions)
  }

  contextSummary(): string {
    return this.#controller.contextSummary()
  }

  rename(name: string): Promise<void> {
    return this.#controller.rename(name)
  }

  rewind(
    uuid: `${string}-${string}-${string}-${string}-${string}`,
    options: { conversation: boolean; files: boolean },
  ): Promise<void> {
    return this.#controller.rewind(uuid as UUID, options)
  }

  rewindPoints(): Array<{
    label: string
    uuid: `${string}-${string}-${string}-${string}-${string}`
  }> {
    return this.#controller.rewindPoints()
  }

  setPermissionMode(mode: PermissionMode): void {
    this.#controller.setPermissionMode(mode)
  }
}
