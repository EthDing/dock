import type { UUID } from 'node:crypto'
import type { AgentEvent, AgentLoopResult } from '../agent/run-agent-loop.js'
import type { SessionId } from '../sessions/ids.js'
export type UiEvent = (
  | AgentEvent
  | { type: 'turn_start' }
  | { type: 'turn_end'; result: Pick<AgentLoopResult, 'reason' | 'error'> }
) & {
  sessionId?: SessionId | undefined
  operationId?: UUID | undefined
}
export type SessionViewInfo = {
  sessionId?: SessionId | undefined
  modelReference: string
  cwd: string
  permissionMode: string
  contextSummary: string
}
