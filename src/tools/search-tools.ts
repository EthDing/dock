import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import fg from 'fast-glob'
import { z } from 'zod'
import { matchesWildcard } from '../permissions/specifier-matching.js'
import type { AgentTool } from './types.js'

const VCS_IGNORES = [
  '**/.git/**',
  '**/.svn/**',
  '**/.hg/**',
  '**/.bzr/**',
  '**/.jj/**',
  '**/.sl/**',
]

const globInputSchema = z.strictObject({
  path: z.string().optional(),
  pattern: z.string(),
})

const grepInputSchema = z.strictObject({
  pattern: z.string(),
  path: z.string().optional(),
  glob: z.string().optional(),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
  '-B': z.number().int().nonnegative().optional(),
  '-A': z.number().int().nonnegative().optional(),
  '-C': z.number().int().nonnegative().optional(),
  context: z.number().int().nonnegative().optional(),
  '-n': z.boolean().optional(),
  '-i': z.boolean().optional(),
  type: z.string().optional(),
  head_limit: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().optional(),
  multiline: z.boolean().optional(),
})

export function createGlobTool(options: { cwd: string }): AgentTool {
  const cwd = resolve(options.cwd)
  return {
    description: 'Finds files by glob pattern.',
    async execute(input, { signal }) {
      const parsed = globInputSchema.parse(input)
      const searchRoot = parsed.path ? resolve(parsed.path) : cwd
      const searchStats = await stat(searchRoot)
      if (!searchStats.isDirectory()) throw new Error(`Path is not a directory: ${searchRoot}`)
      if (signal.aborted) throw new Error('Tool execution aborted')
      const matches = await fg(parsed.pattern, {
        absolute: true,
        cwd: searchRoot,
        dot: true,
        followSymbolicLinks: false,
        ignore: VCS_IGNORES,
        onlyFiles: true,
        unique: true,
      })
      const filenames = matches
        .map((filePath) => (filePath.startsWith(`${cwd}/`) ? relative(cwd, filePath) : filePath))
        .slice(0, 100)
      return {
        content:
          filenames.length === 0
            ? 'No files found'
            : `${filenames.join('\n')}${matches.length > 100 ? '\n(Results are truncated.)' : ''}`,
      }
    },
    inputSchema: {
      additionalProperties: false,
      properties: { path: { type: 'string' }, pattern: { type: 'string' } },
      required: ['pattern'],
      type: 'object',
    },
    getPermissionSubject: (input) => ({
      isReadOnly: true,
      matchesSpecifier: (pattern) =>
        typeof input.pattern === 'string' && matchesWildcard(pattern, input.pattern),
      name: 'Glob',
      requiresBypassConfirmation: false,
    }),
    isConcurrencySafe: () => true,
    name: 'Glob',
  }
}

export function createGrepTool(options: { cwd: string }): AgentTool {
  const cwd = resolve(options.cwd)
  return {
    description: 'Searches file contents with ripgrep.',
    async execute(input, { signal }) {
      const parsed = grepInputSchema.parse(input)
      const mode = parsed.output_mode ?? 'files_with_matches'
      const target = parsed.path ? resolve(parsed.path) : cwd
      await stat(target)
      const args = ['--hidden', '--max-columns', '500']
      for (const directory of ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']) {
        args.push('--glob', `!${directory}`)
      }
      if (parsed.multiline) args.push('-U', '--multiline-dotall')
      if (parsed['-i']) args.push('-i')
      if (mode === 'files_with_matches') args.push('-l')
      if (mode === 'count') args.push('-c')
      if (mode === 'content' && (parsed['-n'] ?? true)) args.push('-n')
      if (mode === 'content') {
        const context = parsed.context ?? parsed['-C']
        if (context !== undefined) args.push('-C', String(context))
        else {
          if (parsed['-B'] !== undefined) args.push('-B', String(parsed['-B']))
          if (parsed['-A'] !== undefined) args.push('-A', String(parsed['-A']))
        }
      }
      if (parsed.pattern.startsWith('-')) args.push('-e', parsed.pattern)
      else args.push(parsed.pattern)
      if (parsed.type) args.push('--type', parsed.type)
      if (parsed.glob) args.push('--glob', parsed.glob)
      args.push(target)

      const result = await runProcess('rg', args, cwd, signal)
      if (result.code !== 0 && result.code !== 1) {
        throw new Error(result.stderr || `rg exited with code ${result.code}`)
      }
      if (result.code === 1)
        return { content: mode === 'content' ? 'No matches found' : 'No files found' }
      const lines = result.stdout.trimEnd().split('\n').filter(Boolean)
      const offset = parsed.offset ?? 0
      const limit = parsed.head_limit === 0 ? undefined : (parsed.head_limit ?? 250)
      const selected = lines.slice(offset, limit === undefined ? undefined : offset + limit)
      const normalized =
        mode === 'files_with_matches'
          ? selected.map((line) => (isAbsolute(line) ? relative(cwd, line) : line))
          : selected
      return { content: normalized.join('\n') || 'No matches found' }
    },
    inputSchema: {
      additionalProperties: false,
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        glob: { type: 'string' },
        output_mode: { enum: ['content', 'files_with_matches', 'count'] },
      },
      required: ['pattern'],
      type: 'object',
    },
    getPermissionSubject: (input) => ({
      isReadOnly: true,
      matchesSpecifier: (pattern) =>
        typeof input.pattern === 'string' && matchesWildcard(pattern, input.pattern),
      name: 'Grep',
      requiresBypassConfirmation: false,
    }),
    isConcurrencySafe: () => true,
    name: 'Grep',
  }
}

async function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    const abort = () => child.kill('SIGTERM')
    signal.addEventListener('abort', abort, { once: true })
    child.once('error', reject)
    child.once('close', (code) => {
      signal.removeEventListener('abort', abort)
      resolvePromise({ code, stderr, stdout })
    })
    if (signal.aborted) abort()
  })
}
