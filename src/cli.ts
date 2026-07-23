#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

export const DOCK_VERSION = '0.0.0'

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
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await runCli(process.argv.slice(2))
}
