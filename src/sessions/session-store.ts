import { createHash, type UUID } from 'node:crypto'
import { mkdir, open, readFile, unlink, type FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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

export type SessionRecord = SessionMetadataRecord | SessionMessageRecord | SessionNameRecord

export type LoadedSession = {
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
      const headUuid = [...loaded.records].reverse().find(isSessionMessageRecord)?.uuid
      file = await open(sessionPath, 'a', 0o600)
      return new SessionWriter({
        cwd: loaded.metadata.cwd,
        file,
        headUuid: headUuid ?? null,
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

  return {
    messages: records
      .filter(isSessionMessageRecord)
      .map(({ parentUuid: _parentUuid, sessionId: _sessionId, cwd: _cwd, ...message }) => message),
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
  throw new Error(`Unknown session record type ${value.type} at ${path}:${line}`)
}

function isSessionMessageRecord(record: SessionRecord): record is SessionMessageRecord {
  return record.type === 'user' || record.type === 'assistant'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
