import type { JsonObject } from '../model/types.js'
import type { PermissionDecision } from './evaluate-permission.js'
import type { AgentTool } from '../tools/types.js'

export type PermissionRequest = {
  decision: PermissionDecision
  input: JsonObject
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
  ): Promise<boolean> {
    return (await this.#handler?.({ decision, input, tool })) ?? false
  }
}
