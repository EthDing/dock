import { describe, expect, it } from 'vitest'
import { UserInteractionBroker } from '../../src/interaction/user-interaction-broker.js'
import { asSessionId } from '../../src/sessions/ids.js'

describe('UserInteractionBroker', () => {
  it('serializes requests and cancels a queued request promptly', async () => {
    const broker = new UserInteractionBroker()
    const releases: Array<() => void> = []
    const order: string[] = []
    broker.setHandler(
      (request) =>
        new Promise((resolve) => {
          order.push(request.type)
          releases.push(() =>
            resolve(
              request.type === 'questions'
                ? { type: 'questions', answers: { q: 'a' } }
                : { type: 'plan', decision: 'approve_default' },
            ),
          )
        }),
    )
    const signal = new AbortController()
    const requester = { label: 'Main', sessionId: asSessionId(crypto.randomUUID()) }
    const first = broker.request(
      {
        type: 'questions',
        questions: [{ question: 'q', header: 'h', options: [], multiSelect: false }],
        requester,
      },
      new AbortController().signal,
    )
    const second = broker.request({ type: 'plan', plan: 'p', requester }, signal.signal)
    signal.abort()
    await expect(second).rejects.toThrow('cancelled')
    expect(order).toEqual(['questions'])
    releases[0]?.()
    await expect(first).resolves.toMatchObject({ type: 'questions' })
  })
})
