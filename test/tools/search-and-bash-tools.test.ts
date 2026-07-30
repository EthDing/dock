import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createBashTool } from '../../src/tools/bash-tool.js'
import { createGlobTool, createGrepTool } from '../../src/tools/search-tools.js'
import { asMessageUuid } from '../../src/sessions/ids.js'

const executionOptions = {
  parentMessageUuid: asMessageUuid('a0000000-0000-4000-8000-000000000001'),
  signal: new AbortController().signal,
  toolUseId: 'tool-1',
}

describe('search tools', () => {
  it('finds glob matches and grep matches with bounded output', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dock-search-tools-'))
    await mkdir(join(cwd, 'src'), { recursive: true })
    await Promise.all([
      writeFile(join(cwd, 'src', 'a.ts'), 'const needle = 1\n'),
      writeFile(join(cwd, 'src', 'b.ts'), 'const other = 2\n'),
      writeFile(join(cwd, 'README.md'), 'needle\n'),
    ])
    const glob = createGlobTool({ cwd })
    const grep = createGrepTool({ cwd })

    const globResult = await glob.execute({ pattern: '**/*.ts' }, executionOptions)
    const grepResult = await grep.execute(
      { pattern: 'needle', path: cwd, output_mode: 'files_with_matches' },
      executionOptions,
    )

    expect(globResult.content.split('\n').sort()).toEqual(['src/a.ts', 'src/b.ts'])
    expect(grepResult.content.split('\n').sort()).toEqual(['README.md', 'src/a.ts'])
  })
})

describe('Bash tool', () => {
  it('runs a command in the project directory and reports failures', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dock-bash-tool-'))
    const bash = createBashTool({ cwd })

    const success = await bash.execute({ command: 'pwd' }, executionOptions)
    const failure = await bash.execute({ command: 'printf failure; exit 7' }, executionOptions)

    expect(success.content.trim()).toBe(cwd)
    expect(failure).toMatchObject({ isError: true })
    expect(failure.content).toContain('failure')
    expect(failure.content).toContain('Exit code 7')
  })

  it('executes the sandbox-wrapped command and cleans up afterward', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dock-bash-tool-'))
    const sandbox = {
      annotateFailure: (_command: string, output: string) => output,
      cleanupAfterCommand: vi.fn(),
      shouldUseSandbox: vi.fn(() => true),
      wrapCommand: vi.fn(async () => 'printf sandboxed'),
    }
    const bash = createBashTool({ cwd, sandbox })

    const result = await bash.execute({ command: 'printf original' }, executionOptions)

    expect(result.content).toBe('sandboxed')
    expect(sandbox.wrapCommand).toHaveBeenCalledWith(
      'printf original',
      executionOptions.signal,
      executionOptions.toolUseId,
    )
    expect(sandbox.cleanupAfterCommand).toHaveBeenCalledOnce()
  })
})
