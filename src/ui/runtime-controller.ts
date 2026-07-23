import type { UUID } from 'node:crypto'
import type { AgentEvent } from '../agent/run-agent-loop.js'
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
>

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

  async *submit(text: string): AsyncIterable<AgentEvent> {
    yield* this.#controller.submit(text)
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
