import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'

type TrustFile = { workspaces: string[] }

export async function isWorkspaceTrusted(options: {
  homeDir: string
  workspace: string
}): Promise<boolean> {
  const trust = await readTrustFile(options.homeDir)
  const workspace = resolve(options.workspace)
  return (trust?.workspaces ?? []).some((trusted) => isWithin(trusted, workspace))
}

export async function trustWorkspace(options: {
  homeDir: string
  workspace: string
}): Promise<void> {
  const directory = join(options.homeDir, '.dock')
  const path = join(directory, 'trusted-workspaces.json')
  const existing = (await readTrustFile(options.homeDir)) ?? { workspaces: [] }
  const trust: TrustFile = {
    workspaces: [...new Set([...existing.workspaces, resolve(options.workspace)])],
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporaryPath = join(directory, `trusted-workspaces.${randomUUID()}.tmp`)
  await writeFile(temporaryPath, `${JSON.stringify(trust, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
  await rename(temporaryPath, path)
  await chmod(path, 0o600)
}

export async function ensureWorkspaceTrust(options: {
  cwd: string
  homeDir: string
  prompter?: (workspace: string) => Promise<boolean>
  workspace: string
}): Promise<void> {
  if (await isWorkspaceTrusted(options)) return
  const accepted = options.prompter
    ? await options.prompter(options.workspace)
    : await promptForWorkspaceTrust(options.workspace)
  if (!accepted) throw new Error('Workspace trust declined')
  if (resolve(options.cwd) !== resolve(options.homeDir)) {
    await trustWorkspace(options)
  }
}

async function promptForWorkspaceTrust(workspace: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Workspace trust requires an interactive terminal')
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    process.stdout.write(`\nAccessing workspace:\n${workspace}\n`)
    process.stdout.write(
      'Dock can read, edit, and execute files in this folder. Trust only projects you know.\n',
    )
    const answer = (await readline.question('Trust this workspace? [y/N]: ')).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    readline.close()
  }
}

async function readTrustFile(homeDir: string): Promise<TrustFile | undefined> {
  const path = join(homeDir, '.dock', 'trusted-workspaces.json')
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    throw error
  }
  const value = JSON.parse(contents) as unknown
  if (!isTrustFile(value)) throw new Error(`Invalid workspace trust file ${path}`)
  return value
}

function isTrustFile(value: unknown): value is TrustFile {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray((value as { workspaces?: unknown }).workspaces) &&
    (value as { workspaces: unknown[] }).workspaces.every((entry) => typeof entry === 'string')
  )
}

function isWithin(parent: string, child: string): boolean {
  const pathFromParent = relative(resolve(parent), resolve(child))
  return pathFromParent === '' || (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent))
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
