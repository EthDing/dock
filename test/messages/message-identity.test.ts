import { describe, expect, it } from 'vitest'
import { createUserMessage } from '../../src/messages/create-message.js'
import { createSessionId } from '../../src/sessions/ids.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('Dock identities', () => {
  it('generates UUIDs for sessions and transcript messages before persistence', () => {
    const sessionId = createSessionId()
    const first = createUserMessage({ content: [{ type: 'text', text: 'one' }] })
    const second = createUserMessage({ content: [{ type: 'text', text: 'two' }] })

    expect(sessionId).toMatch(UUID_PATTERN)
    expect(first.uuid).toMatch(UUID_PATTERN)
    expect(second.uuid).toMatch(UUID_PATTERN)
    expect(first.uuid).not.toBe(second.uuid)
    expect(first).toMatchObject({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'one' }] },
    })
  })
})
