import { appendFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '../../src/messages/create-message.js'
import { asMessageUuid, asSessionId } from '../../src/sessions/ids.js'
import { SessionWriter, getSessionPath, loadSession } from '../../src/sessions/session-store.js'

const SESSION_ONE = asSessionId('10000000-0000-4000-8000-000000000001')
const MESSAGE_ONE = asMessageUuid('20000000-0000-4000-8000-000000000001')
const MESSAGE_TWO = asMessageUuid('20000000-0000-4000-8000-000000000002')

describe('session store', () => {
  it('persists messages with a parent chain and reloads them', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'dock-session-'))
    const cwd = '/work/project'
    const writer = await SessionWriter.create({
      configDir,
      cwd,
      now: () => new Date('2026-08-27T00:00:00.000Z'),
      sessionId: SESSION_ONE,
    })

    await writer.recordTranscript([
      createUserMessage(
        { content: [{ type: 'text', text: 'hello' }] },
        { now: () => new Date('2026-08-27T00:00:01.000Z'), uuid: MESSAGE_ONE },
      ),
      createAssistantMessage(
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          id: 'assistant-1',
          stopReason: 'end_turn',
          usage: { outputTokens: 1 },
        },
        { now: () => new Date('2026-08-27T00:00:02.000Z'), uuid: MESSAGE_TWO },
      ),
    ])
    await writer.close()

    const loaded = await loadSession({ configDir, cwd, sessionId: SESSION_ONE })

    expect(loaded.metadata).toMatchObject({
      createdAt: '2026-08-27T00:00:00.000Z',
      cwd,
      sessionId: SESSION_ONE,
      version: 1,
    })
    expect(
      loaded.records.filter((record) => record.type === 'user' || record.type === 'assistant'),
    ).toMatchObject([
      { uuid: MESSAGE_ONE, parentUuid: null },
      { uuid: MESSAGE_TWO, parentUuid: MESSAGE_ONE },
    ])
    expect(loaded.messages).toHaveLength(2)
    expect(loaded.truncatedTail).toBe(false)
  })

  it('ignores an incomplete final JSONL line after a crash', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'dock-session-tail-'))
    const cwd = '/work/project'
    const sessionId = asSessionId('10000000-0000-4000-8000-000000000002')
    const writer = await SessionWriter.create({ configDir, cwd, sessionId })
    await writer.recordTranscript([
      createUserMessage({ content: [{ type: 'text', text: 'saved' }] }, { uuid: MESSAGE_ONE }),
    ])
    await writer.close()
    await appendFile(getSessionPath({ configDir, cwd, sessionId }), '{"type":')

    const loaded = await loadSession({ configDir, cwd, sessionId })

    expect(loaded.messages).toHaveLength(1)
    expect(loaded.truncatedTail).toBe(true)
  })

  it('prevents a second writer from opening the same session', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'dock-session-lock-'))
    const cwd = '/work/project'
    const sessionId = asSessionId('10000000-0000-4000-8000-000000000003')
    const first = await SessionWriter.create({ configDir, cwd, sessionId })

    await expect(SessionWriter.open({ configDir, cwd, sessionId })).rejects.toThrow('already open')

    await first.close()
    const second = await SessionWriter.open({ configDir, cwd, sessionId })
    await second.close()
  })

  it('persists the latest session name as append-only metadata', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'dock-session-name-'))
    const cwd = '/work/project'
    const sessionId = asSessionId('10000000-0000-4000-8000-000000000004')
    const writer = await SessionWriter.create({ configDir, cwd, sessionId })
    await writer.rename('first name')
    await writer.rename('final name')
    await writer.close()

    const loaded = await loadSession({ configDir, cwd, sessionId })

    expect(loaded.name).toBe('final name')
  })
})
