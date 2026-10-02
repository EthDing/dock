import type { PermissionMode } from './permissions/evaluate-permission.js'

export type HeadlessOutputFormat = 'text' | 'json' | 'stream-json'

export type CliOptions = {
  continueSession: boolean
  forkSession: boolean
  print: boolean
  noMemory: boolean
  outputFormat: HeadlessOutputFormat
  maxTurns?: number
  model?: string
  name?: string
  permissionMode?: PermissionMode
  prompt?: string
  resume?: string
}

export function parseCliOptions(args: readonly string[]): CliOptions {
  const result: CliOptions = {
    continueSession: false,
    forkSession: false,
    noMemory: false,
    outputFormat: 'text',
    print: false,
  }
  const prompts: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-p' || arg === '--print') result.print = true
    else if (arg === '--continue') result.continueSession = true
    else if (arg === '--fork-session') result.forkSession = true
    else if (arg === '--resume') result.resume = requiredValue(args, ++index, arg)
    else if (arg === '--model') result.model = requiredValue(args, ++index, arg)
    else if (arg === '--name') result.name = requiredValue(args, ++index, arg)
    else if (arg === '--no-memory') result.noMemory = true
    else if (arg === '--max-turns') {
      const value = requiredValue(args, ++index, arg)
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed <= 0)
        throw new Error('--max-turns requires a positive integer')
      result.maxTurns = parsed
    } else if (arg === '--output-format') {
      const value = requiredValue(args, ++index, arg)
      if (!isOutputFormat(value)) throw new Error(`Unknown output format ${value}`)
      result.outputFormat = value
    } else if (arg === '--permission-mode') {
      const mode = requiredValue(args, ++index, arg)
      if (!isPermissionMode(mode)) throw new Error(`Unknown permission mode ${mode}`)
      result.permissionMode = mode
    } else if (arg?.startsWith('-')) throw new Error(`Unknown option ${arg}`)
    else if (arg !== undefined) prompts.push(arg)
  }
  if (prompts.length > 1) throw new Error('Print mode accepts only one prompt argument')
  const prompt = prompts[0]
  if (prompt !== undefined) result.prompt = prompt
  if (!result.print && result.prompt) throw new Error('A prompt argument requires --print')
  if (!result.print && result.maxTurns !== undefined)
    throw new Error('--max-turns is only available with --print')
  if (!result.print && result.outputFormat !== 'text')
    throw new Error('--output-format is only available with --print')
  if (!result.print && result.noMemory)
    throw new Error('--no-memory is only available with --print')
  return result
}

export function combineHeadlessPrompt(prompt: string | undefined, stdin: string): string {
  const piped = stdin.trimEnd()
  const explicit = prompt?.trim()
  const combined = piped && explicit ? `${piped}\n\n${explicit}` : piped || explicit || ''
  if (!combined) throw new Error('Print mode requires a prompt')
  return combined
}

function requiredValue(args: readonly string[], index: number, option: string): string {
  const value = args[index]
  if (!value) throw new Error(`${option} requires a value`)
  return value
}

function isOutputFormat(value: string): value is HeadlessOutputFormat {
  return value === 'text' || value === 'json' || value === 'stream-json'
}

function isPermissionMode(value: string): value is PermissionMode {
  return ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'].includes(value)
}
