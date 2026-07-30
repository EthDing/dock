import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readSettingsFile, type DockSettings } from './load-settings.js'

export async function addLocalPermissionRule(options: {
  behavior: 'allow' | 'ask' | 'deny'
  projectRoot: string
  rule: string
}): Promise<void> {
  const directory = join(options.projectRoot, '.dock')
  const path = join(directory, 'settings.local.json')
  const existing = (await readSettingsFile(path)) ?? {}
  const permissions = existing.permissions ?? {}
  const settings: DockSettings = {
    ...existing,
    permissions: {
      ...permissions,
      [options.behavior]: [...new Set([...(permissions[options.behavior] ?? []), options.rule])],
    },
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporaryPath = join(directory, `settings.${randomUUID()}.tmp`)
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
  await rename(temporaryPath, path)
  await chmod(path, 0o600)
}
