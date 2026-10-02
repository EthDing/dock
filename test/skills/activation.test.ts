import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSkillTool, SkillActivator } from '../../src/skills/activation.js'
import { discoverSkills } from '../../src/skills/registry.js'
import { createUserMessage } from '../../src/messages/create-message.js'
import { prepareSkillRestoration } from '../../src/skills/context.js'

describe('Skill activation', () => {
  it('injects the complete file and deduplicates identical content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-skill-activation-'))
    const directory = join(root, 'project', '.agents', 'skills', 'review')
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'SKILL.md'),
      '---\nname: review\ndescription: Review code\ncustom: visible\n---\n\nFollow the review checklist.\n',
    )
    const registry = await discoverSkills({
      homeDir: join(root, 'home'),
      projectRoot: join(root, 'project'),
    })
    const activator = new SkillActivator(registry)

    const first = await activator.activate('review')
    const second = await activator.activate('review')

    expect(first.context?.text).toContain('custom: visible')
    expect(first.context?.text).toContain('Follow the review checklist.')
    expect(first.context?.skillContext.name).toBe('review')
    expect(second.context).toBeUndefined()
    expect(second.content).toContain('already active')

    if (!first.context) throw new Error('Missing activation')
    const activation = createUserMessage(
      { content: [{ type: 'text', text: first.context.text }] },
      { skillContext: first.context.skillContext },
    )
    activator.sync(prepareSkillRestoration([activation], 'pointer'))
    expect((await activator.activate('review')).context?.text).toContain(
      'Follow the review checklist.',
    )

    activator.sync([])
    expect((await activator.activate('review')).context).toBeDefined()
  })

  it('builds a constrained Skill tool catalog', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-skill-tool-'))
    const directory = join(root, 'project', '.dock', 'skills', 'review')
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'SKILL.md'),
      '---\nname: review\ndescription: Review code\n---\nBody',
    )
    const registry = await discoverSkills({
      homeDir: join(root, 'home'),
      projectRoot: join(root, 'project'),
    })

    const tool = createSkillTool(new SkillActivator(registry), registry)

    expect(tool.inputSchema).toMatchObject({ properties: { name: { enum: ['review'] } } })
    expect(tool.description).toContain('review: Review code')
  })
})
