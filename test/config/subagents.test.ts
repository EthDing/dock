import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { loadSettings } from '../../src/config/load-settings.js'
it('merges subagent limits per field and validates worktree base selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dock-agent-config-')),
    homeDir = join(root, 'home'),
    cwd = join(root, 'repo')
  await mkdir(join(homeDir, '.dock'), { recursive: true })
  await mkdir(join(cwd, '.git'), { recursive: true })
  await mkdir(join(cwd, '.dock'), { recursive: true })
  await writeFile(
    join(homeDir, '.dock', 'settings.json'),
    JSON.stringify({
      subagents: { maxConcurrent: 4, maxDepth: 2, backgroundEnabled: true },
      worktree: { baseRef: 'head' },
    }),
  )
  await writeFile(
    join(cwd, '.dock', 'settings.json'),
    JSON.stringify({ subagents: { backgroundEnabled: false } }),
  )
  const loaded = await loadSettings({ homeDir, cwd })
  expect(loaded.settings.subagents).toEqual({
    maxConcurrent: 4,
    maxDepth: 2,
    backgroundEnabled: false,
  })
  expect(loaded.settings.worktree?.baseRef).toBe('head')
  await writeFile(
    join(cwd, '.dock', 'settings.json'),
    JSON.stringify({ subagents: { maxDepth: 0 } }),
  )
  await expect(loadSettings({ homeDir, cwd })).rejects.toThrow()
})
