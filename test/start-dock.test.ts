import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startDock } from '../src/start-dock.js'

describe('startDock', () => {
  it('fails before terminal startup when no model is configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-start-'))

    await expect(
      startDock({ args: [], cwd: root, environment: {}, homeDir: join(root, 'home') }),
    ).rejects.toThrow('No model configured')
  })
})
