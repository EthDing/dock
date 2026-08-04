import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { z } from 'zod'
import { findContentRule } from '../permissions/evaluate-permission.js'
import { matchesCommandSpecifier } from '../permissions/specifier-matching.js'
import type { AgentTool } from './types.js'

const MAX_TIMEOUT_MS = 600_000
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_CHARS = 30_000

const inputSchema = z.strictObject({
  command: z.string().min(1),
  dangerouslyDisableSandbox: z.boolean().optional(),
  description: z.string().optional(),
  timeout: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
})

export type BashSandboxRuntime = {
  annotateFailure: (command: string, output: string) => string
  cleanupAfterCommand: () => void
  shouldUseSandbox: (input: { command: string; dangerouslyDisableSandbox?: boolean }) => boolean
  wrapCommand: (command: string, signal: AbortSignal, commandId: string) => Promise<string>
}

export function createBashTool(options: {
  cwd: string
  homeDir?: string
  sandbox?: BashSandboxRuntime
}): AgentTool {
  const cwd = resolve(options.cwd)
  const tool: AgentTool = {
    description: 'Executes a shell command in the project environment.',
    async execute(input, { signal, toolUseId }) {
      const parsed = inputSchema.parse(input)
      const sandbox = options.sandbox
      const sandboxed =
        sandbox?.shouldUseSandbox({
          command: parsed.command,
          ...(parsed.dangerouslyDisableSandbox === undefined
            ? {}
            : { dangerouslyDisableSandbox: parsed.dangerouslyDisableSandbox }),
        }) ?? false
      const command =
        sandboxed && sandbox
          ? await sandbox.wrapCommand(parsed.command, signal, toolUseId)
          : parsed.command
      let result: Awaited<ReturnType<typeof runBash>>
      try {
        result = await runBash(command, cwd, parsed.timeout ?? DEFAULT_TIMEOUT_MS, signal)
      } finally {
        if (sandboxed && sandbox) sandbox.cleanupAfterCommand()
      }
      const rawOutput =
        result.code === 0
          ? result.output
          : (sandbox?.annotateFailure(parsed.command, result.output) ?? result.output)
      const output = truncateEnd(rawOutput.trimEnd())
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
        dangerouslyDisableSandbox: { type: 'boolean' },
        description: { type: 'string' },
        timeout: { maximum: MAX_TIMEOUT_MS, minimum: 1, type: 'integer' },
      },
      required: ['command'],
      type: 'object',
    },
    checkPermissions: (input, context) => {
      const command = typeof input.command === 'string' ? input.command : ''
      const matchesSpecifier = (pattern: string) => matchesCommandSpecifier(pattern, command)
      const denyRule = findContentRule(context.rules, 'deny', tool.name, matchesSpecifier)
      if (denyRule) {
        return {
          behavior: 'deny',
          message: 'Permission denied for Bash',
          rule: denyRule,
          source: 'rule',
        }
      }
      const askRule = findContentRule(context.rules, 'ask', tool.name, matchesSpecifier)
      if (askRule) {
        return {
          behavior: 'ask',
          message: 'Permission required for Bash',
          rule: askRule,
          source: 'rule',
        }
      }
      if (requiresBypassConfirmation(command, options.homeDir ?? process.env.HOME ?? '')) {
        return {
          behavior: 'ask',
          message: 'Recursive deletion of a critical path requires confirmation',
          source: 'circuit_breaker',
        }
      }
      if (
        context.mode !== 'plan' &&
        context.autoAllowBashIfSandboxed?.() === true &&
        context.isBashSandboxed?.(tool, input) === true
      ) {
        return { behavior: 'allow', source: 'internal', updatedInput: input }
      }
      if (context.mode !== 'dontAsk' && isReadOnlyBashCommand(command)) {
        return { behavior: 'allow', source: 'tool', updatedInput: input }
      }
      const allowRule = findContentRule(context.rules, 'allow', tool.name, matchesSpecifier)
      if (allowRule) {
        return { behavior: 'allow', rule: allowRule, source: 'rule', updatedInput: input }
      }
      return { behavior: 'passthrough', source: 'tool', updatedInput: input }
    },
    getPermissionRule: (input) =>
      typeof input.command === 'string' ? `Bash(${input.command})` : undefined,
    isConcurrencySafe: (input) =>
      typeof input.command === 'string' && isReadOnlyBashCommand(input.command),
    name: 'Bash',
    parseInput: (input) => inputSchema.parse(input),
  }
  return tool
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
