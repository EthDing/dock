import type { JsonObject } from '../model/types.js'
import type { PermissionDecision } from './evaluate-permission.js'
import type { AgentTool } from '../tools/types.js'

export type PermissionRequest = {
  decision: PermissionDecision
  input: JsonObject
  signal: AbortSignal
  tool: AgentTool
}

export type PermissionApproval =
  | { behavior: 'allow_once' }
  | { behavior: 'allow_session' }
  | { behavior: 'allow_always'; rule: string }
  | { behavior: 'deny' }

export class PermissionBroker {
  #handler: ((request: PermissionRequest) => Promise<PermissionApproval>) | undefined

  setHandler(handler: (request: PermissionRequest) => Promise<PermissionApproval>): void {
    this.#handler = handler
  }

  async requestApproval(
    tool: AgentTool,
    input: JsonObject,
    decision: PermissionDecision,
    signal: AbortSignal,
  ): Promise<PermissionApproval> {
    if (signal.aborted) return { behavior: 'deny' }
    const approval = this.#handler?.({ decision, input, signal, tool })
    if (!approval) return { behavior: 'deny' }
    let onAbort: (() => void) | undefined
    try {
      return await Promise.race([
        approval,
        new Promise<PermissionApproval>((resolve) => {
          onAbort = () => resolve({ behavior: 'deny' })
          signal.addEventListener('abort', onAbort, { once: true })
        }),
      ])
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }
}
