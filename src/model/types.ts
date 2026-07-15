export type JsonObject = Record<string, unknown>
export type JsonSchema = Record<string, unknown>

export type TextBlock = {
  type: 'text'
  text: string
}

export type ThinkingBlock = {
  type: 'thinking'
  thinking: string
}

export type ToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: JsonObject
}

export type ToolResultBlock = {
  type: 'tool_result'
  toolUseId: string
  content: string
  isError?: boolean
}

export type UserMessage = {
  role: 'user'
  content: readonly (TextBlock | ToolResultBlock)[]
}

export type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use'

export type Usage = {
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}

export type AssistantMessage = {
  role: 'assistant'
  id: string
  content: readonly (TextBlock | ThinkingBlock | ToolUseBlock)[]
  stopReason: StopReason
  usage: Usage
}

export type ModelMessage = UserMessage | AssistantMessage

export type ModelToolDefinition = {
  name: string
  description: string
  inputSchema: JsonSchema
}

export type ModelRequest = {
  modelId: string
  systemPrompt: readonly string[]
  messages: readonly ModelMessage[]
  tools: readonly ModelToolDefinition[]
}

export type ModelStreamEvent =
  | { type: 'message_start'; messageId: string }
  | {
      type: 'content_block_start'
      index: number
      block:
        | { type: 'text' }
        | { type: 'thinking' }
        | { type: 'tool_use'; id: string; name: string }
    }
  | {
      type: 'content_block_delta'
      index: number
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'input_json_delta'; partialJson: string }
    }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; stopReason: StopReason; usage: Usage }
  | { type: 'message_stop' }

export type ModelStreamOptions = {
  signal: AbortSignal
}

export interface ModelAdapter {
  stream(request: ModelRequest, options: ModelStreamOptions): AsyncIterable<ModelStreamEvent>
}
