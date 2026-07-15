import { createHash } from 'node:crypto'
import { mkdir, open, readFile, unlink, type FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ModelMessage } from '../model/types.js'

export type SessionMetadataRecord = {
  type: 'session_start'
  version: 1
  sessionId: string
  cwd: string
  createdAt: string
  forkedFromSessionId?: string
  name?: string
}

export type SessionMessageRecord = {
  type: 'message'
  id: string
  parentId: string | null
  timestamp: string
  message: ModelMessage
}

export type SessionNameRecord = {
  type: 'session_name'
  name: string
  timestamp: string
}

export type SessionRecord = SessionMetadataRecord | SessionMessageRecord | SessionNameRecord

export type LoadedSession = {
  messages: readonly ModelMessage[]
  metadata: SessionMetadataRecord
  name?: string
  records: readonly SessionRecord[]
  truncatedTail: boolean
}

type SessionLocation = {
  configDir: string
  cwd: string
  sessionId: string
}

type WriterOptions = SessionLocation & {
  forkedFromSessionId?: string
  name?: string
  now?: () => Date
}

export class SessionWriter {
  readonly #file: FileHandle
  readonly #lock: FileHandle
  readonly #lockPath: string
  readonly #now: () => Date
  #closed = false
  #headId: string | null

  private constructor(options: {
    file: FileHandle
    headId: string | null
    lock: FileHandle
    lockPath: string
    now: () => Date
  }) {
    this.#file = options.file
    this.#headId = options.headId
    this.#lock = options.lock
    this.#lockPath = options.lockPath
    this.#now = options.now
  }

  static async create(options: WriterOptions): Promise<SessionWriter> {
    validateSessionId(options.sessionId)
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
      return new SessionWriter({ file, headId: null, lock, lockPath, now })
    } catch (error) {
      await file?.close()
      await releaseLock(lock, lockPath)
      throw error
    }
  }

  static async open(options: WriterOptions): Promise<SessionWriter> {
    validateSessionId(options.sessionId)
    const sessionPath = getSessionPath(options)
    const { handle: lock, path: lockPath } = await acquireLock(sessionPath)

    let file: FileHandle | undefined
    try {
      const loaded = await loadSession(options)
      const headId = [...loaded.records]
        .reverse()
        .find((record): record is SessionMessageRecord => record.type === 'message')?.id
      file = await open(sessionPath, 'a', 0o600)
      return new SessionWriter({
        file,
        headId: headId ?? null,
        lock,
        lockPath,
        now: options.now ?? (() => new Date()),
      })
    } catch (error) {
      await file?.close()
      await releaseLock(lock, lockPath)
      throw error
    }
  }

  async appendMessage(message: ModelMessage, id: string): Promise<void> {
    this.#assertOpen()
    if (!id) throw new Error('Session message id must not be empty')
    const record: SessionMessageRecord = {
      id,
      message,
      parentId: this.#headId,
      timestamp: this.#now().toISOString(),
      type: 'message',
    }
    await appendAndSync(this.#file, record)
    this.#headId = id
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
  validateSessionId(location.sessionId)
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
      .filter((record): record is SessionMessageRecord => record.type === 'message')
      .map((record) => record.message),
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
  validateSessionId(location.sessionId)
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
    return value as SessionMetadataRecord
  }
  if (value.type === 'message') {
    if (
      typeof value.id !== 'string' ||
      (value.parentId !== null && typeof value.parentId !== 'string') ||
      typeof value.timestamp !== 'string' ||
      !isObject(value.message)
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

function validateSessionId(sessionId: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
    throw new Error(`Invalid session id: ${sessionId}`)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
