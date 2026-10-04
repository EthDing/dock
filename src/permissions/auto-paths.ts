import { lstat, readlink, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export function isWithin(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

// Resolve existing ancestors too: new files below a symlink must not inherit
// the apparent location's automatic permission. Errors stay on the review path.
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    const entry = await lstat(path).catch((failure: NodeJS.ErrnoException) => {
      if (failure.code === 'ENOENT') return undefined
      throw failure
    })
    if (entry?.isSymbolicLink()) return canonicalPath(resolve(dirname(path), await readlink(path)))
    const parent = dirname(path)
    if (parent === path) throw error
    return resolve(await canonicalPath(parent), basename(path))
  }
}

function protectedPath(path: string, cwd: string): boolean {
  // Worktrees may themselves live under .dock/worktrees. Check below the cwd
  // as well as external paths, without protecting every source file in them.
  const parts = path.split(sep)
  const protectedDirectory = parts.some((part, index) => {
    if (
      part === '.dock' &&
      parts[index + 1] === 'worktrees' &&
      parts[index + 2] &&
      isWithin(parts.slice(0, index + 3).join(sep), cwd)
    )
      return false
    return ['.dock', '.git', '.husky', '.ssh'].includes(part)
  })
  return (
    protectedDirectory ||
    ['/etc/profile', '/etc/bash.bashrc', '/etc/bashrc'].includes(path) ||
    isWithin('/etc/profile.d', path) ||
    isWithin('/etc/zsh', path) ||
    /^(?:\.bashrc|\.bash_profile|\.bash_login|\.bash_logout|\.bash_aliases|\.zshrc|\.zprofile|\.zshenv|\.zlogin|\.zlogout|\.profile|\.envrc|\.gitconfig|\.gitmodules|\.npmrc|\.yarnrc(?:\.yml)?|\.pnpmfile\.cjs)$/.test(
      basename(path),
    ) ||
    path.includes(`${sep}.config${sep}fish${sep}`) ||
    path.includes(`${sep}.config${sep}git${sep}`)
  )
}

export async function autoFileScope(
  cwd: string,
  path: string,
): Promise<{
  inside: boolean
  protected: boolean
}> {
  if (!isAbsolute(path)) return { inside: false, protected: true }
  try {
    const root = await realpath(cwd)
    const target = await canonicalPath(resolve(path))
    const info = await stat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    return {
      inside: isWithin(root, target),
      protected:
        protectedPath(resolve(path), resolve(cwd)) ||
        protectedPath(target, root) ||
        Boolean(
          info && ((!info.isFile() && !info.isDirectory()) || (info.isFile() && info.nlink > 1)),
        ),
    }
  } catch {
    return { inside: false, protected: true }
  }
}
