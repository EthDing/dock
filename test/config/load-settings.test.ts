import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadSettings } from '../../src/config/load-settings.js'

describe('loadSettings', () => {
  it('merges user, project, and local settings in scope order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-settings-'))
    const homeDir = join(root, 'home')
    const projectDir = join(root, 'project')
    const cwd = join(projectDir, 'packages', 'app')
    await Promise.all([
      mkdir(join(homeDir, '.dock'), { recursive: true }),
      mkdir(join(projectDir, '.dock'), { recursive: true }),
      mkdir(join(projectDir, '.git'), { recursive: true }),
      mkdir(cwd, { recursive: true }),
    ])
    await writeFile(
      join(homeDir, '.dock', 'settings.json'),
      JSON.stringify({
        model: 'user-model',
        permissions: { allow: ['Read'], deny: ['Read(.env)'] },
        providers: { primary: { protocol: 'anthropic-messages' } },
      }),
    )
    await writeFile(
      join(projectDir, '.dock', 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(pnpm test)'] },
        providers: { primary: { baseUrl: 'https://gateway.example' } },
      }),
    )
    await writeFile(
      join(projectDir, '.dock', 'settings.local.json'),
      JSON.stringify({ model: 'local-model', permissions: { ask: ['Edit'] } }),
    )

    const loaded = await loadSettings({ cwd, homeDir })

    expect(loaded.projectRoot).toBe(projectDir)
    expect(loaded.settings).toEqual({
      model: 'local-model',
      permissions: {
        allow: ['Read', 'Bash(pnpm test)'],
        ask: ['Edit'],
        deny: ['Read(.env)'],
      },
      providers: {
        primary: {
          baseUrl: 'https://gateway.example',
          protocol: 'anthropic-messages',
        },
      },
    })
  })
})
