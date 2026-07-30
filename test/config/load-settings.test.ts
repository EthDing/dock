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
        sandbox: {
          autoAllowBashIfSandboxed: false,
          enabled: true,
          filesystem: { denyRead: ['~/.ssh'] },
          network: { allowedDomains: ['github.com'] },
        },
      }),
    )
    await writeFile(
      join(projectDir, '.dock', 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(pnpm test)'] },
        providers: { primary: { baseUrl: 'https://gateway.example' } },
        sandbox: {
          filesystem: { allowWrite: ['/tmp/build'] },
          network: { allowedDomains: ['registry.npmjs.org'] },
        },
      }),
    )
    await writeFile(
      join(projectDir, '.dock', 'settings.local.json'),
      JSON.stringify({
        model: 'local-model',
        permissions: { ask: ['Edit'] },
        sandbox: {
          autoAllowBashIfSandboxed: true,
          network: { deniedDomains: ['blocked.example'] },
        },
      }),
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
      sandbox: {
        autoAllowBashIfSandboxed: true,
        enabled: true,
        filesystem: {
          allowWrite: ['/tmp/build'],
          denyRead: ['~/.ssh'],
        },
        network: {
          allowedDomains: ['github.com', 'registry.npmjs.org'],
          deniedDomains: ['blocked.example'],
        },
      },
    })
  })
})
