import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addLocalPermissionRule } from '../../src/config/write-settings.js'

describe('addLocalPermissionRule', () => {
  it('preserves local settings and adds a rule only once', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'dock-write-settings-'))
    const directory = join(projectRoot, '.dock')
    await mkdir(directory)
    await writeFile(
      join(directory, 'settings.local.json'),
      JSON.stringify({ model: 'deepseek:model', permissions: { deny: ['Read(.env)'] } }),
    )

    await addLocalPermissionRule({ behavior: 'allow', projectRoot, rule: 'WebFetch(domain:x)' })
    await addLocalPermissionRule({ behavior: 'allow', projectRoot, rule: 'WebFetch(domain:x)' })

    const value = JSON.parse(
      await readFile(join(directory, 'settings.local.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(value).toEqual({
      model: 'deepseek:model',
      permissions: { allow: ['WebFetch(domain:x)'], deny: ['Read(.env)'] },
    })
  })
})
