import { mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isEntrypoint, runCli } from '../src/cli.js'

describe('dock CLI', () => {
  it('prints the current version', async () => {
    const output: string[] = []

    const exitCode = await runCli(['--version'], {
      stderr: () => {},
      stdout: (chunk) => output.push(chunk),
    })

    expect(exitCode).toBe(0)
    expect(output).toEqual(['0.1.1\n'])
  })

  it('recognizes invocation through an installed bin symlink', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dock-cli-'))
    const modulePath = join(directory, 'cli.js')
    const binPath = join(directory, 'dock')
    await writeFile(modulePath, '')
    await symlink(modulePath, binPath)

    expect(isEntrypoint(pathToFileURL(modulePath).href, binPath)).toBe(true)
  })

  it('rejects headless-only flags without print mode', async () => {
    const errors: string[] = []
    const exitCode = await runCli(['--max-turns', '2'], {
      stderr: (chunk) => errors.push(chunk),
      stdout: () => {},
    })
    expect(exitCode).toBe(1)
    expect(errors.join('')).toContain('--max-turns is only available with --print')
  })
})
