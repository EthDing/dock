import { describe, expect, it } from 'vitest'
import {
  resolvePermission,
  type ToolPermissionContext,
} from '../../src/permissions/evaluate-permission.js'
import { createBashTool } from '../../src/tools/bash-tool.js'
import { FileReadState } from '../../src/tools/file-read-state.js'
import { createReadTool, createWriteTool } from '../../src/tools/file-tools.js'
import { createGlobTool, createGrepTool } from '../../src/tools/search-tools.js'

const context = (options: Partial<ToolPermissionContext> = {}): ToolPermissionContext => ({
  mode: options.mode ?? 'default',
  rules: options.rules ?? {},
  ...(options.autoAllowBashIfSandboxed
    ? { autoAllowBashIfSandboxed: options.autoAllowBashIfSandboxed }
    : {}),
  ...(options.autoAllowInternalToolUse
    ? { autoAllowInternalToolUse: options.autoAllowInternalToolUse }
    : {}),
  ...(options.isBashSandboxed ? { isBashSandboxed: options.isBashSandboxed } : {}),
})

const fileDependencies = {
  cwd: '/work',
  fileHistory: { trackEdit: async () => {} },
  readFileState: new FileReadState(),
}

describe('file and search tool permissions', () => {
  it('allows working-directory reads and asks for external reads', async () => {
    const read = createReadTool(fileDependencies)

    await expect(
      resolvePermission(read, { file_path: '/work/file.ts' }, context()),
    ).resolves.toMatchObject({ behavior: 'allow' })
    await expect(
      resolvePermission(read, { file_path: '/outside/file.ts' }, context()),
    ).resolves.toMatchObject({ behavior: 'ask', source: 'fallback' })
  })

  it('allows acceptEdits writes, denies plan writes, and auto-allows internal memory', async () => {
    const write = createWriteTool(fileDependencies)

    await expect(
      resolvePermission(
        write,
        { content: 'x', file_path: '/work/file.ts' },
        context({ mode: 'acceptEdits' }),
      ),
    ).resolves.toMatchObject({ behavior: 'allow' })
    await expect(
      resolvePermission(
        write,
        { content: 'x', file_path: '/work/file.ts' },
        context({ mode: 'plan' }),
      ),
    ).resolves.toMatchObject({ behavior: 'deny', source: 'mode' })
    await expect(
      resolvePermission(
        write,
        { content: 'x', file_path: '/memory/topic.md' },
        context({
          autoAllowInternalToolUse: (_tool, input) => input.file_path === '/memory/topic.md',
          mode: 'plan',
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'allow', source: 'internal' })
  })

  it('keeps explicit content asks ahead of internal path allowances', async () => {
    const write = createWriteTool(fileDependencies)
    await expect(
      resolvePermission(
        write,
        { content: 'x', file_path: '/memory/topic.md' },
        context({
          autoAllowInternalToolUse: () => true,
          rules: { ask: ['Write(//memory/*)'] },
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'ask', source: 'rule' })
  })

  it('applies the same read boundary to Glob and Grep', async () => {
    for (const tool of [createGlobTool({ cwd: '/work' }), createGrepTool({ cwd: '/work' })]) {
      await expect(
        resolvePermission(tool, { path: '/work/src', pattern: 'x' }, context()),
      ).resolves.toMatchObject({ behavior: 'allow' })
      await expect(
        resolvePermission(tool, { path: '/outside', pattern: 'x' }, context()),
      ).resolves.toMatchObject({ behavior: 'ask' })
    }
  })
})

describe('Bash permissions', () => {
  const bash = createBashTool({ cwd: '/work', homeDir: '/home/user' })

  it('passes all ordinary commands through without a shell parser', async () => {
    await expect(
      resolvePermission(bash, { command: 'git status' }, context()),
    ).resolves.toMatchObject({ behavior: 'ask', source: 'fallback' })
    await expect(
      resolvePermission(bash, { command: 'npm test' }, context()),
    ).resolves.toMatchObject({ behavior: 'ask', source: 'fallback' })
    expect(bash.isConcurrencySafe({ command: 'git status' })).toBe(false)
  })

  it('denies passthrough commands in plan mode', async () => {
    await expect(
      resolvePermission(bash, { command: 'npm test' }, context({ mode: 'plan' })),
    ).resolves.toMatchObject({ behavior: 'deny', source: 'mode' })
  })

  it('keeps the recursive-delete breaker ahead of bypass and sandbox auto-allow', async () => {
    await expect(
      resolvePermission(
        bash,
        { command: 'rm -rf /' },
        context({
          autoAllowBashIfSandboxed: () => true,
          isBashSandboxed: () => true,
          mode: 'bypassPermissions',
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'ask', source: 'circuit_breaker' })
  })

  it('auto-allows commands that actually run inside the sandbox', async () => {
    await expect(
      resolvePermission(
        bash,
        { command: 'npm test' },
        context({
          autoAllowBashIfSandboxed: () => true,
          isBashSandboxed: () => true,
        }),
      ),
    ).resolves.toMatchObject({ behavior: 'allow', source: 'internal' })
  })
})
