import type { AgentEvent, AgentLoopResult } from '../agent/run-agent-loop.js'
import type { TranscriptMessage } from '../messages/create-message.js'
import type { AssistantMessage, UserMessage } from '../model/types.js'
import type { SessionId } from '../sessions/ids.js'

export const HEADLESS_SCHEMA_VERSION = 1 as const

export function safeHeadlessText(value: string): string {
  return Array.from(stripVTControlCharacters(value), (character) => {
    const code = character.codePointAt(0) ?? 0
    return (code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159) ? '' : character
  }).join('')
}

export type HeadlessResult =
  | {
      schema_version: 1
      type: 'result'
      subtype: 'success'
      is_error: false
      session_id: SessionId
      result: string
    }
  | {
      schema_version: 1
      type: 'result'
      subtype: 'error_aborted' | 'error_during_execution' | 'error_max_turns'
      is_error: true
      session_id: SessionId
      error: string
    }

export type HeadlessStreamEvent =
  | {
      schema_version: 1
      type: 'system'
      subtype: 'init'
      session_id: SessionId
      cwd: string
      model: string
      permission_mode: string
    }
  | {
      schema_version: 1
      type: 'assistant' | 'user'
      session_id: SessionId
      uuid: string
      message:
        | UserMessage
        | (Omit<AssistantMessage, 'stopReason' | 'usage'> & {
            stop_reason: AssistantMessage['stopReason']
          })
    }
  | {
      schema_version: 1
      type: 'system'
      subtype: 'compact' | 'compaction_status' | 'tool_results_cleared'
      session_id: SessionId
      status?: string
      message?: string
      tool_use_ids?: readonly string[]
    }
  | HeadlessResult

export function finalText(messages: readonly TranscriptMessage[]): string {
  const assistant = messages.findLast((message) => message.type === 'assistant')
  if (assistant?.type !== 'assistant') return ''
  return assistant.message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

export function createInitEvent(options: {
  sessionId: SessionId
  cwd: string
  model: string
  permissionMode: string
}): HeadlessStreamEvent {
  return {
    schema_version: HEADLESS_SCHEMA_VERSION,
    type: 'system',
    subtype: 'init',
    session_id: options.sessionId,
    cwd: options.cwd,
    model: options.model,
    permission_mode: options.permissionMode,
  }
}

export function resultForLoop(
  result: AgentLoopResult,
  options: { sessionId: SessionId; result: string },
): HeadlessResult {
  if (result.reason === 'completed') {
    return {
      schema_version: HEADLESS_SCHEMA_VERSION,
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: options.sessionId,
      result: options.result,
    }
  }
  const subtype =
    result.reason === 'max_turns'
      ? 'error_max_turns'
      : result.reason === 'aborted'
        ? 'error_aborted'
        : 'error_during_execution'
  return {
    schema_version: HEADLESS_SCHEMA_VERSION,
    type: 'result',
    subtype,
    is_error: true,
    session_id: options.sessionId,
    error:
      result.error ??
      (result.reason === 'max_turns'
        ? 'Maximum tool-use turns reached before completion'
        : result.reason === 'aborted'
          ? 'Execution aborted'
          : 'Model execution failed'),
  }
}

export function streamEventForAgentEvent(
  event: AgentEvent,
  sessionId: SessionId,
): HeadlessStreamEvent | undefined {
  if (event.type === 'assistant_message' || event.type === 'user_message') {
    return {
      schema_version: HEADLESS_SCHEMA_VERSION,
      type: event.type === 'assistant_message' ? 'assistant' : 'user',
      session_id: sessionId,
      uuid: event.message.uuid,
      message:
        event.message.type === 'assistant'
          ? {
              role: event.message.message.role,
              id: event.message.message.id,
              content: event.message.message.content,
              stop_reason: event.message.message.stopReason,
            }
          : event.message.message,
    }
  }
  if (event.type === 'compact') {
    return {
      schema_version: HEADLESS_SCHEMA_VERSION,
      type: 'system',
      subtype: 'compact',
      session_id: sessionId,
    }
  }
  if (event.type === 'tool_results_cleared') {
    return {
      schema_version: HEADLESS_SCHEMA_VERSION,
      type: 'system',
      subtype: 'tool_results_cleared',
      session_id: sessionId,
      tool_use_ids: event.toolUseIds,
    }
  }
  if (event.type === 'compaction_status') {
    return {
      schema_version: HEADLESS_SCHEMA_VERSION,
      type: 'system',
      subtype: 'compaction_status',
      session_id: sessionId,
      status: event.status,
      ...(event.message ? { message: event.message } : {}),
    }
  }
  return undefined
}
import { stripVTControlCharacters } from 'node:util'
