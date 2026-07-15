import { readdir } from 'node:fs/promises'
import type { TextBlock, UserMessage } from '../model/types.js'
import {
  getProjectSessionsDirectory,
  loadSession,
  SessionWriter,
  type LoadedSession,
  type SessionMessageRecord,
} from './session-store.js'

type SessionLocation = {
  configDir: string
  cwd: string
}

export type SessionSummary = {
  sessionId: string
  createdAt: string
  updatedAt: string
  firstPrompt?: string
  name?: string
}

export async function listSessions(location: SessionLocation): Promise<SessionSummary[]> {
  const directory = getProjectSessionsDirectory(location)
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return []
    throw error
  }

  const sessions = await Promise.all(
    names
      .filter((name) => name.endsWith('.jsonl'))
      .map(async (name) => {
        const sessionId = name.slice(0, -'.jsonl'.length)
        const loaded = await loadSession({ ...location, sessionId })
        const lastMessage = [...loaded.records]
          .reverse()
          .find((record): record is SessionMessageRecord => record.type === 'message')
        const firstUserMessage = loaded.messages.find(
          (message): message is UserMessage => message.role === 'user',
        )
        const firstText = firstUserMessage?.content.find(
          (block): block is TextBlock => block.type === 'text',
        )?.text

        return {
          createdAt: loaded.metadata.createdAt,
          ...(firstText ? { firstPrompt: firstText } : {}),
          ...(loaded.name ? { name: loaded.name } : {}),
          sessionId,
          updatedAt: lastMessage?.timestamp ?? loaded.metadata.createdAt,
        }
      }),
  )

  return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export async function findMostRecentSession(
  location: SessionLocation,
): Promise<SessionSummary | undefined> {
  return (await listSessions(location))[0]
}

export async function forkSession(
  options: SessionLocation & {
    sourceSessionId: string
    targetSessionId: string
    name?: string
    now?: () => Date
  },
): Promise<LoadedSession> {
  const source = await loadSession({
    configDir: options.configDir,
    cwd: options.cwd,
    sessionId: options.sourceSessionId,
  })
  const writer = await SessionWriter.create({
    configDir: options.configDir,
    cwd: options.cwd,
    forkedFromSessionId: options.sourceSessionId,
    ...(options.name ? { name: options.name } : {}),
    ...(options.now ? { now: options.now } : {}),
    sessionId: options.targetSessionId,
  })

  try {
    for (const record of source.records) {
      if (record.type === 'message') await writer.appendMessage(record.message, record.id)
    }
  } finally {
    await writer.close()
  }

  return loadSession({
    configDir: options.configDir,
    cwd: options.cwd,
    sessionId: options.targetSessionId,
  })
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
