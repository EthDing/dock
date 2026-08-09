import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadSettings } from '../../src/config/load-settings.js'

describe('tool clearing configuration', () => {
  it('merges per-field values through user, project and local settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-clearing-config-'))
    const homeDir = join(root, 'home')
    const cwd = join(root, 'repo')
    await mkdir(join(homeDir, '.dock'), { recursive: true })
    await mkdir(join(cwd, '.dock'), { recursive: true })
    await mkdir(join(cwd, '.git'))
    const layer = (value: object) =>
      JSON.stringify({ contextManagement: { toolResultClearing: value } })
    await writeFile(
      join(homeDir, '.dock/settings.json'),
      layer({ gapThresholdMinutes: 90, keepRecent: 7 }),
    )
    await writeFile(join(cwd, '.dock/settings.json'), layer({ enabled: false }))
    await writeFile(join(cwd, '.dock/settings.local.json'), layer({ keepRecent: 2 }))
    expect(
      (await loadSettings({ cwd, homeDir })).settings.contextManagement?.toolResultClearing,
    ).toEqual({ enabled: false, gapThresholdMinutes: 90, keepRecent: 2 })
    await writeFile(join(cwd, '.dock/settings.local.json'), layer({ keepRecent: 0 }))
    await expect(loadSettings({ cwd, homeDir })).rejects.toThrow()
  })
})
