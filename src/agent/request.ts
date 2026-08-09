import type { TranscriptMessage } from '../messages/create-message.js'
import type { ModelMessage, ModelRequest, ModelToolDefinition } from '../model/types.js'

export type RequestContext = {
  modelId: string
  systemPrompt: readonly string[]
  tools: readonly ModelToolDefinition[]
  maxOutputTokens?: number
  userContext?: Readonly<Record<string, string>>
}

export function buildUserContextMessages(
  context?: Readonly<Record<string, string>>,
): ModelMessage[] {
  if (!context || Object.keys(context).length === 0) return []
  const content = Object.entries(context)
    .map(([key, value]) => `# ${key}\n${value}`)
    .join('\n')
  return [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `<system-reminder>\nAs you answer the user's questions, you can use the following context:\n${content}\n\nIMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>`,
        },
      ],
    },
  ]
}

export function buildModelRequest(
  messages: readonly TranscriptMessage[],
  context: RequestContext,
): ModelRequest {
  return {
    modelId: context.modelId,
    systemPrompt: context.systemPrompt,
    tools: context.tools,
    ...(context.maxOutputTokens ? { maxOutputTokens: context.maxOutputTokens } : {}),
    messages: [
      ...buildUserContextMessages(context.userContext),
      ...messages.map((message) => message.message),
    ],
  }
}

export function roughRequestTokens(
  request: Pick<ModelRequest, 'messages' | 'systemPrompt' | 'tools'>,
): number {
  return Math.ceil(
    JSON.stringify({
      systemPrompt: request.systemPrompt,
      tools: request.tools,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    }).length / 4,
  )
}
