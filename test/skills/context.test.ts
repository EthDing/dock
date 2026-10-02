import { describe, expect, it } from 'vitest'
import { createUserMessage } from '../../src/messages/create-message.js'
import { prepareSkillRestoration } from '../../src/skills/context.js'

describe('prepareSkillRestoration', () => {
  function skill(name: string, text: string) {
    return createUserMessage(
      { content: [{ type: 'text', text }] },
      { isMeta: true, skillContext: { name, location: `/${name}/SKILL.md`, contentHash: name } },
    )
  }

  it.each([19_999, 20_000])('preserves a Skill within the per-skill limit (%i chars)', (size) => {
    const text = 'x'.repeat(size)
    expect(prepareSkillRestoration([skill('review', text)])[0]?.message.content).toEqual([
      { type: 'text', text },
    ])
  })

  it('keeps the head and a path notice within 5,000 tokens, without mutating history', () => {
    const original = skill('review', `important instructions\n${'x'.repeat(30_000)}END`)
    const restored = prepareSkillRestoration([original])
    const block = restored[0]?.message.content[0]
    if (block?.type !== 'text') throw new Error('Expected Skill text')
    expect(block.text.startsWith('important instructions\n')).toBe(true)
    expect(block.text).not.toContain('END')
    expect(block.text.split('\n').at(-1)).toMatch(/truncated.*\/review\/SKILL.md/)
    expect(Math.ceil(block.text.length / 4)).toBe(5000)
    expect(restored[0]?.skillContext).toEqual(original.skillContext)
    expect(JSON.stringify(original)).toContain('END')
    expect(prepareSkillRestoration(restored)[0]?.message.content).toEqual(
      restored[0]?.message.content,
    )
  })

  it('fits five large Skills in the combined budget, newest first, and reports omissions', () => {
    const history = Array.from({ length: 6 }, (_, i) => skill(`skill${i}`, 'x'.repeat(30_000)))
    const restored = prepareSkillRestoration(history)
    const bodies = restored.filter((message) => message.skillContext)
    expect(bodies.map((message) => message.skillContext?.name)).toEqual([
      'skill5',
      'skill4',
      'skill3',
      'skill2',
      'skill1',
    ])
    const chars = bodies.reduce(
      (sum, message) =>
        sum +
        message.message.content.reduce(
          (length, block) => length + (block.type === 'text' ? block.text.length : 0),
          0,
        ),
      0,
    )
    expect(Math.ceil(chars / 4)).toBe(25_000)
    expect(JSON.stringify(restored.at(-1))).toContain('omitted')
    expect(JSON.stringify(restored.at(-1))).toContain('skill0')
  })

  it('keeps only the newest activation for each Skill', () => {
    const old = createUserMessage(
      { content: [{ type: 'text', text: 'old' }] },
      {
        isMeta: true,
        skillContext: { name: 'review', location: '/review/SKILL.md', contentHash: '1' },
      },
    )
    const latest = createUserMessage(
      { content: [{ type: 'text', text: 'latest' }] },
      {
        isMeta: true,
        skillContext: { name: 'review', location: '/review/SKILL.md', contentHash: '2' },
      },
    )

    const restored = prepareSkillRestoration([old, latest])

    expect(restored).toHaveLength(1)
    expect(restored[0]?.message.content).toEqual([{ type: 'text', text: 'latest' }])
    expect(restored[0]?.skillContext?.contentHash).toBe('2')
    expect(restored[0]?.uuid).not.toBe(latest.uuid)
  })
})
