import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findMostRecentSession,
  forkSession,
  listSessions,
} from '../../src/sessions/session-manager.js'
import { SessionWriter } from '../../src/sessions/session-store.js'

describe('session manager', () => {
  it('lists current-project sessions by most recent activity', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'dock-session-list-'))
    const cwd = '/work/project'
    const first = await SessionWriter.create({
      configDir,
      cwd,
      now: () => new Date('2026-08-27T00:00:00.000Z'),
      sessionId: 'first',
    })
    await first.appendMessage(
      { role: 'user', content: [{ type: 'text', text: 'first prompt' }] },
      'first-message',
    )
    await first.close()
    const second = await SessionWriter.create({
      configDir,
      cwd,
      now: () => new Date('2026-08-27T01:00:00.000Z'),
      sessionId: 'second',
    })
    await second.appendMessage(
      { role: 'user', content: [{ type: 'text', text: 'second prompt' }] },
      'second-message',
    )
    await second.close()

    const sessions = await listSessions({ configDir, cwd })

    expect(sessions.map(({ sessionId }) => sessionId)).toEqual(['second', 'first'])
    expect(await findMostRecentSession({ configDir, cwd })).toMatchObject({
      sessionId: 'second',
    })
  })

  it('forks the active conversation into a new session', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'dock-session-fork-'))
    const cwd = '/work/project'
    const source = await SessionWriter.create({ configDir, cwd, sessionId: 'source' })
    await source.appendMessage(
      { role: 'user', content: [{ type: 'text', text: 'keep this' }] },
      'message-1',
    )
    await source.close()

    const fork = await forkSession({
      configDir,
      cwd,
      sourceSessionId: 'source',
      targetSessionId: 'fork',
    })

    expect(fork.metadata.forkedFromSessionId).toBe('source')
    expect(fork.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'keep this' }] },
    ])
  })
})
