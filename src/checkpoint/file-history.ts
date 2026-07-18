import { createHash, type UUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { SessionId } from '../sessions/ids.js'

type BackupFileName = string | null

export type FileHistoryBackup = {
  backupFileName: BackupFileName
  version: number
  backupTime: Date
}

export type FileHistorySnapshot = {
  messageId: UUID
  trackedFileBackups: Record<string, FileHistoryBackup>
  timestamp: Date
}

export type FileHistoryState = {
  snapshots: FileHistorySnapshot[]
  trackedFiles: Set<string>
  snapshotSequence: number
}

const MAX_SNAPSHOTS = 100

export class FileHistory {
  readonly #configDir: string
  readonly #cwd: string
  readonly #sessionId: SessionId
  #state: FileHistoryState = { snapshots: [], trackedFiles: new Set(), snapshotSequence: 0 }

  constructor(options: { configDir: string; cwd: string; sessionId: SessionId }) {
    this.#configDir = resolve(options.configDir)
    this.#cwd = resolve(options.cwd)
    this.#sessionId = options.sessionId
  }

  get state(): FileHistoryState {
    return this.#state
  }

  async makeSnapshot(messageId: UUID): Promise<void> {
    const backups: Record<string, FileHistoryBackup> = {}
    const previous = this.#state.snapshots.at(-1)

    for (const trackingPath of this.#state.trackedFiles) {
      const filePath = this.#expandTrackingPath(trackingPath)
      const latest = previous?.trackedFileBackups[trackingPath]
      if (latest && !(await this.#changedSinceBackup(filePath, latest.backupFileName))) {
        backups[trackingPath] = latest
      } else {
        backups[trackingPath] = await this.#createBackup(filePath, (latest?.version ?? 0) + 1)
      }
    }

    const snapshot: FileHistorySnapshot = {
      messageId,
      timestamp: new Date(),
      trackedFileBackups: backups,
    }
    const snapshots = [...this.#state.snapshots, snapshot]
    this.#state = {
      snapshots: snapshots.length > MAX_SNAPSHOTS ? snapshots.slice(-MAX_SNAPSHOTS) : snapshots,
      trackedFiles: this.#state.trackedFiles,
      snapshotSequence: this.#state.snapshotSequence + 1,
    }
  }

  async trackEdit(filePath: string, _messageId: UUID): Promise<void> {
    const snapshot = this.#state.snapshots.at(-1)
    if (!snapshot) throw new Error('Cannot track an edit before creating a prompt checkpoint')
    const absolutePath = resolve(filePath)
    const trackingPath = this.#shortenPath(absolutePath)
    if (snapshot.trackedFileBackups[trackingPath]) return

    const previousBackup = [...this.#state.snapshots]
      .reverse()
      .map((candidate) => candidate.trackedFileBackups[trackingPath])
      .find((backup) => backup !== undefined)
    const backup = await this.#createBackup(absolutePath, (previousBackup?.version ?? 0) + 1)
    snapshot.trackedFileBackups[trackingPath] = backup
    this.#state.trackedFiles.add(trackingPath)
  }

  async rewind(messageId: UUID): Promise<string[]> {
    const target = [...this.#state.snapshots]
      .reverse()
      .find((snapshot) => snapshot.messageId === messageId)
    if (!target) throw new Error(`Checkpoint ${messageId} was not found`)

    const changed: string[] = []
    for (const trackingPath of this.#state.trackedFiles) {
      const filePath = this.#expandTrackingPath(trackingPath)
      const backup = target.trackedFileBackups[trackingPath] ?? this.#firstBackup(trackingPath)
      if (!backup) continue

      if (backup.backupFileName === null) {
        try {
          await unlink(filePath)
          changed.push(filePath)
        } catch (error) {
          if (!isNodeError(error) || error.code !== 'ENOENT') throw error
        }
        continue
      }

      if (await this.#changedSinceBackup(filePath, backup.backupFileName)) {
        const backupPath = this.#backupPath(backup.backupFileName)
        await mkdir(dirname(filePath), { recursive: true })
        await copyFile(backupPath, filePath)
        const backupStats = await stat(backupPath)
        await chmod(filePath, backupStats.mode)
        changed.push(filePath)
      }
    }
    return changed
  }

  #firstBackup(trackingPath: string): FileHistoryBackup | undefined {
    for (const snapshot of this.#state.snapshots) {
      const backup = snapshot.trackedFileBackups[trackingPath]
      if (backup?.version === 1) return backup
    }
    return undefined
  }

  async #createBackup(filePath: string, version: number): Promise<FileHistoryBackup> {
    let sourceStats: Stats
    try {
      sourceStats = await stat(filePath)
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return { backupFileName: null, backupTime: new Date(), version }
      }
      throw error
    }

    const backupFileName = `${createHash('sha256').update(filePath).digest('hex').slice(0, 16)}@v${version}`
    const backupPath = this.#backupPath(backupFileName)
    await mkdir(dirname(backupPath), { recursive: true })
    await copyFile(filePath, backupPath)
    await chmod(backupPath, sourceStats.mode)
    return { backupFileName, backupTime: new Date(), version }
  }

  async #changedSinceBackup(filePath: string, backupFileName: BackupFileName): Promise<boolean> {
    if (backupFileName === null) return pathExists(filePath)
    const backupPath = this.#backupPath(backupFileName)
    const [current, backup] = await Promise.all([readOptional(filePath), readOptional(backupPath)])
    if (current === null || backup === null) return current !== backup
    return !current.equals(backup)
  }

  #backupPath(backupFileName: string): string {
    return join(this.#configDir, 'file-history', this.#sessionId, backupFileName)
  }

  #shortenPath(filePath: string): string {
    return filePath.startsWith(`${this.#cwd}/`) ? relative(this.#cwd, filePath) : filePath
  }

  #expandTrackingPath(filePath: string): string {
    return isAbsolute(filePath) ? filePath : join(this.#cwd, filePath)
  }
}

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null
    throw error
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
