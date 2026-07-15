import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export type InstructionDocument = {
  content: string
  path: string
  scope: 'project' | 'user'
}

export async function loadInstructionDocuments(options: {
  approveExternalImport?: (path: string) => Promise<boolean>
  cwd: string
  homeDir: string
  projectRoot: string
}): Promise<InstructionDocument[]> {
  const projectRoot = resolve(options.projectRoot)
  const cwd = resolve(options.cwd)
  const relativeCwd = relative(projectRoot, cwd)
  if (relativeCwd.startsWith('..')) {
    throw new Error(`Working directory ${cwd} is outside project root ${projectRoot}`)
  }

  const candidates: Array<{ path: string; scope: InstructionDocument['scope'] }> = [
    { path: join(options.homeDir, '.dock', 'AGENTS.md'), scope: 'user' },
  ]
  const projectDirectories = directoriesFromRoot(projectRoot, cwd)
  for (const directory of projectDirectories) {
    candidates.push({ path: join(directory, 'AGENTS.md'), scope: 'project' })
  }

  const documents: InstructionDocument[] = []
  for (const candidate of candidates) {
    const content = await readOptionalFile(candidate.path)
    if (content === undefined) continue
    documents.push({
      ...candidate,
      content: await expandInstructionImports({
        ...(options.approveExternalImport
          ? { approveExternalImport: options.approveExternalImport }
          : {}),
        content,
        depth: 0,
        homeDir: options.homeDir,
        path: candidate.path,
        projectRoot,
        scope: candidate.scope,
        visited: new Set([resolve(candidate.path)]),
      }),
    })
  }
  return documents
}

function directoriesFromRoot(projectRoot: string, cwd: string): string[] {
  const directories: string[] = []
  let current = cwd
  while (true) {
    directories.push(current)
    if (current === projectRoot) break
    current = dirname(current)
  }
  return directories.reverse()
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

async function expandInstructionImports(options: {
  approveExternalImport?: (path: string) => Promise<boolean>
  content: string
  depth: number
  homeDir: string
  path: string
  projectRoot: string
  scope: InstructionDocument['scope']
  visited: Set<string>
}): Promise<string> {
  if (options.depth >= 4) return options.content
  const output: string[] = []
  let fence: string | undefined

  for (const line of options.content.split('\n')) {
    const trimmed = line.trim()
    const fenceMatch = trimmed.match(/^(```+|~~~+)/)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      fence = fence ? (marker?.startsWith(fence[0] ?? '') ? undefined : fence) : marker
      output.push(line)
      continue
    }
    if (fence) {
      output.push(line)
      continue
    }

    const importMatch = trimmed.match(/^@(.+)$/)
    if (!importMatch) {
      output.push(line)
      continue
    }

    const importPath = resolveImportPath(
      importMatch[1] ?? '',
      dirname(options.path),
      options.homeDir,
    )
    if (!importPath || options.visited.has(importPath) || !(await isFile(importPath))) {
      output.push(line)
      continue
    }
    const outsideProject = relative(options.projectRoot, importPath).startsWith('..')
    if (
      options.scope === 'project' &&
      outsideProject &&
      !(await options.approveExternalImport?.(importPath))
    ) {
      output.push(line)
      continue
    }

    const imported = await readFile(importPath, 'utf8')
    output.push(
      await expandInstructionImports({
        ...options,
        content: imported,
        depth: options.depth + 1,
        path: importPath,
        visited: new Set([...options.visited, importPath]),
      }),
    )
  }

  return output.join('\n')
}

function resolveImportPath(value: string, baseDir: string, homeDir: string): string | undefined {
  const path = value.trim()
  if (!path || path.includes('\0')) return undefined
  if (path === '~') return resolve(homeDir)
  if (path.startsWith('~/')) return resolve(homeDir, path.slice(2))
  return resolve(isAbsolute(path) ? path : join(baseDir, path))
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}
