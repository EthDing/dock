import { describe, expect, it } from 'vitest'
import { runCli } from '../src/cli.js'

describe('dock CLI', () => {
  it('prints the current version', async () => {
    const output: string[] = []

    const exitCode = await runCli(['--version'], {
      stderr: () => {},
      stdout: (chunk) => output.push(chunk),
    })

    expect(exitCode).toBe(0)
    expect(output).toEqual(['0.0.0\n'])
  })
})
