import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path'
import { promisify } from 'node:util'
import type { DockSettings } from '../config/load-settings.js'
import { encodeProjectPath } from '../sessions/session-store.js'

const execFileAsync = promisify(execFile)
const ENTRYPOINT_NAME = 'MEMORY.md'
const MAX_INDEX_LINES = 200
const MAX_INDEX_BYTES = 25_000
const NEAR_LIMIT_RATIO = 0.9
const MEMORY_TYPES = new Set(['user', 'feedback', 'project', 'reference'])

export type LoadedMemoryIndex = {
  byteCount: number
  content: string
  lineCount: number
  wasTruncated: boolean
}

export type MemoryManifestEntry = {
  description: string
  fileName: string
  name: string
  type: 'user' | 'feedback' | 'project' | 'reference'
}

export type MemoryWriteFeedback = {
  content: string
  isError?: boolean
}

type MemoryManagerOptions = {
  configDir: string
  homeDir?: string
  now?: () => Date
  projectRoot: string
  resolveCanonicalRoot?: (projectRoot: string) => Promise<string>
  settings: Pick<DockSettings, 'autoMemoryDirectory' | 'autoMemoryEnabled'>
}

export class MemoryManager {
  readonly #now: () => Date
  readonly directory: string
  readonly enabled: boolean
  readonly entrypoint: string

  private constructor(options: { directory: string; enabled: boolean; now: () => Date }) {
    this.directory = options.directory
    this.enabled = options.enabled
    this.entrypoint = join(options.directory, ENTRYPOINT_NAME)
    this.#now = options.now
  }

  static async create(options: MemoryManagerOptions): Promise<MemoryManager> {
    const homeDir = resolve(options.homeDir ?? homedir())
    const enabled = options.settings.autoMemoryEnabled !== false
    let directory: string
    if (options.settings.autoMemoryDirectory !== undefined) {
      directory = validateCustomDirectory(options.settings.autoMemoryDirectory, homeDir)
    } else {
      const canonicalRoot = await (options.resolveCanonicalRoot ?? resolveCanonicalRepositoryRoot)(
        options.projectRoot,
      )
      directory = join(
        resolve(options.configDir),
        'projects',
        encodeProjectPath(canonicalRoot),
        'memory',
      )
    }
    return new MemoryManager({
      directory,
      enabled,
      now: options.now ?? (() => new Date()),
    })
  }

  async initialize(): Promise<void> {
    if (!this.enabled) return
    await mkdir(this.directory, { mode: 0o700, recursive: true })
  }

  buildSystemPrompt(): string | null {
    if (!this.enabled) return null
    return `# Auto memory

You have a persistent, file-based memory system at \`${this.directory}\`. This directory already exists. Use the Read, Write, and Edit tools directly; do not run mkdir or check whether it exists.

Store one durable fact per Markdown topic file with frontmatter containing \`name\`, \`description\`, and \`type\`. The type must be one of: \`user\`, \`feedback\`, \`project\`, or \`reference\`.

- user: the user's role, expertise, and working preferences
- feedback: corrections and confirmed approaches, including why and how to apply them
- project: ongoing goals, constraints, decisions, and dates not derivable from code or Git
- reference: pointers to external resources

After writing a topic file, add one concise line to \`${this.entrypoint}\`: \`- [Title](file.md) — one-line hook\`. MEMORY.md is only an index; never put full memory content in it. Before creating a file, check whether an existing topic should be updated instead. Delete or correct stale memories.

Do not save code structure, file paths, Git history, information already in AGENTS.md, or details useful only in the current conversation. If the user explicitly asks you to remember something, save the non-derivable durable part immediately. If asked to forget something, remove or correct the relevant memory. Treat recalled memory as possibly stale and verify current files, functions, flags, and external state before relying on it.`
  }

  async loadIndex(): Promise<LoadedMemoryIndex | undefined> {
    if (!this.enabled) return undefined
    let raw: string
    try {
      raw = await readFile(this.entrypoint, 'utf8')
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined
      throw error
    }
    const effective = contentLoadedFromIndex(raw)
    const analysis = analyzeIndex(effective)
    const truncated = truncateIndex(effective, analysis)
    return {
      ...analysis,
      content: truncated.content,
      wasTruncated: truncated.wasTruncated,
    }
  }

  async prepareWrite(filePath: string, content: string): Promise<string> {
    if (!this.enabled || !this.isMemoryPath(filePath)) return content
    return updateModifiedFrontmatter(content, this.#now().toISOString())
  }

  inspectWrite(filePath: string, content: string): MemoryWriteFeedback | undefined {
    if (!this.enabled || !samePath(filePath, this.entrypoint)) return undefined
    const analysis = analyzeIndex(contentLoadedFromIndex(content))
    if (analysis.lineCount > MAX_INDEX_LINES || analysis.byteCount > MAX_INDEX_BYTES) {
      return {
        content: `The MEMORY.md write succeeded, but the index is over its read limit (${analysis.lineCount} lines, ${analysis.byteCount} bytes). Rewrite it to at most ${MAX_INDEX_LINES} lines and ${MAX_INDEX_BYTES} bytes; keep one concise line per topic.`,
        isError: true,
      }
    }
    if (
      analysis.lineCount >= MAX_INDEX_LINES * NEAR_LIMIT_RATIO ||
      analysis.byteCount >= MAX_INDEX_BYTES * NEAR_LIMIT_RATIO
    ) {
      return {
        content: `MEMORY.md is nearing its read limit (${analysis.lineCount} lines, ${analysis.byteCount} bytes). Keep one line per topic and move detail into topic files.`,
      }
    }
    return undefined
  }

  isMemoryPath(filePath: string): boolean {
    if (!this.enabled || !isAbsolute(filePath)) return false
    const pathFromDirectory = relative(resolve(this.directory), resolve(filePath))
    return (
      pathFromDirectory !== '' &&
      pathFromDirectory !== '..' &&
      !pathFromDirectory.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromDirectory)
    )
  }

  async scanManifest(): Promise<MemoryManifestEntry[]> {
    if (!this.enabled) return []
    let entries: Dirent<string>[]
    try {
      entries = await readdir(this.directory, { withFileTypes: true, encoding: 'utf8' })
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return []
      throw error
    }
    const manifest = await Promise.all(
      entries
        .filter(
          (entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== ENTRYPOINT_NAME,
        )
        .map(async (entry) => {
          const content = await readFile(join(this.directory, entry.name), 'utf8')
          const frontmatter = readFrontmatter(content)
          const type = frontmatter?.type
          if (!frontmatter?.name || !frontmatter.description || !type || !MEMORY_TYPES.has(type)) {
            return undefined
          }
          return {
            description: frontmatter.description,
            fileName: entry.name,
            name: frontmatter.name,
            type: type as MemoryManifestEntry['type'],
          }
        }),
    )
    return manifest
      .filter((entry): entry is MemoryManifestEntry => entry !== undefined)
      .sort((left, right) => left.fileName.localeCompare(right.fileName))
  }
}

export async function resolveCanonicalRepositoryRoot(projectRoot: string): Promise<string> {
  const fallback = resolve(projectRoot)
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      fallback,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ])
    const commonDirectory = resolve(stdout.trim())
    return basename(commonDirectory) === '.git' ? dirname(commonDirectory) : fallback
  } catch {
    return fallback
  }
}

function validateCustomDirectory(value: string, homeDir: string): string {
  if (value.includes('\0')) throw new Error('autoMemoryDirectory contains a null byte')
  const expanded =
    value.startsWith('~/') || value.startsWith('~\\') ? join(homeDir, value.slice(2)) : value
  const normalized = normalize(expanded).replace(/[\\/]+$/, '')
  const filesystemRoot = parse(normalized).root.replace(/[\\/]+$/, '')
  if (
    !normalized ||
    !isAbsolute(normalized) ||
    normalized === filesystemRoot ||
    samePath(normalized, homeDir) ||
    normalized.startsWith('\\\\') ||
    normalized.startsWith('//')
  ) {
    throw new Error(`Invalid autoMemoryDirectory: ${value}`)
  }
  return resolve(normalized)
}

function analyzeIndex(content: string): Omit<LoadedMemoryIndex, 'content' | 'wasTruncated'> {
  const normalized = content.trim()
  return {
    byteCount: Buffer.byteLength(normalized, 'utf8'),
    lineCount: normalized ? normalized.split('\n').length : 0,
  }
}

function truncateIndex(
  content: string,
  analysis: ReturnType<typeof analyzeIndex>,
): { content: string; wasTruncated: boolean } {
  const normalized = content.trim()
  const lineTruncated = analysis.lineCount > MAX_INDEX_LINES
  const byteTruncated = analysis.byteCount > MAX_INDEX_BYTES
  if (!lineTruncated && !byteTruncated) return { content: normalized, wasTruncated: false }
  let truncated = lineTruncated
    ? normalized.split('\n').slice(0, MAX_INDEX_LINES).join('\n')
    : normalized
  if (Buffer.byteLength(truncated, 'utf8') > MAX_INDEX_BYTES) {
    truncated = truncateUtf8(truncated, MAX_INDEX_BYTES)
  }
  return {
    content: `${truncated}\n\n> WARNING: MEMORY.md exceeded its ${MAX_INDEX_LINES}-line or ${MAX_INDEX_BYTES}-byte read limit. Only part of it was loaded. Keep one concise index line per topic and move detail into topic files.`,
    wasTruncated: true,
  }
}

function truncateUtf8(content: string, maxBytes: number): string {
  const buffer = Buffer.from(content, 'utf8')
  let end = buffer.lastIndexOf(10, maxBytes)
  if (end <= 0) end = maxBytes
  const decoder = new TextDecoder('utf-8', { fatal: true })
  while (end > 0) {
    try {
      return decoder.decode(buffer.subarray(0, end)).trimEnd()
    } catch {
      end -= 1
    }
  }
  return ''
}

function contentLoadedFromIndex(content: string): string {
  let loaded = content.replaceAll('\r\n', '\n')
  const frontmatter = frontmatterBounds(loaded)
  if (frontmatter) loaded = loaded.slice(frontmatter.end)
  return loaded.replace(/<!--[\s\S]*?-->/g, '').trim()
}

function updateModifiedFrontmatter(content: string, timestamp: string): string {
  const normalized = content.replaceAll('\r\n', '\n')
  const bounds = frontmatterBounds(normalized)
  if (!bounds) return content
  const header = normalized.slice(bounds.start, bounds.end)
  const lines = header.split('\n')
  const modifiedIndex = lines.findIndex((line, index) => index > 0 && /^modified\s*:/.test(line))
  if (modifiedIndex >= 0) lines[modifiedIndex] = `modified: ${timestamp}`
  else lines.splice(lines.length - 2, 0, `modified: ${timestamp}`)
  return `${lines.join('\n')}${normalized.slice(bounds.end)}`
}

function readFrontmatter(content: string): Record<string, string> | undefined {
  const normalized = content.replaceAll('\r\n', '\n')
  const bounds = frontmatterBounds(normalized)
  if (!bounds) return undefined
  const result: Record<string, string> = {}
  for (const line of normalized.slice(bounds.start + 4, bounds.end - 4).split('\n')) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/)
    if (!match?.[1]) continue
    result[match[1]] = unquote(match[2]?.trim() ?? '')
  }
  return result
}

function frontmatterBounds(content: string): { end: number; start: number } | undefined {
  if (!content.startsWith('---\n')) return undefined
  const closing = content.indexOf('\n---\n', 4)
  if (closing < 0) return undefined
  return { end: closing + 5, start: 0 }
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
