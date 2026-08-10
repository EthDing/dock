import type { UUID } from 'node:crypto'
import type { AgentSnapshot } from '../agents/types.js'
import type { JsonObject, JsonSchema } from '../model/types.js'
import type { PermissionResult, ToolPermissionContext } from '../permissions/evaluate-permission.js'

export type AgentToolResult = {
  content: string
  isError?: boolean
}

export type ToolExecutionContext = {
  parentMessageUuid: UUID
  signal: AbortSignal
  toolUseId: string
  agent?: AgentSnapshot | undefined
}

export type AgentTool = {
  name: string
  description: string
  inputSchema: JsonSchema
  checkPermissions?: (
    input: JsonObject,
    context: ToolPermissionContext,
  ) => Promise<PermissionResult> | PermissionResult
  getPermissionRule?: (input: JsonObject) => string | undefined
  isConcurrencySafe: (input: JsonObject) => boolean
  parseInput?: (input: JsonObject) => JsonObject
  execute: (input: JsonObject, options: ToolExecutionContext) => Promise<AgentToolResult>
}

export type ToolUseDecision =
  | { behavior: 'allow'; updatedInput?: JsonObject }
  | { behavior: 'deny'; message: string }

export type CanUseTool = (
  tool: AgentTool,
  input: JsonObject,
  options: ToolExecutionContext,
) => Promise<ToolUseDecision>
