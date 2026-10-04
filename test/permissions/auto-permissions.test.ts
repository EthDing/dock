import { mkdtemp, mkdir, symlink, writeFile, link, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutoClassifier, AutoPermissionState } from '../../src/permissions/auto-classifier.js'
import { autoPermissionRules, isBroadExecutionRule } from '../../src/permissions/auto-rules.js'
import { createCanUseTool } from '../../src/permissions/can-use-tool.js'
import {
  resolvePermission,
  type PermissionRules,
} from '../../src/permissions/evaluate-permission.js'
import { PermissionModeState } from '../../src/permissions/permission-mode-state.js'
import { SessionPermissionState } from '../../src/permissions/session-permission-state.js'
import { FakeModelAdapter } from '../../src/model/fake-model.js'
import { createBashTool } from '../../src/tools/bash-tool.js'
import { createReadTool, createWriteTool } from '../../src/tools/file-tools.js'
import { createGrepTool } from '../../src/tools/search-tools.js'
import { FileReadState } from '../../src/tools/file-read-state.js'
import { execution, response, review } from './auto-fixtures.js'

const bash = createBashTool({ cwd: '/work', homeDir: '/home/test' })
function setup(script: string[], interactive = true, rules: PermissionRules = {}) {
  const model = new FakeModelAdapter(script.map(response))
  const state = new AutoPermissionState()
  const mode = new PermissionModeState('auto')
  const sessionPermissions = new SessionPermissionState()
  const requestApproval = vi.fn(async () => ({ behavior: 'deny' as const }))
  const canUse = createCanUseTool({
    mode: () => mode.value,
    rules,
    requestApproval,
    sessionPermissions,
    auto: {
      state,
      interactive,
      classifier: new AutoClassifier({
        repository: '/work',
        resolveModel: async () => ({ model, modelId: 'test' }),
      }),
    },
    autoAllowBashIfSandboxed: () => true,
    isBashSandboxed: () => true,
  })
  return { model, state, mode, sessionPermissions, requestApproval, canUse }
}

describe('auto rule ordering and fallback', () => {
  it.each([
    'Bash',
    'Bash(*)',
    '*',
    'B*',
    'Bash(python*)',
    'Bash(/usr/bin/python3 *)',
    'Bash(node -e *)',
    'Bash(sh -c *)',
    'Bash("python" *)',
    'Bash(p* *)',
    'Bash(npm run *)',
    'Bash(pnpm exec *)',
    'Bash(yarn *)',
    'Bash(* --version)',
    'Agent',
    'SendMessage',
  ])('filters broad execution rule %s', (rule) => expect(isBroadExecutionRule(rule)).toBe(true))
  it.each([
    'Bash(git status)',
    'Bash(npm test)',
    'Bash(npm test *)',
    'Bash(prettier *)',
    'Read',
    'WebFetch(domain:example.com)',
  ])('preserves narrow rule %s', (rule) => expect(isBroadExecutionRule(rule)).toBe(false))
  it('does not mutate rules and restores broad rules when leaving auto, including later additions', async () => {
    const rules = { allow: ['Bash(*)'], deny: ['Bash(rm *)'], ask: ['Bash(git push *)'] }
    const view = autoPermissionRules(rules)
    expect(view.allow).toEqual([])
    expect(view.deny).toEqual(rules.deny)
    const mode = new PermissionModeState('default')
    const check = () =>
      resolvePermission(bash, { command: 'node app.js' }, { mode: mode.value, rules })
    expect((await check()).behavior).toBe('allow')
    mode.set('auto')
    expect((await check()).behavior).toBe('ask')
    rules.allow.push('Bash(node *)')
    expect((await check()).behavior).toBe('ask')
    mode.set('default')
    expect((await check()).behavior).toBe('allow')
    expect(rules.allow).toEqual(['Bash(*)', 'Bash(node *)'])
  })
  it.each([
    { deny: ['Bash'] },
    { deny: ['Bash(rm *)'] },
    { ask: ['Bash'] },
    { ask: ['Bash(rm *)'] },
  ])('keeps explicit rules ahead of classifier and sandbox %j', async (rule) => {
    const s = setup([], true, { allow: ['Bash(*)'], ...rule })
    expect((await s.canUse(bash, { command: 'rm file' }, execution())).behavior).toBe('deny')
    expect(s.model.requests).toHaveLength(0)
    expect(s.requestApproval).toHaveBeenCalledTimes('ask' in rule ? 1 : 0)
  })
  it('preserves the critical deletion circuit breaker', async () => {
    const s = setup(['ALLOW'])
    await s.canUse(bash, { command: 'rm -rf /' }, execution())
    expect(s.model.requests).toHaveLength(0)
    expect(s.requestApproval).toHaveBeenCalledOnce()
  })
  it('classifies sandbox commands and calls allowed in the manual session', async () => {
    const s = setup(['ALLOW'])
    s.sessionPermissions.allow(bash, { command: 'npm test' })
    expect((await s.canUse(bash, { command: 'npm test' }, execution())).behavior).toBe('allow')
    expect(s.model.requests).toHaveLength(1)
  })
  it('does not let a narrow allow launder a compound shell command', async () => {
    const s = setup(['BLOCK', review()], false, { allow: ['Bash(git status)', 'Bash(npm test *)'] })
    expect((await s.canUse(bash, { command: 'git status && rm file' }, execution())).behavior).toBe(
      'deny',
    )
    const result = await resolvePermission(
      bash,
      { command: 'npm test ; rm file' },
      { mode: 'auto', rules: { allow: ['Bash(npm test *)'] } },
    )
    expect(result.behavior).toBe('ask')
  })
  it('escalates after three classifier denials, without restoring broad allows or executing the third call', async () => {
    const s = setup(Array.from({ length: 3 }, () => ['BLOCK', review()]).flat(), true, {
      allow: ['Bash(*)'],
    })
    for (let i = 0; i < 3; i++) {
      expect(await s.canUse(bash, { command: 'npm test' }, execution())).toMatchObject({
        behavior: 'deny',
        message: expect.stringContaining('do not bypass'),
      })
      expect(s.requestApproval).not.toHaveBeenCalled()
    }
    expect(s.state.requiresHuman).toBe(true)
    await s.canUse(bash, { command: 'npm test' }, execution())
    expect(s.model.requests).toHaveLength(6)
    expect(s.requestApproval).toHaveBeenCalledOnce()
  })
  it('resets consecutive denials only on classifier allow and escalates at twenty total', async () => {
    const s = setup(Array.from({ length: 20 }, () => ['BLOCK', review(), 'ALLOW']).flat())
    for (let i = 0; i < 19; i++) {
      await s.canUse(bash, { command: 'npm test' }, execution())
      await s.canUse(bash, { command: 'npm test' }, execution())
    }
    expect(s.state.consecutiveBlocks).toBe(0)
    expect(s.state.requiresHuman).toBe(false)
    await s.canUse(bash, { command: 'npm test' }, execution())
    expect(s.state.totalBlocks).toBe(20)
    await s.canUse(bash, { command: 'npm test' }, execution())
    expect(s.requestApproval).toHaveBeenCalledOnce()
  })
  it('keeps headless sessions running and reviewing after both thresholds', async () => {
    const s = setup(
      [...Array.from({ length: 21 }, () => ['BLOCK', review()]).flat(), 'ALLOW'],
      false,
    )
    for (let i = 0; i < 21; i++)
      expect((await s.canUse(bash, {}, execution())).behavior).toBe('deny')
    expect((await s.canUse(bash, {}, execution())).behavior).toBe('allow')
    expect(s.state.totalBlocks).toBe(21)
    expect(s.requestApproval).not.toHaveBeenCalled()
  })
  it('shares escalation with another agent and requires approval for an in-flight classifier allow', async () => {
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const state = new AutoPermissionState()
    let started = false
    const model = {
      async *stream() {
        started = true
        await waiting
        yield* response('ALLOW')
      },
    }
    const monitor = new AutoClassifier({
      repository: '/work',
      resolveModel: async () => ({ model, modelId: 'test' }),
    })
    const requestApproval = vi.fn(async () => ({ behavior: 'deny' as const }))
    const options = {
      mode: 'auto' as const,
      rules: {},
      requestApproval,
      auto: { classifier: monitor, state, interactive: true },
    }
    const parent = createCanUseTool(options),
      child = createCanUseTool(options)
    const pending = parent(bash, {}, execution())
    await vi.waitFor(() => expect(started).toBe(true))
    for (let i = 0; i < 3; i++) state.record({ behavior: 'deny', message: 'blocked other call' })
    release()
    expect((await pending).behavior).toBe('deny')
    expect(state.requiresHuman).toBe(true)
    expect((await child(bash, {}, execution())).behavior).toBe('deny')
    expect(requestApproval).toHaveBeenCalledTimes(2)
  })
})

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function files() {
  const root = await mkdtemp(join(tmpdir(), 'dock-auto-'))
  roots.push(root)
  const cwd = join(root, 'repo')
  await mkdir(cwd)
  const deps = {
    cwd,
    fileHistory: { trackEdit: async () => {} },
    readFileState: new FileReadState(),
  }
  return { root, cwd, write: createWriteTool(deps), read: createReadTool(deps) }
}
describe('auto filesystem boundary', () => {
  it('reviews system shell startup files even with an explicit whole-tool allow', async () => {
    const f = await files()
    for (const file_path of [
      '/etc/profile',
      '/etc/profile.d/new.sh',
      '/etc/bash.bashrc',
      '/etc/zsh/zshrc',
    ])
      expect(
        await resolvePermission(
          f.write,
          { file_path },
          { mode: 'auto', rules: { allow: ['Write'] } },
        ),
      ).toMatchObject({ behavior: 'ask', source: 'auto' })
  })
  it('protects configuration when cwd is inside .dock but allows ordinary owned worktree edits', async () => {
    const f = await files()
    for (const [dir, behavior] of [
      ['.dock', 'ask'],
      ['.dock/worktrees/agent-test', 'allow'],
    ] as const) {
      const cwd = join(f.cwd, dir)
      await mkdir(cwd, { recursive: true })
      const write = createWriteTool({
        cwd,
        fileHistory: { trackEdit: async () => {} },
        readFileState: new FileReadState(),
      })
      expect(
        (
          await resolvePermission(
            write,
            { file_path: join(cwd, 'file') },
            { mode: 'auto', rules: {} },
          )
        ).behavior,
      ).toBe(behavior)
    }
  })
  it('allows ordinary in-directory reads/edits and sends external operations to review', async () => {
    const f = await files()
    for (const tool of [f.read, f.write]) {
      expect(
        (
          await resolvePermission(
            tool,
            { file_path: join(f.cwd, 'src/new.ts') },
            { mode: 'auto', rules: {} },
          )
        ).behavior,
      ).toBe('allow')
      expect(
        (
          await resolvePermission(
            tool,
            { file_path: join(f.root, 'external') },
            { mode: 'auto', rules: {} },
          )
        ).behavior,
      ).toBe('ask')
    }
  })
  it.each([
    '.dock/settings.json',
    '.dock/settings.local.json',
    '.git/hooks/pre-commit',
    '.git/config',
    '.bashrc',
    '.zshenv',
    '.profile',
    '.envrc',
    '.gitconfig',
    '.config/fish/config.fish',
  ])('reviews protected write %s despite allow and internal allowances', async (path) => {
    const f = await files()
    expect(
      await resolvePermission(
        f.write,
        { file_path: join(f.cwd, path) },
        { mode: 'auto', rules: { allow: ['Write'] }, autoAllowInternalToolUse: () => true },
      ),
    ).toMatchObject({ behavior: 'ask', source: 'auto' })
  })
  it('keeps deny and ask above automatic file edits', async () => {
    const f = await files()
    for (const behavior of ['deny', 'ask'] as const)
      expect(
        await resolvePermission(
          f.write,
          { file_path: join(f.cwd, 'a') },
          { mode: 'auto', rules: { [behavior]: ['Write(a)'] } },
        ),
      ).toMatchObject({ behavior, source: 'rule' })
  })
  it('resolves directory symlinks, protected aliases, and hardlinks before auto approval', async () => {
    const f = await files()
    await mkdir(join(f.root, 'outside'))
    await symlink(join(f.root, 'outside'), join(f.cwd, 'link'))
    await mkdir(join(f.cwd, '.git'))
    await symlink(join(f.cwd, '.git'), join(f.cwd, 'alias'))
    await symlink(join(f.root, 'not-created-yet'), join(f.cwd, 'dangling'))
    await writeFile(join(f.root, 'outside', 'existing'), 'x')
    await link(join(f.root, 'outside', 'existing'), join(f.cwd, 'hardlink'))
    for (const path of ['link/new/file', 'alias/config', 'hardlink', 'dangling'])
      expect(
        (
          await resolvePermission(
            f.write,
            { file_path: join(f.cwd, path) },
            { mode: 'auto', rules: {} },
          )
        ).behavior,
      ).toBe('ask')
    expect(
      (
        await resolvePermission(
          createGrepTool({ cwd: f.cwd }),
          { path: join(f.cwd, 'link'), pattern: 'x' },
          { mode: 'auto', rules: {} },
        )
      ).behavior,
    ).toBe('ask')
  })
})
