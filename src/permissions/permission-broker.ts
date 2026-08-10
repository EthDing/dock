import type { JsonObject } from '../model/types.js'
import type { PermissionDecision } from './evaluate-permission.js'
import type { AgentTool } from '../tools/types.js'

export type PermissionRequester = { agentId: string; label: string }
export type PermissionRequest = {
  decision: PermissionDecision
  input: JsonObject
  signal: AbortSignal
  tool: AgentTool
  requester?: PermissionRequester
}
export type PermissionApproval =
  | { behavior: 'allow_once' }
  | { behavior: 'allow_session' }
  | { behavior: 'allow_always'; rule: string }
  | { behavior: 'deny' }

export class PermissionBroker {
  #handler: ((request: PermissionRequest) => Promise<PermissionApproval>) | undefined
  #tail: Promise<void> = Promise.resolve()
  setHandler(handler: (request: PermissionRequest) => Promise<PermissionApproval>): void {
    this.#handler = handler
  }
  async requestApproval(
    tool: AgentTool,
    input: JsonObject,
    decision: PermissionDecision,
    signal: AbortSignal,
    requester?: PermissionRequester,
  ): Promise<PermissionApproval> {
    if (signal.aborted) return { behavior: 'deny' }
    let onAbort!: () => void
    const aborted = new Promise<PermissionApproval>((resolve) => {
      onAbort = () => resolve({ behavior: 'deny' })
      signal.addEventListener('abort', onAbort, { once: true })
    })
    const job = this.#tail.then(async (): Promise<PermissionApproval> => {
      if (signal.aborted) return { behavior: 'deny' }
      const approval = this.#handler?.({
        tool,
        input,
        decision,
        signal,
        ...(requester ? { requester } : {}),
      })
      return approval ? Promise.race([approval, aborted]) : { behavior: 'deny' }
    })
    this.#tail = job.then(
      () => {},
      () => {},
    )
    try {
      return await Promise.race([job, aborted])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
}
