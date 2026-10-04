import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { FileHistory } from '../checkpoint/file-history.js'
import type { JsonObject } from '../model/types.js'
import { findContentRule } from '../permissions/evaluate-permission.js'
import { matchesPathSpecifier } from '../permissions/specifier-matching.js'
import { autoFileScope } from '../permissions/auto-paths.js'
import type { AgentTool, AgentToolResult } from './types.js'
import type { FileReadState } from './file-read-state.js'

type FileToolDependencies = {
  cwd: string
  fileHistory: Pick<FileHistory, 'trackEdit'>
  readFileState: FileReadState
  writeLifecycle?: FileWriteLifecycle
}

export type FileWriteLifecycle = {
  afterWrite?: (
    filePath: string,
    content: string,
  ) => Promise<AgentToolResult | undefined> | AgentToolResult | undefined
  prepareWrite?: (filePath: string, content: string) => Promise<string> | string
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
  const tool: AgentTool = {
    description: 'Reads a text file from the local filesystem. file_path must be an absolute path.',
    async execute(input, { signal }) {
      throwIfAborted(signal)
      const parsed = readInputSchema.parse(input)
      const filePath = absolutePath(parsed.file_path)
      const fileStats = await stat(filePath)
      if (parsed.limit === undefined && fileStats.size > 256 * 1024) {
        throw new Error(
          'File exceeds the 256KB read limit. Use offset and limit to read it in portions, or use Grep to search for specific content.',
        )
      }
      const rawContent = await readFile(filePath, 'utf8')
      const content = normalizeLineEndings(rawContent)
      const lines = content.split('\n')
      const offset = parsed.offset ?? 1
      const start = offset - 1
      const end =
        parsed.limit === undefined ? lines.length : Math.min(lines.length, start + parsed.limit)
      const selected = lines.slice(start, end)
      const output = selected.map((line, index) => `${offset + index}→${line}`).join('\n')
      if (Math.ceil(output.length / 4) > 25_000) {
        throw new Error(
          'Read output exceeds the 25,000 token limit. Use offset and limit to read a smaller portion.',
        )
      }
      dependencies.readFileState.set(filePath, {
        content,
        isPartialView: start > 0 || end < lines.length,
        ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
        offset,
        timestamp: fileStats.mtimeMs,
      })
      return {
        content: output,
      }
    },
    inputSchema: {
      additionalProperties: false,
      properties: {
        file_path: { description: 'Absolute path to the file to read.', type: 'string' },
        limit: { minimum: 1, type: 'integer' },
        offset: { minimum: 1, type: 'integer' },
      },
      required: ['file_path'],
      type: 'object',
    },
    checkPermissions: (input, context) =>
      checkFilePermission(tool, input, context, dependencies.cwd, true),
    getPermissionRule: (input) => filePermissionRule('Read', input.file_path),
    isConcurrencySafe: () => true,
    name: 'Read',
    parseInput: (input) => readInputSchema.parse(input),
  }
  return tool
}

export function createWriteTool(dependencies: FileToolDependencies): AgentTool {
  const tool: AgentTool = {
    description: 'Writes a file to the local filesystem. file_path must be an absolute path.',
    async execute(input, { parentMessageUuid, signal }) {
      throwIfAborted(signal)
      const parsed = writeInputSchema.parse(input)
      const filePath = absolutePath(parsed.file_path)
      await assertSafeToWriteExisting(filePath, dependencies.readFileState)
      const content =
        (await dependencies.writeLifecycle?.prepareWrite?.(filePath, parsed.content)) ??
        parsed.content
      await dependencies.fileHistory.trackEdit(filePath, parentMessageUuid)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, content, 'utf8')
      const fileStats = await stat(filePath)
      dependencies.readFileState.set(filePath, {
        content,
        isPartialView: false,
        timestamp: fileStats.mtimeMs,
      })
      const feedback = await dependencies.writeLifecycle?.afterWrite?.(filePath, content)
      return feedback
        ? {
            content: `Wrote ${filePath}\n${feedback.content}`,
            ...(feedback.isError === undefined ? {} : { isError: feedback.isError }),
          }
        : { content: `Wrote ${filePath}` }
    },
    inputSchema: {
      additionalProperties: false,
      properties: {
        content: { type: 'string' },
        file_path: { description: 'Absolute path to the file to write.', type: 'string' },
      },
      required: ['file_path', 'content'],
      type: 'object',
    },
    checkPermissions: (input, context) =>
      checkFilePermission(tool, input, context, dependencies.cwd, false),
    isConcurrencySafe: () => false,
    name: 'Write',
    parseInput: (input) => writeInputSchema.parse(input),
  }
  return tool
}

export function createEditTool(dependencies: FileToolDependencies): AgentTool {
  const tool: AgentTool = {
    description:
      'Performs an exact string replacement in a file. file_path must be an absolute path.',
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
      const replaced = parsed.replace_all
        ? content.replaceAll(parsed.old_string, parsed.new_string)
        : content.replace(parsed.old_string, parsed.new_string)
      const updated =
        (await dependencies.writeLifecycle?.prepareWrite?.(filePath, replaced)) ?? replaced
      await dependencies.fileHistory.trackEdit(filePath, parentMessageUuid)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, updated, 'utf8')
      const fileStats = await stat(filePath)
      dependencies.readFileState.set(filePath, {
        content: updated,
        isPartialView: false,
        timestamp: fileStats.mtimeMs,
      })
      const feedback = await dependencies.writeLifecycle?.afterWrite?.(filePath, updated)
      return feedback
        ? {
            content: `Updated ${filePath}\n${feedback.content}`,
            ...(feedback.isError === undefined ? {} : { isError: feedback.isError }),
          }
        : { content: `Updated ${filePath}` }
    },
    inputSchema: {
      additionalProperties: false,
      properties: {
        file_path: { description: 'Absolute path to the file to edit.', type: 'string' },
        new_string: { type: 'string' },
        old_string: { type: 'string' },
        replace_all: { default: false, type: 'boolean' },
      },
      required: ['file_path', 'old_string', 'new_string'],
      type: 'object',
    },
    checkPermissions: (input, context) =>
      checkFilePermission(tool, input, context, dependencies.cwd, false),
    isConcurrencySafe: () => false,
    name: 'Edit',
    parseInput: (input) => editInputSchema.parse(input),
  }
  return tool
}

async function checkFilePermission(
  tool: AgentTool,
  input: JsonObject,
  context: Parameters<NonNullable<AgentTool['checkPermissions']>>[1],
  cwd: string,
  readOnly: boolean,
): Promise<Awaited<ReturnType<NonNullable<AgentTool['checkPermissions']>>>> {
  const filePath = typeof input.file_path === 'string' ? input.file_path : ''
  const matchesSpecifier = (pattern: string) =>
    Boolean(filePath) && matchesPathSpecifier(pattern, filePath, cwd)
  const denyRule = findContentRule(context.rules, 'deny', tool.name, matchesSpecifier)
  if (denyRule) {
    return {
      behavior: 'deny',
      message: `Permission denied for ${tool.name}`,
      rule: denyRule,
      source: 'rule',
    }
  }
  const askRule = findContentRule(context.rules, 'ask', tool.name, matchesSpecifier)
  if (askRule) {
    return {
      behavior: 'ask',
      message: `Permission required for ${tool.name}`,
      rule: askRule,
      source: 'rule',
    }
  }
  if (context.mode === 'auto') {
    const scope = await autoFileScope(cwd, filePath)
    if (!readOnly && scope.protected)
      return { behavior: 'ask', source: 'auto', updatedInput: input }
    if (scope.inside) return { behavior: 'allow', source: 'mode', updatedInput: input }
    const allow = findContentRule(context.rules, 'allow', tool.name, matchesSpecifier)
    return allow
      ? { behavior: 'allow', source: 'rule', rule: allow, updatedInput: input }
      : { behavior: 'passthrough', source: 'tool', updatedInput: input }
  }
  if (context.autoAllowInternalToolUse?.(tool, input)) {
    return { behavior: 'allow', source: 'internal', updatedInput: input }
  }

  const isInWorkingDirectory = Boolean(filePath) && isPathWithin(cwd, filePath)
  if (context.mode !== 'dontAsk' && readOnly && isInWorkingDirectory) {
    return { behavior: 'allow', source: 'mode', updatedInput: input }
  }
  if (context.mode === 'acceptEdits' && !readOnly && isInWorkingDirectory) {
    return { behavior: 'allow', source: 'mode', updatedInput: input }
  }

  const allowRule = findContentRule(context.rules, 'allow', tool.name, matchesSpecifier)
  if (allowRule) {
    return { behavior: 'allow', rule: allowRule, source: 'rule', updatedInput: input }
  }
  return { behavior: 'passthrough', source: 'tool', updatedInput: input }
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
  if (!previous) throw new Error('Cannot modify an existing file without a successful Read first')
  if (previous.content !== current) throw new Error('File has been modified since read')
}

function absolutePath(filePath: string): string {
  if (!isAbsolute(filePath)) throw new Error(`File path must be absolute: ${filePath}`)
  return resolve(filePath)
}

function filePermissionRule(toolName: string, filePath: unknown): string | undefined {
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) return undefined
  return `${toolName}(/${resolve(filePath).replaceAll('\\', '/')})`
}

function isPathWithin(cwd: string, filePath: string): boolean {
  if (!isAbsolute(filePath)) return false
  const pathFromCwd = relative(resolve(cwd), resolve(filePath))
  return pathFromCwd === '' || (!pathFromCwd.startsWith('..') && !isAbsolute(pathFromCwd))
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
