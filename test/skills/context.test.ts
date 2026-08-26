import { describe, expect, it } from 'vitest'
import { createUserMessage } from '../../src/messages/create-message.js'
import { prepareSkillRestoration } from '../../src/skills/context.js'

describe('prepareSkillRestoration', () => {
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
