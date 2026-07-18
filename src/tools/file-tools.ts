import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import type { FileHistory } from '../checkpoint/file-history.js'
import type { JsonObject } from '../model/types.js'
import type { AgentTool } from './types.js'
import type { FileReadState } from './file-read-state.js'

type FileToolDependencies = {
  cwd: string
  fileHistory: FileHistory
  readFileState: FileReadState
}

const readInputSchema = z.strictObject({
  file_path: z.string(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().positive().optional(),
})

const writeInputSchema = z.strictObject({
  content: z.string(),
  file_path: z.string(),
})

const editInputSchema = z.strictObject({
  file_path: z.string(),
  new_string: z.string(),
  old_string: z.string(),
  replace_all: z.boolean().optional().default(false),
})

export function createReadTool(dependencies: FileToolDependencies): AgentTool {
  return {
    description: 'Reads a text file from the local filesystem.',
    async execute(input, { signal }) {
      throwIfAborted(signal)
      const parsed = readInputSchema.parse(input)
      const filePath = absolutePath(parsed.file_path)
      const [rawContent, fileStats] = await Promise.all([
        readFile(filePath, 'utf8'),
        stat(filePath),
      ])
      const content = normalizeLineEndings(rawContent)
      const lines = content.split('\n')
      const offset = parsed.offset ?? 1
      const start = offset - 1
      const end =
        parsed.limit === undefined ? lines.length : Math.min(lines.length, start + parsed.limit)
      const selected = lines.slice(start, end)
      dependencies.readFileState.set(filePath, {
        content,
        isPartialView: start > 0 || end < lines.length,
        ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
        offset,
        timestamp: fileStats.mtimeMs,
      })
      return {
        content: selected.map((line, index) => `${offset + index}→${line}`).join('\n'),
      }
    },
    inputSchema: {
      additionalProperties: false,
      properties: {
        file_path: { type: 'string' },
        limit: { minimum: 1, type: 'integer' },
        offset: { minimum: 1, type: 'integer' },
      },
      required: ['file_path'],
      type: 'object',
    },
    isConcurrencySafe: () => true,
    name: 'Read',
  }
}

export function createWriteTool(dependencies: FileToolDependencies): AgentTool {
  return {
    description: 'Writes a file to the local filesystem.',
    async execute(input, { parentMessageUuid, signal }) {
      throwIfAborted(signal)
      const parsed = writeInputSchema.parse(input)
      const filePath = absolutePath(parsed.file_path)
      await assertSafeToWriteExisting(filePath, dependencies.readFileState)
      await dependencies.fileHistory.trackEdit(filePath, parentMessageUuid)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, parsed.content, 'utf8')
      const fileStats = await stat(filePath)
      dependencies.readFileState.set(filePath, {
        content: parsed.content,
        isPartialView: false,
        timestamp: fileStats.mtimeMs,
      })
      return { content: `Wrote ${filePath}` }
    },
    inputSchema: {
      additionalProperties: false,
      properties: { content: { type: 'string' }, file_path: { type: 'string' } },
      required: ['file_path', 'content'],
      type: 'object',
    },
    isConcurrencySafe: () => false,
    name: 'Write',
  }
}

export function createEditTool(dependencies: FileToolDependencies): AgentTool {
  return {
    description: 'Performs an exact string replacement in a file.',
    async execute(input, { parentMessageUuid, signal }) {
      throwIfAborted(signal)
      const parsed = editInputSchema.parse(input)
      if (parsed.old_string === parsed.new_string) throw new Error('No changes to make')
      const filePath = absolutePath(parsed.file_path)
      let content: string
      try {
        content = normalizeLineEndings(await readFile(filePath, 'utf8'))
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT' && parsed.old_string === '') {
          content = ''
        } else {
          throw error
        }
      }
      if (content !== '') await assertSafeToWriteExisting(filePath, dependencies.readFileState)
      const occurrences =
        parsed.old_string === '' ? 1 : countOccurrences(content, parsed.old_string)
      if (occurrences === 0)
        throw new Error(`String to replace not found in file: ${parsed.old_string}`)
      if (occurrences > 1 && !parsed.replace_all) {
        throw new Error(`Found ${occurrences} matches but replace_all is false`)
      }
      const updated = parsed.replace_all
        ? content.replaceAll(parsed.old_string, parsed.new_string)
        : content.replace(parsed.old_string, parsed.new_string)
      await dependencies.fileHistory.trackEdit(filePath, parentMessageUuid)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, updated, 'utf8')
      const fileStats = await stat(filePath)
      dependencies.readFileState.set(filePath, {
        content: updated,
        isPartialView: false,
        timestamp: fileStats.mtimeMs,
      })
      return { content: `Updated ${filePath}` }
    },
    inputSchema: {
      additionalProperties: false,
      properties: {
        file_path: { type: 'string' },
        new_string: { type: 'string' },
        old_string: { type: 'string' },
        replace_all: { default: false, type: 'boolean' },
      },
      required: ['file_path', 'old_string', 'new_string'],
      type: 'object',
    },
    isConcurrencySafe: () => false,
    name: 'Edit',
  }
}

async function assertSafeToWriteExisting(filePath: string, state: FileReadState): Promise<void> {
  let current: string
  try {
    current = normalizeLineEndings(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return
    throw error
  }
  const previous = state.get(filePath)
  if (!previous || previous.isPartialView) throw new Error('File has not been read yet')
  if (previous.content !== current) throw new Error('File has been modified since read')
}

function absolutePath(filePath: string): string {
  if (!isAbsolute(filePath)) throw new Error(`File path must be absolute: ${filePath}`)
  return resolve(filePath)
}

function countOccurrences(content: string, value: string): number {
  return content.split(value).length - 1
}

function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n')
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Tool execution aborted')
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

export function isFileToolInput(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
