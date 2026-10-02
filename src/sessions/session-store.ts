import { createHash, type UUID } from 'node:crypto'
import { type FileHandle, mkdir, open, readFile, rmdir, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { FileHistorySnapshot } from '../checkpoint/file-history.js'
import type { CompactionResult } from '../context/compaction.js'
import { applyClearedToolResults } from '../context/tool-result-clearing.js'
import type { TranscriptMessage } from '../messages/create-message.js'
import { buildDisplayHistory, resolveDisplayHistory } from './display-history.js'
import { asSessionId, isUuid, type SessionId } from './ids.js'

export type SessionMetadataRecord = {
  agentId?: UUID
  agentCwd?: string
  parentAgentId?: UUID
  type: 'session_start'
  version: 1
  sessionId: SessionId
  cwd: string
  createdAt: string
  forkedFromSessionId?: SessionId
  name?: string
}

export type SessionMessageRecord = TranscriptMessage & {
  compactionId?: UUID
  parentUuid: UUID | null
  sessionId: SessionId
  cwd: string
}

export type SessionNameRecord = {
  type: 'session_name'
  name: string
  timestamp: string
}

export type SessionRewindRecord = {
  type: 'rewind'
  targetUuid: UUID
  timestamp: string
}

export type FileHistorySnapshotRecord = {
  type: 'file-history-snapshot'
  isSnapshotUpdate: boolean
  messageId: UUID
  snapshot: {
    messageId: UUID
    timestamp: string
    trackedFileBackups: Record<
      string,
      { backupFileName: string | null; backupTime: string; version: number }
    >
  }
}

export type SessionToolResultClearRecord = {
  type: 'tool_result_clear'
  toolUseIds: string[]
  timestamp: string
}

export type SessionCompactRecord = {
  compactionId?: UUID
  metadata?: Pick<
    CompactionResult,
    'usage' | 'trigger' | 'preTokens' | 'postTokens' | 'skillRestoration' | 'evalCompactAfter'
  >
  type: 'compact_boundary'
  preservedUuids: UUID[]
  summaryUuid: UUID
  timestamp: string
}

export type SessionRecord =
  | SessionMetadataRecord
  | SessionMessageRecord
  | SessionNameRecord
  | SessionRewindRecord
  | FileHistorySnapshotRecord
  | SessionCompactRecord
  | SessionToolResultClearRecord
  | { type: 'eval_compaction_trigger'; after: number; timestamp: string }

export type LoadedSession = {
  displayMessages: readonly TranscriptMessage[]
  fileHistorySnapshots: readonly FileHistorySnapshot[]
  headUuid: UUID | null
  messages: readonly TranscriptMessage[]
  metadata: SessionMetadataRecord
  name?: string
  records: readonly SessionRecord[]
  truncatedTail: boolean
}

type SessionLocation = {
  agentId?: UUID
  configDir: string
  cwd: string
  sessionId: SessionId
}

type WriterOptions = SessionLocation & {
  agentCwd?: string
  parentAgentId?: UUID
  forkedFromSessionId?: SessionId
  name?: string
  now?: () => Date
}

export class SessionWriter {
  get path(): string {
    return this.#lockPath.slice(0, -'.lock'.length)
  }
  readonly #file: FileHandle
  readonly #lock: FileHandle
  readonly #lockPath: string
  readonly #now: () => Date
  readonly #cwd: string
  readonly #sessionId: SessionId
  readonly #messageUuids: Set<UUID>
  #closed = false
  #headUuid: UUID | null

  private constructor(options: {
    file: FileHandle
    cwd: string
    headUuid: UUID | null
    lock: FileHandle
    lockPath: string
    messageUuids: Set<UUID>
    now: () => Date
    sessionId: SessionId
  }) {
    this.#file = options.file
    this.#cwd = options.cwd
    this.#headUuid = options.headUuid
    this.#lock = options.lock
    this.#lockPath = options.lockPath
    this.#messageUuids = options.messageUuids
    this.#now = options.now
    this.#sessionId = options.sessionId
  }

  static async create(options: WriterOptions): Promise<SessionWriter> {
    const sessionPath = getSessionPath(options)
    await mkdir(dirname(sessionPath), { recursive: true, mode: 0o700 })
    const { handle: lock, path: lockPath } = await acquireLock(sessionPath)

    let file: FileHandle | undefined
    try {
      file = await open(sessionPath, 'wx', 0o600)
      const now = options.now ?? (() => new Date())
      const metadata: SessionMetadataRecord = {
        ...(options.agentId ? { agentId: options.agentId } : {}),
        ...(options.agentCwd ? { agentCwd: options.agentCwd } : {}),
        ...(options.parentAgentId ? { parentAgentId: options.parentAgentId } : {}),
        createdAt: now().toISOString(),
        cwd: resolve(options.cwd),
        ...(options.forkedFromSessionId
          ? { forkedFromSessionId: options.forkedFromSessionId }
          : {}),
        ...(options.name ? { name: options.name } : {}),
        sessionId: options.sessionId,
        type: 'session_start',
        version: 1,
      }
      await appendAndSync(file, metadata)
      return new SessionWriter({
        cwd: metadata.cwd,
        file,
        headUuid: null,
        lock,
        lockPath,
        messageUuids: new Set(),
        now,
        sessionId: options.sessionId,
      })
    } catch (error) {
      await file?.close()
      await releaseLock(lock, lockPath)
      throw error
    }
  }

  static async open(options: WriterOptions): Promise<SessionWriter> {
    const sessionPath = getSessionPath(options)
    const { handle: lock, path: lockPath } = await acquireLock(sessionPath)

    let file: FileHandle | undefined
    try {
      const loaded = await loadSession(options)
      file = await open(sessionPath, 'a', 0o600)
      const existingBytes = await readFile(sessionPath)
      if (loaded.truncatedTail) {
        // Remove only the incomplete final record before appending new JSONL.
        await file.truncate(existingBytes.lastIndexOf(10) + 1)
        await file.sync()
      } else if (existingBytes.length && existingBytes.at(-1) !== 10) {
        await file.write('\n')
        await file.sync()
      }
      return new SessionWriter({
        cwd: loaded.metadata.cwd,
        file,
        headUuid: loaded.headUuid,
        lock,
        lockPath,
        messageUuids: new Set(
          committedMessageRecords(loaded.records).map((message) => message.uuid),
        ),
        now: options.now ?? (() => new Date()),
        sessionId: options.sessionId,
      })
    } catch (error) {
      await file?.close()
      await releaseLock(lock, lockPath)
      throw error
    }
  }

  async recordTranscript(messages: readonly TranscriptMessage[]): Promise<UUID | null> {
    this.#assertOpen()
    for (const message of messages) {
      if (this.#messageUuids.has(message.uuid)) {
        this.#headUuid = message.uuid
        continue
      }
      // Message identity belongs to the creation layer. Storage only links the
      // supplied UUID onto the current head; generating one here would split the
      // in-memory and persisted conversation identities.
      const record: SessionMessageRecord = {
        parentUuid: this.#headUuid,
        ...message,
        cwd: this.#cwd,
        sessionId: this.#sessionId,
      }
      await appendAndSync(this.#file, record)
      this.#messageUuids.add(message.uuid)
      this.#headUuid = message.uuid
    }
    return this.#headUuid
  }

  async rename(name: string): Promise<void> {
    this.#assertOpen()
    const normalized = name.trim()
    if (!normalized) throw new Error('Session name must not be empty')
    await appendAndSync(this.#file, {
      name: normalized,
      timestamp: this.#now().toISOString(),
      type: 'session_name',
    })
  }

  async rewindConversation(targetUuid: UUID): Promise<void> {
    this.#assertOpen()
    if (!this.#messageUuids.has(targetUuid)) {
      throw new Error(`Cannot rewind to unknown message UUID ${targetUuid}`)
    }
    await appendAndSync(this.#file, {
      targetUuid,
      timestamp: this.#now().toISOString(),
      type: 'rewind',
    })
    this.#headUuid = targetUuid
  }

  async recordFileHistorySnapshot(
    snapshot: FileHistorySnapshot,
    isSnapshotUpdate: boolean,
  ): Promise<void> {
    this.#assertOpen()
    await appendAndSync(this.#file, {
      isSnapshotUpdate,
      messageId: snapshot.messageId,
      snapshot: {
        messageId: snapshot.messageId,
        timestamp: snapshot.timestamp.toISOString(),
        trackedFileBackups: Object.fromEntries(
          Object.entries(snapshot.trackedFileBackups).map(([path, backup]) => [
            path,
            { ...backup, backupTime: backup.backupTime.toISOString() },
          ]),
        ),
      },
      type: 'file-history-snapshot',
    })
  }

  async recordToolResultClearing(toolUseIds: readonly string[]): Promise<void> {
    this.#assertOpen()
    if (!toolUseIds.length) return
    await appendAndSync(this.#file, {
      type: 'tool_result_clear',
      toolUseIds: [...new Set(toolUseIds)],
      timestamp: this.#now().toISOString(),
    })
  }

  async recordCompaction(
    messages: readonly TranscriptMessage[],
    metadata?: CompactionResult,
  ): Promise<void> {
    this.#assertOpen()
    const [summary, ...preserved] = messages
    if (summary?.type !== 'user' || !summary.isCompactSummary)
      throw new Error('Compaction must begin with a compact summary message')
    const compactionId = summary.uuid
    let parentUuid: UUID | null = null
    // Staged messages cannot become the conversation head until the boundary is
    // synced. A crash between these writes leaves the previous conversation intact.
    for (const message of messages) {
      if (!this.#messageUuids.has(message.uuid)) {
        await appendAndSync(this.#file, {
          ...message,
          parentUuid,
          compactionId,
          cwd: this.#cwd,
          sessionId: this.#sessionId,
        })
      }
      parentUuid = message.uuid
    }
    await appendAndSync(this.#file, {
      type: 'compact_boundary',
      compactionId,
      summaryUuid: summary.uuid,
      preservedUuids: preserved.map((message) => message.uuid),
      timestamp: this.#now().toISOString(),
      ...(metadata
        ? {
            metadata: {
              usage: metadata.usage,
              trigger: metadata.trigger,
              ...(metadata.preTokens !== undefined ? { preTokens: metadata.preTokens } : {}),
              ...(metadata.postTokens !== undefined ? { postTokens: metadata.postTokens } : {}),
              ...(metadata.skillRestoration ? { skillRestoration: metadata.skillRestoration } : {}),
              ...(metadata.evalCompactAfter !== undefined
                ? { evalCompactAfter: metadata.evalCompactAfter }
                : {}),
            },
          }
        : {}),
    })
    for (const message of messages) this.#messageUuids.add(message.uuid)
    this.#headUuid = parentUuid
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#file.close()
    await releaseLock(this.#lock, this.#lockPath)
  }

  async recordEvalCompactionTrigger(after: number): Promise<void> {
    this.#assertOpen()
    await appendAndSync(this.#file, {
      type: 'eval_compaction_trigger',
      after,
      timestamp: this.#now().toISOString(),
    })
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Session writer is closed')
  }
}

export async function loadSession(location: SessionLocation): Promise<LoadedSession> {
  const loaded = await readSession(location)
  loaded.displayMessages = await resolveDisplayHistory(loaded.records, async (sessionId) => {
    try {
      return (await readSession({ configDir: location.configDir, cwd: location.cwd, sessionId }))
        .records
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined
      throw error
    }
  })
  return loaded
}

async function readSession(location: SessionLocation): Promise<LoadedSession> {
  const sessionPath = getSessionPath(location)
  const contents = await readFile(sessionPath, 'utf8')
  const hasCompleteFinalLine = contents.endsWith('\n')
  const lines = contents.split('\n')
  if (lines.at(-1) === '') lines.pop()

  const records: SessionRecord[] = []
  let truncatedTail = false
  for (const [index, line] of lines.entries()) {
    if (!line) continue
    let value: unknown
    try {
      value = JSON.parse(line) as unknown
    } catch (error) {
      if (index === lines.length - 1 && !hasCompleteFinalLine) {
        truncatedTail = true
        break
      }
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Invalid session JSONL at ${sessionPath}:${index + 1}: ${detail}`)
    }
    records.push(parseSessionRecord(value, sessionPath, index + 1))
  }

  const metadata = records[0]
  if (metadata?.type !== 'session_start') {
    throw new Error(`Session ${sessionPath} is missing its session_start record`)
  }

  const { headUuid, messages } = buildActiveConversation(records)
  return {
    displayMessages: buildDisplayHistory(records),
    fileHistorySnapshots: collectFileHistorySnapshots(records),
    headUuid,
    messages,
    metadata,
    ...(() => {
      const renamed = [...records]
        .reverse()
        .find((record): record is SessionNameRecord => record.type === 'session_name')?.name
      const name = renamed ?? metadata.name
      return name ? { name } : {}
    })(),
    records,
    truncatedTail,
  }
}

export function getSessionPath(location: SessionLocation): string {
  if (location.agentId) {
    if (!isUuid(location.agentId)) throw new Error('Invalid agent ID')
    return join(
      getProjectSessionsDirectory(location),
      location.sessionId,
      'subagents',
      `agent-${location.agentId}.jsonl`,
    )
  }
  return join(getProjectSessionsDirectory(location), `${location.sessionId}.jsonl`)
}

export function getProjectSessionsDirectory(
  location: Pick<SessionLocation, 'configDir' | 'cwd'>,
): string {
  return join(resolve(location.configDir), 'projects', encodeProjectPath(location.cwd))
}

export function encodeProjectPath(cwd: string): string {
  const absolutePath = resolve(cwd)
  const encoded = absolutePath.replace(/[^a-zA-Z0-9]/g, '-')
  if (encoded.length <= 200) return encoded
  const hash = createHash('sha256').update(absolutePath).digest('hex').slice(0, 16)
  return `${encoded.slice(0, 183)}-${hash}`
}

async function acquireLock(
  sessionPath: string,
  recovered = false,
): Promise<{ handle: FileHandle; path: string }> {
  const lockPath = `${sessionPath}.lock`
  let handle: FileHandle
  try {
    handle = await open(lockPath, 'wx', 0o600)
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error
    if (recovered) throw new Error(`Session ${sessionPath} is already open`)
    const guard = `${lockPath}.recovery`
    try {
      await mkdir(guard)
    } catch {
      throw new Error(`Session ${sessionPath} is already open`)
    }
    try {
      // Recover only an unequivocally dead owner. Unknown or live PIDs retain the lock.
      const owner = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: number }
      if (!Number.isSafeInteger(owner.pid) || !owner.pid || owner.pid <= 0)
        throw new Error('Invalid session lock owner')
      let dead = false
      try {
        process.kill(owner.pid, 0)
      } catch (error) {
        dead = isNodeError(error) && error.code === 'ESRCH'
      }
      if (!dead) throw new Error(`Session ${sessionPath} is already open`)
      await unlink(lockPath)
      return await acquireLock(sessionPath, true)
    } finally {
      await rmdir(guard)
    }
  }
  try {
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
    )
    await handle.sync()
    return { handle, path: lockPath }
  } catch (error) {
    await handle.close()
    await unlink(lockPath)
    throw error
  }
}

async function releaseLock(handle: FileHandle, lockPath: string): Promise<void> {
  await handle.close()
  try {
    await unlink(lockPath)
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error
  }
}

async function appendAndSync(file: FileHandle, record: SessionRecord): Promise<void> {
  await file.write(`${JSON.stringify(record)}\n`)
  await file.sync()
}

function parseSessionRecord(value: unknown, path: string, line: number): SessionRecord {
  if (!isObject(value) || typeof value.type !== 'string') {
    throw new Error(`Invalid session record at ${path}:${line}`)
  }
  if (value.type === 'session_start') {
    if (
      value.version !== 1 ||
      typeof value.sessionId !== 'string' ||
      typeof value.cwd !== 'string' ||
      typeof value.createdAt !== 'string' ||
      (value.forkedFromSessionId !== undefined && typeof value.forkedFromSessionId !== 'string') ||
      (value.name !== undefined && typeof value.name !== 'string')
    ) {
      throw new Error(`Invalid session_start record at ${path}:${line}`)
    }
    return {
      ...(value as Omit<SessionMetadataRecord, 'forkedFromSessionId' | 'sessionId'>),
      ...(typeof value.forkedFromSessionId === 'string'
        ? { forkedFromSessionId: asSessionId(value.forkedFromSessionId) }
        : {}),
      sessionId: asSessionId(value.sessionId),
    }
  }
  if (value.type === 'user' || value.type === 'assistant') {
    if (
      typeof value.uuid !== 'string' ||
      !isUuid(value.uuid) ||
      (value.parentUuid !== null &&
        (typeof value.parentUuid !== 'string' || !isUuid(value.parentUuid))) ||
      typeof value.timestamp !== 'string' ||
      !isObject(value.message) ||
      typeof value.sessionId !== 'string' ||
      !isUuid(value.sessionId) ||
      typeof value.cwd !== 'string'
    ) {
      throw new Error(`Invalid message record at ${path}:${line}`)
    }
    return value as SessionMessageRecord
  }
  if (value.type === 'session_name') {
    if (
      typeof value.name !== 'string' ||
      !value.name.trim() ||
      typeof value.timestamp !== 'string'
    ) {
      throw new Error(`Invalid session_name record at ${path}:${line}`)
    }
    return value as SessionNameRecord
  }
  if (value.type === 'rewind') {
    if (
      typeof value.targetUuid !== 'string' ||
      !isUuid(value.targetUuid) ||
      typeof value.timestamp !== 'string'
    ) {
      throw new Error(`Invalid rewind record at ${path}:${line}`)
    }
    return value as SessionRewindRecord
  }
  if (value.type === 'file-history-snapshot') {
    if (
      typeof value.messageId !== 'string' ||
      !isUuid(value.messageId) ||
      typeof value.isSnapshotUpdate !== 'boolean' ||
      !isObject(value.snapshot)
    ) {
      throw new Error(`Invalid file-history-snapshot record at ${path}:${line}`)
    }
    return value as FileHistorySnapshotRecord
  }
  if (value.type === 'tool_result_clear') {
    if (
      !Array.isArray(value.toolUseIds) ||
      !value.toolUseIds.every((id) => typeof id === 'string') ||
      typeof value.timestamp !== 'string'
    )
      throw new Error(`Invalid tool_result_clear record at ${path}:${line}`)
    return value as SessionToolResultClearRecord
  }
  if (value.type === 'eval_compaction_trigger') {
    if (
      !Number.isSafeInteger(value.after) ||
      Number(value.after) <= 0 ||
      typeof value.timestamp !== 'string'
    )
      throw new Error(`Invalid eval_compaction_trigger record at ${path}:${line}`)
    return value as Extract<SessionRecord, { type: 'eval_compaction_trigger' }>
  }
  if (value.type === 'compact_boundary') {
    if (
      typeof value.summaryUuid !== 'string' ||
      !isUuid(value.summaryUuid) ||
      !Array.isArray(value.preservedUuids) ||
      !value.preservedUuids.every((uuid) => typeof uuid === 'string' && isUuid(uuid)) ||
      typeof value.timestamp !== 'string'
    ) {
      throw new Error(`Invalid compact_boundary record at ${path}:${line}`)
    }
    return value as SessionCompactRecord
  }
  throw new Error(`Unknown session record type ${value.type} at ${path}:${line}`)
}

function isSessionMessageRecord(record: SessionRecord): record is SessionMessageRecord {
  return record.type === 'user' || record.type === 'assistant'
}

function committedMessageRecords(records: readonly SessionRecord[]): SessionMessageRecord[] {
  const commits = new Set(
    records.flatMap((record) =>
      record.type === 'compact_boundary' && record.compactionId ? [record.compactionId] : [],
    ),
  )
  return records.filter(
    (record): record is SessionMessageRecord =>
      isSessionMessageRecord(record) && (!record.compactionId || commits.has(record.compactionId)),
  )
}

function buildActiveConversation(records: readonly SessionRecord[]): {
  headUuid: UUID | null
  messages: readonly TranscriptMessage[]
} {
  const committed = committedMessageRecords(records)
  const byUuid = new Map(committed.map((message) => [message.uuid, message]))
  const boundaries: SessionCompactRecord[] = []
  const cleared = new Set<string>()
  let headUuid: UUID | null = null
  for (const record of records) {
    if (isSessionMessageRecord(record)) {
      if (!record.compactionId) headUuid = record.uuid
    } else if (record.type === 'rewind') headUuid = record.targetUuid
    else if (record.type === 'compact_boundary') {
      const ids = [record.summaryUuid, ...record.preservedUuids]
      if (!ids.every((id) => byUuid.has(id))) throw new Error('Missing compacted message')
      boundaries.push(record)
      headUuid = ids.at(-1) ?? null
    } else if (record.type === 'tool_result_clear') {
      for (const id of record.toolUseIds) cleared.add(id)
    }
  }
  const chain: SessionMessageRecord[] = []
  const visited = new Set<UUID>()
  let current = headUuid
  while (current) {
    if (visited.has(current)) throw new Error(`Cycle detected in parentUuid chain at ${current}`)
    visited.add(current)
    const message = byUuid.get(current)
    if (!message) throw new Error(`Missing message ${current} in parentUuid chain`)
    chain.push(message)
    current = message.parentUuid
  }
  let active = chain.reverse()
  // A boundary applies only to its own branch. Rewinding before it must not
  // resurrect the latest summary or discard the selected older branch.
  for (const boundary of boundaries.reverse()) {
    const ids = [boundary.summaryUuid, ...boundary.preservedUuids]
    const baseHead = ids.at(-1)
    const index = active.findIndex((message) => message.uuid === baseHead)
    const inBase = headUuid ? ids.indexOf(headUuid) : -1
    if (index < 0 && inBase < 0) continue
    const base = (inBase >= 0 ? ids.slice(0, inBase + 1) : ids).map((id) => {
      const message = byUuid.get(id)
      if (!message) throw new Error(`Missing compacted message ${id}`)
      return message
    })
    active = [...base, ...(index >= 0 ? active.slice(index + 1) : [])]
    break
  }
  return {
    headUuid,
    messages: applyClearedToolResults(
      active.map(
        ({
          parentUuid: _parent,
          cwd: _cwd,
          sessionId: _session,
          compactionId: _compact,
          ...message
        }) => message,
      ),
      cleared,
    ),
  }
}

function collectFileHistorySnapshots(records: readonly SessionRecord[]): FileHistorySnapshot[] {
  const snapshots: FileHistorySnapshot[] = []
  for (const record of records) {
    if (record.type !== 'file-history-snapshot') continue
    const snapshot: FileHistorySnapshot = {
      messageId: record.snapshot.messageId,
      timestamp: new Date(record.snapshot.timestamp),
      trackedFileBackups: Object.fromEntries(
        Object.entries(record.snapshot.trackedFileBackups).map(([path, backup]) => [
          path,
          { ...backup, backupTime: new Date(backup.backupTime) },
        ]),
      ),
    }
    if (record.isSnapshotUpdate) {
      const index = snapshots.findLastIndex((candidate) => candidate.messageId === record.messageId)
      if (index >= 0) snapshots[index] = snapshot
      else snapshots.push(snapshot)
    } else {
      snapshots.push(snapshot)
    }
  }
  return snapshots
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
