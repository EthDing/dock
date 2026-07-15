import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '../../src/messages/create-message.js'
import {
  findMostRecentSession,
  forkSession,
  listSessions,
} from '../../src/sessions/session-manager.js'
import { asMessageUuid, asSessionId } from '../../src/sessions/ids.js'
import { SessionWriter } from '../../src/sessions/session-store.js'

const FIRST_SESSION = asSessionId('30000000-0000-4000-8000-000000000001')
const SECOND_SESSION = asSessionId('30000000-0000-4000-8000-000000000002')
const SOURCE_SESSION = asSessionId('30000000-0000-4000-8000-000000000003')
const FORK_SESSION = asSessionId('30000000-0000-4000-8000-000000000004')

describe('session manager', () => {
  it('lists current-project sessions by most recent activity', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'dock-session-list-'))
    const cwd = '/work/project'
    const first = await SessionWriter.create({
      configDir,
      cwd,
      now: () => new Date('2026-08-27T00:00:00.000Z'),
      sessionId: FIRST_SESSION,
    })
    await first.recordTranscript([
      createUserMessage(
        { content: [{ type: 'text', text: 'first prompt' }] },
        { uuid: asMessageUuid('40000000-0000-4000-8000-000000000001') },
      ),
    ])
    await first.close()
    const second = await SessionWriter.create({
      configDir,
      cwd,
      now: () => new Date('2026-08-27T01:00:00.000Z'),
      sessionId: SECOND_SESSION,
    })
    await second.recordTranscript([
      createUserMessage(
        { content: [{ type: 'text', text: 'second prompt' }] },
        { uuid: asMessageUuid('40000000-0000-4000-8000-000000000002') },
      ),
    ])
    await second.close()

    const sessions = await listSessions({ configDir, cwd })

    expect(sessions.map(({ sessionId }) => sessionId)).toEqual([SECOND_SESSION, FIRST_SESSION])
    expect(await findMostRecentSession({ configDir, cwd })).toMatchObject({
      sessionId: SECOND_SESSION,
    })
  })

  it('forks the active conversation into a new session', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'dock-session-fork-'))
    const cwd = '/work/project'
    const source = await SessionWriter.create({ configDir, cwd, sessionId: SOURCE_SESSION })
    await source.recordTranscript([
      createUserMessage(
        { content: [{ type: 'text', text: 'keep this' }] },
        { uuid: asMessageUuid('40000000-0000-4000-8000-000000000003') },
      ),
    ])
    await source.close()

    const fork = await forkSession({
      configDir,
      cwd,
      sourceSessionId: SOURCE_SESSION,
      targetSessionId: FORK_SESSION,
    })

    expect(fork.metadata.forkedFromSessionId).toBe(SOURCE_SESSION)
    expect(fork.messages).toMatchObject([
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'keep this' }] },
      },
    ])
  })
})
