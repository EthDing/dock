import { describe, expect, it } from 'vitest'
import { createUserMessage } from '../../src/messages/create-message.js'
import {
  parseSkillRestoreMode,
  prepareSkillRestoration,
  prepareSkillRestorationWithMetadata,
} from '../../src/skills/context.js'

describe('prepareSkillRestoration', () => {
  it('defaults to head5k and rejects unknown restore modes', () => {
    expect(parseSkillRestoreMode(undefined)).toBe('head5k')
    expect(() => parseSkillRestoreMode('invalid')).toThrow('DOCK_EVAL_SKILL_RESTORE')
  })

  it.each(['none', 'full', 'head5k', 'pointer'] as const)(
    'restores %s and records actual injected tokens',
    (mode) => {
      expect(parseSkillRestoreMode(mode)).toBe(mode)
      const body = `instructions\n${'x'.repeat(25_000)}\nTAIL`
      const { attachments, skillRestoration } = prepareSkillRestorationWithMetadata(
        [skill('review', body)],
        mode,
      )
      const text = attachments
        .flatMap((message) =>
          message.message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
        )
        .join('\n')
      expect(skillRestoration).toEqual({
        mode,
        skills: [
          { name: 'review', location: '/review/SKILL.md', tokens: Math.ceil(text.length / 4) },
        ],
      })
      if (mode === 'none') expect(attachments).toEqual([])
      if (mode === 'full') expect(text).toBe(body)
      if (mode === 'head5k') expect(text).toContain('truncated')
      if (mode === 'pointer') {
        expect(text).toContain('Skill: review')
        expect(text).toContain('/review/SKILL.md')
        expect(text).toContain('Skill tool or Read')
        expect(text).not.toContain('instructions')
        expect(attachments[0]?.skillContext?.isPartial).toBe(true)
      }
    },
  )

  it('keeps the full mode combined budget and reports zero tokens for omitted Skills', () => {
    const { attachments, skillRestoration } = prepareSkillRestorationWithMetadata(
      [skill('older', 'x'.repeat(60_000)), skill('newer', 'y'.repeat(60_000))],
      'full',
    )
    expect(attachments.filter((message) => message.skillContext)).toHaveLength(1)
    expect(skillRestoration.skills.map(({ name, tokens }) => ({ name, tokens }))).toEqual([
      { name: 'newer', tokens: 15_000 },
      { name: 'older', tokens: 0 },
    ])
  })
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
    expect(restored[0]?.skillContext).toEqual({ ...original.skillContext, isPartial: true })
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
