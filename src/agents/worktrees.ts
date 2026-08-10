import { execFile } from 'node:child_process'
import type { UUID } from 'node:crypto'
import { readFile, writeFile, mkdir, realpath, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
const execute = promisify(execFile)

export type AgentWorktree = {
  agentId: UUID
  path: string
  branch: string
  baseCommit: string
  gitRoot: string
  gitDir: string
  parentCwd: string
}

async function git(cwd: string, args: readonly string[], timeout = 10_000): Promise<string> {
  const env = { ...process.env }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'])
    delete env[key]
  const result = await execute('git', ['-C', cwd, ...args], {
    env,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  })
  return result.stdout.trim()
}
function inside(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))
}
async function existingRealPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return join(await existingRealPath(parent), relative(parent, path))
  }
}
export async function assertIsolatedWrite(path: string, handle: AgentWorktree): Promise<void> {
  const actual = await existingRealPath(resolve(path))
  const own = await realpath(handle.path)
  if (inside(actual, own)) return
  if (inside(actual, handle.gitRoot) || inside(actual, handle.parentCwd)) {
    throw new Error('Worktree isolation: file tools cannot write to the main checkout')
  }
}

export class AgentWorktrees {
  async create(
    parentCwd: string,
    agentId: UUID,
    baseRef: 'fresh' | 'head' = 'fresh',
    exactCommit?: string,
  ): Promise<AgentWorktree> {
    if (!/^[a-f0-9-]{36}$/.test(agentId)) throw new Error('Invalid agent ID')
    const list = await git(parentCwd, ['worktree', 'list', '--porcelain'])
    const first = list.split('\n').find((line) => line.startsWith('worktree '))
    if (!first) throw new Error('Cannot create an agent worktree outside a Git repository')
    const gitRoot = await realpath(first.slice('worktree '.length))
    const commonDir = await git(parentCwd, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ])
    let baseCommit = await git(parentCwd, [
      'rev-parse',
      exactCommit ? `${exactCommit}^{commit}` : 'HEAD',
    ])
    if (!exactCommit && baseRef === 'fresh') {
      const cached = await git(parentCwd, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']).catch(
        () => '',
      )
      const cachedCommit = cached ? await git(parentCwd, ['rev-parse', cached]).catch(() => '') : ''
      if (cachedCommit) baseCommit = cachedCommit
      const fetchAge = await stat(join(commonDir, 'FETCH_HEAD')).then(
        (info) => Date.now() - info.mtimeMs,
        () => Infinity,
      )
      if (!cachedCommit || fetchAge > 86_400_000) {
        const branch = cached.replace(/^refs\/remotes\/origin\//, '') || 'HEAD'
        try {
          await git(parentCwd, ['fetch', '--quiet', '--no-tags', 'origin', branch], 5000)
          baseCommit = await git(parentCwd, ['rev-parse', 'FETCH_HEAD'])
        } catch {
          /* The documented offline fallback keeps the cached ref or HEAD. */
        }
      }
    }
    const path = join(gitRoot, '.dock', 'worktrees', `agent-${agentId}`)
    const branch = `dock/agent-${agentId}`
    await mkdir(dirname(path), { recursive: true })
    const exclude = join(commonDir, 'info', 'exclude')
    await mkdir(dirname(exclude), { recursive: true })
    const previous = await readFile(exclude, 'utf8').catch(() => '')
    if (!previous.split('\n').includes('/.dock/worktrees/'))
      await writeFile(exclude, previous + '\n/.dock/worktrees/\n')
    const config = await git(parentCwd, [
      'config',
      '--local',
      '--get-regexp',
      '^(filter\\.|includeIf\\.)',
    ]).catch((error) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 1) return ''
      throw new Error('Cannot inspect repository filters before creating worktree')
    })
    if (/^includeif\./im.test(config))
      throw new Error('Cannot safely create worktree with repository-local includeIf')
    const filters = new Set(
      config.split('\n').flatMap((line) => {
        const match = line.match(/^filter\.(.+)\.(?:smudge|clean|process|required)\s/)
        return match?.[1] ? [match[1]] : []
      }),
    )
    const flags = ['-c', 'core.hooksPath=/dev/null', '-c', 'submodule.recurse=false']
    for (const filter of filters) {
      if (/[=\r\n]/.test(filter)) throw new Error('Unsafe repository filter name')
      flags.push(
        '-c',
        `filter.${filter}.smudge=`,
        '-c',
        `filter.${filter}.clean=`,
        '-c',
        `filter.${filter}.process=`,
        '-c',
        `filter.${filter}.required=false`,
      )
    }
    await git(gitRoot, [...flags, 'worktree', 'add', '-b', branch, path, baseCommit])
    const gitDir = await git(path, ['rev-parse', '--absolute-git-dir'])
    const handle: AgentWorktree = {
      agentId,
      path,
      branch,
      baseCommit,
      gitRoot,
      gitDir,
      parentCwd: await realpath(parentCwd),
    }
    await writeFile(join(gitDir, 'dock-agent.json'), JSON.stringify(handle), { mode: 0o600 })
    await git(gitRoot, ['worktree', 'lock', '--reason', `dock-agent:${agentId}`, path])
    return handle
  }
  async validate(handle: AgentWorktree): Promise<void> {
    const expected = join(handle.gitRoot, '.dock', 'worktrees', `agent-${handle.agentId}`)
    if (
      resolve(handle.path) !== resolve(expected) ||
      (await realpath(handle.path)) !== resolve(expected)
    )
      throw new Error('Invalid owned worktree path')
    const gitDir = await git(handle.path, ['rev-parse', '--absolute-git-dir'])
    const top = await git(handle.path, ['rev-parse', '--show-toplevel'])
    if (gitDir !== handle.gitDir || (await realpath(top)) !== (await realpath(handle.path)))
      throw new Error('Worktree identity points outside the owned checkout')
    const marker = JSON.parse(
      await readFile(join(gitDir, 'dock-agent.json'), 'utf8'),
    ) as AgentWorktree
    if (
      marker.agentId !== handle.agentId ||
      marker.path !== handle.path ||
      marker.branch !== handle.branch ||
      marker.baseCommit !== handle.baseCommit ||
      marker.gitRoot !== handle.gitRoot
    )
      throw new Error('Worktree is not owned by this agent')
  }
  async lock(handle: AgentWorktree): Promise<void> {
    await this.validate(handle)
    const locked = await readFile(join(handle.gitDir, 'locked'), 'utf8').catch(() => '')
    if (locked.trim() === `dock-agent:${handle.agentId}`) return
    if (locked) throw new Error('Worktree has a lock not owned by Dock')
    await git(handle.gitRoot, [
      'worktree',
      'lock',
      '--reason',
      `dock-agent:${handle.agentId}`,
      handle.path,
    ])
  }
  async finish(handle: AgentWorktree): Promise<'removed' | 'retained'> {
    await this.validate(handle)
    const status = await git(handle.path, ['status', '--porcelain', '--untracked-files=all']).catch(
      () => 'unknown',
    )
    const head = await git(handle.path, ['rev-parse', 'HEAD']).catch(() => '')
    const branch = await git(handle.path, ['symbolic-ref', '--short', 'HEAD']).catch(() => '')
    const locked = await readFile(join(handle.gitDir, 'locked'), 'utf8').catch(() => '')
    if (locked.trim() === `dock-agent:${handle.agentId}`)
      await git(handle.gitRoot, ['worktree', 'unlock', handle.path])
    else if (locked) return 'retained'
    if (status || head !== handle.baseCommit || branch !== handle.branch) return 'retained'
    // Only the validated, unchanged checkout and its UUID-named branch are removed.
    await git(handle.gitRoot, ['worktree', 'remove', handle.path])
    await git(handle.gitRoot, ['branch', '-D', handle.branch])
    return 'removed'
  }
}
