import { createHash, type UUID } from 'node:crypto'
import { mkdir, open, readFile, unlink, type FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { FileHistorySnapshot } from '../checkpoint/file-history.js'
import type { TranscriptMessage } from '../messages/create-message.js'
import { asSessionId, isUuid, type SessionId } from './ids.js'

export type SessionMetadataRecord = {
  type: 'session_start'
  version: 1
  sessionId: SessionId
  cwd: string
  createdAt: string
  forkedFromSessionId?: SessionId
  name?: string
}

export type SessionMessageRecord = TranscriptMessage & {
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

export type SessionCompactRecord = {
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

export type LoadedSession = {
  fileHistorySnapshots: readonly FileHistorySnapshot[]
  headUuid: UUID | null
  messages: readonly TranscriptMessage[]
  metadata: SessionMetadataRecord
  name?: string
  records: readonly SessionRecord[]
  truncatedTail: boolean
}

type SessionLocation = {
  configDir: string
  cwd: string
  sessionId: SessionId
}

type WriterOptions = SessionLocation & {
  forkedFromSessionId?: SessionId
  name?: string
  now?: () => Date
}

export class SessionWriter {
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
    await mkdir(getProjectSessionsDirectory(options), { recursive: true, mode: 0o700 })
    const { handle: lock, path: lockPath } = await acquireLock(sessionPath)

    let file: FileHandle | undefined
    try {
      file = await open(sessionPath, 'wx', 0o600)
      const now = options.now ?? (() => new Date())
      const metadata: SessionMetadataRecord = {
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
      return new SessionWriter({
        cwd: loaded.metadata.cwd,
        file,
        headUuid: loaded.headUuid,
        lock,
        lockPath,
        messageUuids: new Set(loaded.messages.map((message) => message.uuid)),
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

  async recordCompaction(messages: readonly TranscriptMessage[]): Promise<void> {
    this.#assertOpen()
    const [summary, ...preserved] = messages
    if (summary?.type !== 'user' || !summary.isCompactSummary) {
      throw new Error('Compaction must begin with a compact summary message')
    }
    if (!this.#messageUuids.has(summary.uuid)) {
      await appendAndSync(this.#file, {
        parentUuid: null,
        ...summary,
        cwd: this.#cwd,
        sessionId: this.#sessionId,
      })
      this.#messageUuids.add(summary.uuid)
    }
    const preservedUuids = preserved.map((message) => message.uuid)
    await appendAndSync(this.#file, {
      preservedUuids,
      summaryUuid: summary.uuid,
      timestamp: this.#now().toISOString(),
      type: 'compact_boundary',
    })
    this.#headUuid = preservedUuids.at(-1) ?? summary.uuid
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#file.close()
    await releaseLock(this.#lock, this.#lockPath)
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Session writer is closed')
  }
}

export async function loadSession(location: SessionLocation): Promise<LoadedSession> {
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
  return join(getProjectSessionsDirectory(location), `${location.sessionId}.jsonl`)
}

export function getProjectSessionsDirectory(
  location: Pick<SessionLocation, 'configDir' | 'cwd'>,
): string {
  return join(resolve(location.configDir), 'projects', encodeProjectPath(location.cwd))
}

function encodeProjectPath(cwd: string): string {
  const absolutePath = resolve(cwd)
  const encoded = absolutePath.replace(/[^a-zA-Z0-9]/g, '-')
  if (encoded.length <= 200) return encoded
  const hash = createHash('sha256').update(absolutePath).digest('hex').slice(0, 16)
  return `${encoded.slice(0, 183)}-${hash}`
}

async function acquireLock(sessionPath: string): Promise<{ handle: FileHandle; path: string }> {
  const lockPath = `${sessionPath}.lock`
  try {
    const handle = await open(lockPath, 'wx', 0o600)
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
    )
    await handle.sync()
    return { handle, path: lockPath }
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new Error(`Session ${sessionPath} is already open`)
    }
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

function buildActiveConversation(records: readonly SessionRecord[]): {
  headUuid: UUID | null
  messages: TranscriptMessage[]
} {
  const messagesByUuid = new Map<UUID, SessionMessageRecord>()
  let headUuid: UUID | null = null
  let compactBoundary: SessionCompactRecord | undefined
  for (const record of records) {
    if (isSessionMessageRecord(record)) {
      messagesByUuid.set(record.uuid, record)
      headUuid = record.uuid
    } else if (record.type === 'rewind') {
      headUuid = record.targetUuid
    } else if (record.type === 'compact_boundary') {
      compactBoundary = record
      headUuid = record.preservedUuids.at(-1) ?? record.summaryUuid
    }
  }

  const chain: SessionMessageRecord[] = []
  const visited = new Set<UUID>()
  let current = headUuid
  while (current) {
    if (visited.has(current)) throw new Error(`Cycle detected in parentUuid chain at ${current}`)
    visited.add(current)
    const message = messagesByUuid.get(current)
    if (!message) throw new Error(`Missing message ${current} in parentUuid chain`)
    chain.push(message)
    current = message.parentUuid
  }

  let activeChain = chain.reverse()
  if (compactBoundary) {
    const baseUuids = [compactBoundary.summaryUuid, ...compactBoundary.preservedUuids]
    const base = baseUuids.map((uuid) => {
      const message = messagesByUuid.get(uuid)
      if (!message) throw new Error(`Missing compacted message ${uuid}`)
      return message
    })
    const baseHead = baseUuids.at(-1)
    const baseHeadIndex = activeChain.findIndex((message) => message.uuid === baseHead)
    const suffix = baseHeadIndex >= 0 ? activeChain.slice(baseHeadIndex + 1) : []
    activeChain = [...base, ...suffix]
  }

  return {
    headUuid,
    messages: activeChain.map(
      ({ parentUuid: _parentUuid, sessionId: _sessionId, cwd: _cwd, ...message }) => message,
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
