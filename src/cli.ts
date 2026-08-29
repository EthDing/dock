#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DOCK_VERSION } from './version.js'
export { DOCK_VERSION } from './version.js'

export type CliIo = {
  stderr: (chunk: string) => void
  stdout: (chunk: string) => void
}

const defaultIo: CliIo = {
  stderr: (chunk) => process.stderr.write(chunk),
  stdout: (chunk) => process.stdout.write(chunk),
}

export async function runCli(args: readonly string[], io: CliIo = defaultIo): Promise<number> {
  if (args.includes('--version')) {
    io.stdout(`${DOCK_VERSION}\n`)
    return 0
  }
  try {
    const { startDock } = await import('./start-dock.js')
    await startDock({ args })
    return 0
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
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
