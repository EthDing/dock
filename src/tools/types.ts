import type { UUID } from 'node:crypto'
import type { JsonObject, JsonSchema } from '../model/types.js'
import type { PermissionSubject } from '../permissions/evaluate-permission.js'

export type AgentToolResult = {
  content: string
  isError?: boolean
}

export type AgentTool = {
  name: string
  description: string
  inputSchema: JsonSchema
  getPermissionSubject?: (input: JsonObject) => PermissionSubject
  isConcurrencySafe: (input: JsonObject) => boolean
  execute: (
    input: JsonObject,
    options: { parentMessageUuid: UUID; signal: AbortSignal },
  ) => Promise<AgentToolResult>
}

export type ToolUseDecision = { behavior: 'allow' } | { behavior: 'deny'; message: string }

export type CanUseTool = (
  tool: AgentTool,
  input: JsonObject,
  options: { parentMessageUuid: UUID; toolUseId: string },
) => Promise<ToolUseDecision>
