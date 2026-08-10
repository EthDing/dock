import { randomUUID, type UUID } from 'node:crypto'
import type { AssistantMessage, UserMessage } from '../model/types.js'

export type UserTranscriptMessage = {
  agentEventKey?: string
  isMeta?: true
  isCompactSummary?: true
  type: 'user'
  uuid: UUID
  timestamp: string
  message: UserMessage
}

export type AssistantTranscriptMessage = {
  requestTokenEstimate?: number
  type: 'assistant'
  uuid: UUID
  timestamp: string
  message: AssistantMessage
}

export type TranscriptMessage = UserTranscriptMessage | AssistantTranscriptMessage

type IdentityOptions = {
  isMeta?: true
  isCompactSummary?: true
  now?: () => Date
  uuid?: UUID
}

export function createUserMessage(
  input: Omit<UserMessage, 'role'>,
  options: IdentityOptions = {},
): UserTranscriptMessage {
  return {
    ...(options.isMeta ? { isMeta: true as const } : {}),
    ...(options.isCompactSummary ? { isCompactSummary: true as const } : {}),
    message: { ...input, role: 'user' },
    timestamp: (options.now ?? (() => new Date()))().toISOString(),
    type: 'user',
    uuid: options.uuid ?? randomUUID(),
  }
}

export function createAssistantMessage(
  message: AssistantMessage,
  options: IdentityOptions = {},
): AssistantTranscriptMessage {
  return {
    message,
    timestamp: (options.now ?? (() => new Date()))().toISOString(),
    type: 'assistant',
    uuid: options.uuid ?? randomUUID(),
  }
}
