import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isWorkspaceTrusted, trustWorkspace } from '../../src/config/workspace-trust.js'

describe('workspace trust', () => {
  it('persists trust for a project and its descendants in an owner-only file', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'dock-trust-home-'))
    const projectRoot = await mkdtemp(join(tmpdir(), 'dock-trust-project-'))

    await trustWorkspace({ homeDir, workspace: projectRoot })

    await expect(isWorkspaceTrusted({ homeDir, workspace: projectRoot })).resolves.toBe(true)
    await expect(
      isWorkspaceTrusted({ homeDir, workspace: join(projectRoot, 'packages', 'app') }),
    ).resolves.toBe(true)
    const fileStats = await stat(join(homeDir, '.dock', 'trusted-workspaces.json'))
    expect(fileStats.mode & 0o777).toBe(0o600)
  })
})
