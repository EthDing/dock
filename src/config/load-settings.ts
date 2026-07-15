import { readFile, stat } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import { z } from 'zod'

const providerProtocolSchema = z.enum([
  'anthropic-messages',
  'openai-responses',
  'openai-chat-completions',
])

const providerSettingsSchema = z
  .object({
    apiKeyEnv: z.string().min(1).optional(),
    baseUrl: z.url().optional(),
    protocol: providerProtocolSchema.optional(),
  })
  .strict()

const permissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
])

const settingsSchema = z
  .object({
    cleanupPeriodDays: z.number().int().nonnegative().optional(),
    model: z.string().min(1).optional(),
    permissions: z
      .object({
        allow: z.array(z.string()).optional(),
        ask: z.array(z.string()).optional(),
        defaultMode: permissionModeSchema.optional(),
        deny: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    providers: z.record(z.string(), providerSettingsSchema).optional(),
  })
  .strict()

export type DockSettings = z.infer<typeof settingsSchema>

export type LoadedSettings = {
  projectRoot: string
  settings: DockSettings
  sources: readonly string[]
}

export async function loadSettings(options: {
  cwd: string
  homeDir: string
}): Promise<LoadedSettings> {
  const projectRoot = await findProjectRoot(options.cwd)
  const candidates = [
    join(options.homeDir, '.dock', 'settings.json'),
    join(projectRoot, '.dock', 'settings.json'),
    join(projectRoot, '.dock', 'settings.local.json'),
  ]
  let settings: DockSettings = {}
  const sources: string[] = []

  for (const path of candidates) {
    const layer = await readSettingsFile(path)
    if (!layer) continue
    settings = mergeSettings(settings, layer)
    sources.push(path)
  }

  return { projectRoot, settings, sources }
}

export async function findProjectRoot(cwd: string): Promise<string> {
  let current = resolve(cwd)
  const filesystemRoot = parse(current).root

  while (true) {
    if (await pathExists(join(current, '.git'))) return current
    if (current === filesystemRoot) return resolve(cwd)
    current = dirname(current)
  }
}

function mergeSettings(base: DockSettings, override: DockSettings): DockSettings {
  const permissions = mergePermissions(base.permissions, override.permissions)
  const providers = mergeProviders(base.providers, override.providers)

  return {
    ...base,
    ...override,
    ...(permissions ? { permissions } : {}),
    ...(providers ? { providers } : {}),
  }
}

function mergePermissions(
  base: DockSettings['permissions'],
  override: DockSettings['permissions'],
): DockSettings['permissions'] {
  if (!base && !override) return undefined
  return {
    ...base,
    ...override,
    allow: [...(base?.allow ?? []), ...(override?.allow ?? [])],
    ask: [...(base?.ask ?? []), ...(override?.ask ?? [])],
    deny: [...(base?.deny ?? []), ...(override?.deny ?? [])],
  }
}

function mergeProviders(
  base: DockSettings['providers'],
  override: DockSettings['providers'],
): DockSettings['providers'] {
  if (!base && !override) return undefined
  const providers = { ...base }
  for (const [name, provider] of Object.entries(override ?? {})) {
    providers[name] = { ...providers[name], ...provider }
  }
  return providers
}

async function readSettingsFile(path: string): Promise<DockSettings | undefined> {
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    throw error
  }

  let value: unknown
  try {
    value = JSON.parse(contents) as unknown
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid JSON in ${path}: ${detail}`)
  }
  return settingsSchema.parse(value)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
