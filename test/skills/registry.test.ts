import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverSkills } from '../../src/skills/registry.js'

async function skill(root: string, directory: string, frontmatter: string, body = '# Body') {
  const path = join(root, directory)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`)
}

describe('discoverSkills', () => {
  it('uses project and Dock-native precedence deterministically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-skills-'))
    const homeDir = join(root, 'home')
    const projectRoot = join(root, 'project')
    await skill(
      join(homeDir, '.agents', 'skills'),
      'review',
      'name: review\ndescription: user portable',
    )
    await skill(
      join(homeDir, '.dock', 'skills'),
      'review',
      'name: review\ndescription: user native',
    )
    await skill(
      join(projectRoot, '.agents', 'skills'),
      'review',
      'name: review\ndescription: project portable',
    )
    await skill(
      join(projectRoot, '.dock', 'skills'),
      'review',
      'name: review\ndescription: project native',
    )

    const registry = await discoverSkills({ homeDir, projectRoot })

    expect(registry.skills).toHaveLength(1)
    expect(registry.skills[0]).toMatchObject({
      description: 'project native',
      name: 'review',
      source: 'project-dock',
    })
    expect(registry.diagnostics.filter((d) => d.code === 'shadowed')).toHaveLength(3)
  })

  it('skips missing descriptions and repairs an unquoted colon', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-skills-yaml-'))
    const projectRoot = join(root, 'project')
    await skill(
      join(projectRoot, '.agents', 'skills'),
      'good',
      'name: good\ndescription: Use when: reviewing code',
    )
    await skill(join(projectRoot, '.agents', 'skills'), 'bad', 'name: bad')

    const registry = await discoverSkills({ homeDir: join(root, 'home'), projectRoot })

    expect(registry.skills.map((s) => s.name)).toEqual(['good'])
    expect(registry.skills[0]?.description).toBe('Use when: reviewing code')
    expect(registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid',
          path: expect.stringContaining('/bad/SKILL.md'),
        }),
      ]),
    )
  })
})
