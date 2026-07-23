import type { JsonObject } from '../model/types.js'
import type { PermissionDecision } from './evaluate-permission.js'
import type { AgentTool } from '../tools/types.js'

export type PermissionRequest = {
  decision: PermissionDecision
  input: JsonObject
  signal: AbortSignal
  tool: AgentTool
}

export class PermissionBroker {
  #handler: ((request: PermissionRequest) => Promise<boolean>) | undefined

  setHandler(handler: (request: PermissionRequest) => Promise<boolean>): void {
    this.#handler = handler
  }

  async requestApproval(
    tool: AgentTool,
    input: JsonObject,
    decision: PermissionDecision,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) return false
    const approval = this.#handler?.({ decision, input, signal, tool })
    if (!approval) return false
    let onAbort: (() => void) | undefined
    try {
      return await Promise.race([
        approval,
        new Promise<boolean>((resolve) => {
          onAbort = () => resolve(false)
          signal.addEventListener('abort', onAbort, { once: true })
        }),
      ])
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }
}
