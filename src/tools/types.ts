import type { UUID } from 'node:crypto'
import type { JsonObject, JsonSchema } from '../model/types.js'

export type AgentToolResult = {
  content: string
  isError?: boolean
}

export type AgentTool = {
  name: string
  description: string
  inputSchema: JsonSchema
  isConcurrencySafe: (input: JsonObject) => boolean
  execute: (
    input: JsonObject,
    options: { parentMessageUuid: UUID; signal: AbortSignal },
  ) => Promise<AgentToolResult>
}
