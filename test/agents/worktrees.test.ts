import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, readFile, realpath } from 'node:fs/promises'
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
