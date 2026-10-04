import { randomUUID, type UUID } from 'node:crypto'
import type { AssistantMessage, UserMessage } from '../model/types.js'

export type UserTranscriptMessage = {
  // Marks actual UI input in child histories, whose user role also carries
  // agent directions. Older unmarked child directions are not authorization.
  isUserSubmission?: true
  agentEventKey?: string
  isMeta?: true
  isCompactSummary?: true
  skillContext?: SkillContext
  type: 'user'
  uuid: UUID
  timestamp: string
  message: UserMessage
}

export type SkillContext = {
  contentHash: string
  location: string
  name: string
  isPartial?: boolean
  activationToolUseId?: string
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
  isUserSubmission?: true
  isMeta?: true
  isCompactSummary?: true
  skillContext?: SkillContext
  now?: () => Date
  uuid?: UUID
}

export function createUserMessage(
  input: Omit<UserMessage, 'role'>,
  options: IdentityOptions = {},
): UserTranscriptMessage {
  return {
    ...(options.isUserSubmission ? { isUserSubmission: true as const } : {}),
    ...(options.isMeta ? { isMeta: true as const } : {}),
    ...(options.isCompactSummary ? { isCompactSummary: true as const } : {}),
    ...(options.skillContext ? { skillContext: options.skillContext } : {}),
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
