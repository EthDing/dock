import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, readFile, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AgentWorktrees, assertIsolatedWrite } from '../../src/agents/worktrees.js'
const exec = promisify(execFile)
async function repo() {
  const cwd = await mkdtemp(join(tmpdir(), 'dock-agent-worktree-'))
  await exec('git', ['init', '-b', 'main', cwd])
  await exec('git', ['-C', cwd, 'config', 'user.email', 'test@example.invalid'])
  await exec('git', ['-C', cwd, 'config', 'user.name', 'Test'])
  await writeFile(join(cwd, 'file.txt'), 'base')
  await exec('git', ['-C', cwd, 'add', 'file.txt'])
  await exec('git', ['-C', cwd, 'commit', '-m', 'base'])
  return cwd
}
describe('agent worktrees', () => {
  it('creates at canonical root, validates, and removes only an unchanged owned worktree', async () => {
    const cwd = await repo(),
      manager = new AgentWorktrees()
    const handle = await manager.create(cwd, randomUUID(), 'head')
    expect(handle.path.startsWith(join(await realpath(cwd), '.dock/worktrees/'))).toBe(true)
    expect(await readFile(join(handle.path, 'file.txt'), 'utf8')).toBe('base')
    await manager.validate(handle)
    expect(await manager.finish(handle)).toBe('removed')
    await expect(manager.validate(handle)).rejects.toThrow()
  })
  it('retains modifications and rejects writes to the main checkout, without inspecting Bash', async () => {
    const cwd = await repo(),
      manager = new AgentWorktrees()
    const handle = await manager.create(cwd, randomUUID(), 'fresh')
    await writeFile(join(handle.path, 'file.txt'), 'changed')
    await expect(assertIsolatedWrite(join(cwd, 'file.txt'), handle)).rejects.toThrow()
    await expect(
      assertIsolatedWrite(join(handle.path, 'file.txt'), handle),
    ).resolves.toBeUndefined()
    expect(await manager.finish(handle)).toBe('retained')
    expect(await readFile(join(cwd, 'file.txt'), 'utf8')).toBe('base')
  })
  it('does not delete a foreign worktree or overwrite its metadata', async () => {
    const cwd = await repo(),
      manager = new AgentWorktrees()
    const handle = await manager.create(cwd, randomUUID(), 'head')
    await expect(manager.finish({ ...handle, agentId: randomUUID() })).rejects.toThrow()
    expect(await readFile(join(handle.path, 'file.txt'), 'utf8')).toBe('base')
  })
})
it('retains new commits, untracked and ignored files; never follows a symlink into the main checkout', async () => {
  const cwd = await repo(),
    manager = new AgentWorktrees()
  const committed = await manager.create(cwd, randomUUID(), 'head')
  await writeFile(join(committed.path, 'file.txt'), 'commit')
  await exec('git', ['-C', committed.path, 'add', 'file.txt'])
  await exec('git', ['-C', committed.path, 'commit', '-m', 'child'])
  expect(await manager.finish(committed)).toBe('retained')
  const untracked = await manager.create(cwd, randomUUID(), 'head')
  await writeFile(join(untracked.path, 'new.txt'), 'untracked')
  expect(await manager.finish(untracked)).toBe('retained')
  const ignored = await manager.create(cwd, randomUUID(), 'head')
  await writeFile(join(ignored.gitDir, 'info-temp'), 'irrelevant')
  await exec('git', ['-C', cwd, 'config', 'core.excludesFile', join(cwd, 'ignore-patterns')])
  await writeFile(join(cwd, 'ignore-patterns'), 'scratch.tmp\n')
  await writeFile(join(ignored.path, 'scratch.tmp'), 'keep')
  expect(await manager.finish(ignored)).toBe('retained')
  await symlink(cwd, join(ignored.path, 'main-link'))
  await expect(
    assertIsolatedWrite(join(ignored.path, 'main-link', 'file.txt'), ignored),
  ).rejects.toThrow('main checkout')
})

it('defaults to the remote default branch, while head uses the caller commit and never copies dirty files', async () => {
  const origin = await repo(),
    cwd = await mkdtemp(join(tmpdir(), 'dock-agent-clone-'))
  await exec('git', ['clone', origin, cwd])
  await exec('git', ['-C', cwd, 'config', 'user.email', 'test@example.invalid'])
  await exec('git', ['-C', cwd, 'config', 'user.name', 'Test'])
  await exec('git', ['-C', cwd, 'checkout', '-b', 'feature'])
  await writeFile(join(cwd, 'file.txt'), 'feature')
  await exec('git', ['-C', cwd, 'commit', '-am', 'feature'])
  await writeFile(join(cwd, 'file.txt'), 'dirty')
  const manager = new AgentWorktrees(),
    fresh = await manager.create(cwd, randomUUID()),
    head = await manager.create(cwd, randomUUID(), 'head')
  expect(await readFile(join(fresh.path, 'file.txt'), 'utf8')).toBe('base')
  expect(await readFile(join(head.path, 'file.txt'), 'utf8')).toBe('feature')
  expect(await readFile(join(cwd, 'file.txt'), 'utf8')).toBe('dirty')
  expect(await manager.finish(fresh)).toBe('removed')
  expect(await manager.finish(head)).toBe('removed')
})
