import type { AgentEvent } from '../agent/run-agent-loop.js'
import type { UUID } from 'node:crypto'
import type { TranscriptMessage, UserTranscriptMessage } from '../messages/create-message.js'
import type { ModelToolDefinition, Usage } from '../model/types.js'
import type { SessionId } from '../sessions/ids.js'
import type { FileReadState } from '../tools/file-read-state.js'
import type { AgentWorktree } from './worktrees.js'

export type AgentContextMode = 'fresh' | 'fork'
export type AgentSnapshot = {
  sessionId: SessionId
  agentId?: UUID | undefined
  parentAgentId?: UUID | undefined
  depth: number
  contextMode: AgentContextMode | 'main'
  cwd: string
  modelReference: string
  systemPrompt: readonly string[]
  userContext?: Readonly<Record<string, string>> | undefined
  tools: readonly ModelToolDefinition[]
  messages: readonly TranscriptMessage[]
  maxOutputTokens?: number | undefined
  fileReadState?: FileReadState | undefined
}
export type AgentSpawnInput = {
  prompt: string
  description: string
  context?: AgentContextMode | undefined
  name?: string | undefined
  model?: string | undefined
  isolation?: 'worktree' | undefined
}
export type AgentStatus = 'starting' | 'running' | 'completed' | 'failed' | 'stopped'
export type AgentMetadata = {
  version: 1
  id: UUID
  storageSessionId: SessionId
  sessionId: SessionId
  parentAgentId?: UUID | undefined
  depth: number
  contextMode: AgentContextMode
  name?: string | undefined
  description: string
  modelReference: string
  cwd: string
  systemPrompt: readonly string[]
  userContext?: Readonly<Record<string, string>> | undefined
  toolDefinitions?: readonly ModelToolDefinition[] | undefined
  worktree?: AgentWorktree | undefined
  worktreeRemoved?: boolean | undefined
  status: AgentStatus
  stoppedBy?: 'user' | 'model' | 'shutdown' | undefined
  background: boolean
  runId: UUID
  pid: number
  pending: UserTranscriptMessage[]
  report?: string | undefined
  error?: string | undefined
  usage?: Usage | undefined
  createdAt: string
  updatedAt: string
  notifiedRunId?: UUID | undefined
}
export type AgentView = Pick<
  AgentMetadata,
  | 'id'
  | 'cwd'
  | 'modelReference'
  | 'runId'
  | 'sessionId'
  | 'parentAgentId'
  | 'depth'
  | 'contextMode'
  | 'name'
  | 'description'
  | 'status'
  | 'background'
  | 'report'
  | 'error'
  | 'stoppedBy'
  | 'worktree'
> & { outputFile: string }
export type AgentUiUpdate = {
  sessionId: SessionId
  agentId: UUID
  runId: UUID
  sequence: number
  agent: AgentView
  event?: AgentEvent
}
