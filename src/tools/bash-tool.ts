import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { AgentTool } from './types.js'

const MAX_TIMEOUT_MS = 600_000
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_CHARS = 30_000

const inputSchema = z.strictObject({
  command: z.string().min(1),
  description: z.string().optional(),
  timeout: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
})

export function createBashTool(options: { cwd: string }): AgentTool {
  const cwd = resolve(options.cwd)
  return {
    description: 'Executes a shell command in the project environment.',
    async execute(input, { signal }) {
      const parsed = inputSchema.parse(input)
      const result = await runBash(
        parsed.command,
        cwd,
        parsed.timeout ?? DEFAULT_TIMEOUT_MS,
        signal,
      )
      const output = truncateEnd(result.output.trimEnd())
      const suffix = result.code === 0 ? '' : `${output ? '\n' : ''}Exit code ${result.code ?? 1}`
      return {
        content: `${output}${suffix}`,
        ...(result.code === 0 && !result.interrupted ? {} : { isError: true }),
      }
    },
    inputSchema: {
      additionalProperties: false,
      properties: {
        command: { type: 'string' },
        description: { type: 'string' },
        timeout: { maximum: MAX_TIMEOUT_MS, minimum: 1, type: 'integer' },
      },
      required: ['command'],
      type: 'object',
    },
    isConcurrencySafe: (input) =>
      typeof input.command === 'string' && isReadOnlyBashCommand(input.command),
    name: 'Bash',
  }
}

export function isReadOnlyBashCommand(command: string): boolean {
  if (/[>|`]|\$\(|<\(/.test(command)) return false
  const parts = command.split(/&&|\|\||;|\n|\|(?!\|)/).map((part) => part.trim())
  if (parts.length === 0) return false
  return parts.every((part) => {
    const [name, ...args] = part.split(/\s+/)
    if (!name) return false
    if (
      [
        'ls',
        'cat',
        'echo',
        'pwd',
        'head',
        'tail',
        'grep',
        'rg',
        'wc',
        'which',
        'diff',
        'stat',
        'du',
      ].includes(name)
    ) {
      return true
    }
    if (name === 'find')
      return !args.some((arg) => arg === '-delete' || arg === '-exec' || arg === '-execdir')
    if (name === 'git') {
      return ['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files'].includes(
        args[0] ?? '',
      )
    }
    return false
  })
}

export function requiresBypassConfirmation(command: string, homeDir: string): boolean {
  const normalized = command.replace(/\s+/g, ' ').trim()
  return (
    /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-rf|-fr)\s+\/$/.test(normalized) ||
    normalized.includes(`rm -rf ${homeDir}`) ||
    normalized.includes('rm -rf ~')
  )
}

async function runBash(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ code: number | null; interrupted: boolean; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd,
      detached: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let interrupted = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      output += chunk
    })

    const terminate = () => {
      interrupted = true
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch {
          child.kill('SIGTERM')
        }
      }
    }
    const timeout = setTimeout(terminate, timeoutMs)
    signal.addEventListener('abort', terminate, { once: true })
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', terminate)
      resolvePromise({ code, interrupted, output })
    })
    if (signal.aborted) terminate()
  })
}

function truncateEnd(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output
  return `[Output truncated; showing final ${MAX_OUTPUT_CHARS} characters]\n${output.slice(-MAX_OUTPUT_CHARS)}`
}
