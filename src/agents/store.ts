import { randomUUID, type UUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { UserTranscriptMessage } from '../messages/create-message.js'
import { asSessionId, isUuid, type SessionId } from '../sessions/ids.js'
import { getProjectSessionsDirectory, getSessionPath } from '../sessions/session-store.js'
import type { AgentMetadata } from './types.js'

export type AgentIndex = {
  version: 1
  agents: Record<string, SessionId>
  pending: UserTranscriptMessage[]
  delivered: string[]
  nameBindings: Record<string, string>
}
export class AgentStore {
  readonly #configDir: string
  readonly #cwd: string
  readonly #writes = new Map<string, Promise<void>>()
  constructor(configDir: string, cwd: string) {
    this.#configDir = configDir
    this.#cwd = cwd
  }
  location(meta: Pick<AgentMetadata, 'storageSessionId' | 'id'>) {
    return {
      configDir: this.#configDir,
      cwd: this.#cwd,
      sessionId: meta.storageSessionId,
      agentId: meta.id,
    }
  }
  transcriptPath(meta: Pick<AgentMetadata, 'storageSessionId' | 'id'>): string {
    return getSessionPath(this.location(meta))
  }
  #directory(sessionId: SessionId): string {
    asSessionId(sessionId)
    return join(
      getProjectSessionsDirectory({ configDir: this.#configDir, cwd: this.#cwd }),
      sessionId,
      'subagents',
    )
  }
  async loadIndex(sessionId: SessionId): Promise<AgentIndex> {
    try {
      const value = JSON.parse(
        await readFile(join(this.#directory(sessionId), 'index.json'), 'utf8'),
      ) as AgentIndex
      if (value.version !== 1 || !value.agents || !Array.isArray(value.pending))
        throw new Error('Invalid subagent index')
      return { ...value, delivered: value.delivered ?? [], nameBindings: value.nameBindings ?? {} }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return { version: 1, agents: {}, pending: [], delivered: [], nameBindings: {} }
      throw error
    }
  }
  saveIndex(sessionId: SessionId, index: AgentIndex): Promise<void> {
    return this.#write(join(this.#directory(sessionId), 'index.json'), index)
  }
  async load(storageSessionId: SessionId, id: string): Promise<AgentMetadata> {
    if (!isUuid(id)) throw new Error('Invalid agent ID')
    const value = JSON.parse(
      await readFile(join(this.#directory(storageSessionId), `agent-${id}.json`), 'utf8'),
    ) as AgentMetadata
    if (
      value.version !== 1 ||
      value.id !== id ||
      value.storageSessionId !== storageSessionId ||
      !Array.isArray(value.pending) ||
      !['fresh', 'fork'].includes(value.contextMode)
    )
      throw new Error('Invalid subagent metadata')
    return value
  }
  save(meta: AgentMetadata): Promise<void> {
    if (!isUuid(meta.id)) throw new Error('Invalid agent ID')
    return this.#write(join(this.#directory(meta.storageSessionId), `agent-${meta.id}.json`), meta)
  }
  #write(path: string, value: unknown): Promise<void> {
    const data = JSON.stringify(value)
    const job = (this.#writes.get(path) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        const temp = `${path}.${randomUUID()}.tmp`
        try {
          await writeFile(temp, data, { mode: 0o600 })
          await rename(temp, path)
        } finally {
          await unlink(temp).catch(() => {})
        }
      })
    this.#writes.set(path, job)
    return job
  }
}
export type AgentMessageOptions = { fromAgentId?: UUID | undefined; fromUser?: boolean | undefined }
