#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseCliOptions } from './cli-options.js'
import { DOCK_VERSION } from './version.js'
export { DOCK_VERSION } from './version.js'

export type CliIo = {
  stdin?: () => Promise<string>
  stderr: (chunk: string) => void
  stdout: (chunk: string) => void
}

const defaultIo: CliIo = {
  stderr: (chunk) => process.stderr.write(chunk),
  stdin: readProcessStdin,
  stdout: (chunk) => process.stdout.write(chunk),
}

export async function runCli(args: readonly string[], io: CliIo = defaultIo): Promise<number> {
  if (args.includes('--version')) {
    io.stdout(`${DOCK_VERSION}\n`)
    return 0
  }
  try {
    const cli = parseCliOptions(args)
    if (cli.print) {
      const { startHeadless } = await import('./headless/start-headless.js')
      const abort = new AbortController()
      const onInterrupt = () => abort.abort('SIGINT')
      process.once('SIGINT', onInterrupt)
      try {
        const stdin = await (io.stdin ?? defaultIo.stdin)?.()
        try {
          return await startHeadless({
            args,
            cli,
            io,
            signal: abort.signal,
            ...(stdin !== undefined ? { stdin } : {}),
          })
        } catch (error) {
          if (!abort.signal.aborted) throw error
          io.stderr('Execution aborted\n')
          return 130
        }
      } finally {
        process.removeListener('SIGINT', onInterrupt)
      }
    } else {
      const { startDock } = await import('./start-dock.js')
      await startDock({ args, cli })
      return 0
    }
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function readProcessStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

const entrypoint = process.argv[1]
if (entrypoint && isEntrypoint(import.meta.url, entrypoint)) {
  process.exitCode = await runCli(process.argv.slice(2))
}

export function isEntrypoint(moduleUrl: string, executablePath: string): boolean {
  try {
    const modulePath = realpathSync(fileURLToPath(moduleUrl))
    const invokedPath = realpathSync(executablePath)
    return process.platform === 'win32'
      ? modulePath.toLowerCase() === invokedPath.toLowerCase()
      : modulePath === invokedPath
  } catch {
    return false
  }
}
