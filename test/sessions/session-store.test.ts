import { appendFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionWriter, getSessionPath, loadSession } from '../../src/sessions/session-store.js'

describe('session store', () => {
  it('persists messages with a parent chain and reloads them', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'dock-session-'))
    const cwd = '/work/project'
    const writer = await SessionWriter.create({
      configDir,
      cwd,
      now: () => new Date('2026-08-27T00:00:00.000Z'),
      sessionId: 'session-1',
    })

    await writer.appendMessage(
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      'message-1',
    )
    await writer.appendMessage(
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        id: 'assistant-1',
        stopReason: 'end_turn',
        usage: { outputTokens: 1 },
      },
      'message-2',
    )
    await writer.close()

    const loaded = await loadSession({ configDir, cwd, sessionId: 'session-1' })

    expect(loaded.metadata).toMatchObject({
      createdAt: '2026-08-27T00:00:00.000Z',
      cwd,
      sessionId: 'session-1',
      version: 1,
    })
    expect(loaded.records.filter((record) => record.type === 'message')).toMatchObject([
      { id: 'message-1', parentId: null },
      { id: 'message-2', parentId: 'message-1' },
    ])
    expect(loaded.messages).toHaveLength(2)
    expect(loaded.truncatedTail).toBe(false)
  })

  it('ignores an incomplete final JSONL line after a crash', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'dock-session-tail-'))
    const cwd = '/work/project'
    const writer = await SessionWriter.create({ configDir, cwd, sessionId: 'session-tail' })
    await writer.appendMessage(
      { role: 'user', content: [{ type: 'text', text: 'saved' }] },
      'message-1',
    )
    await writer.close()
    await appendFile(getSessionPath({ configDir, cwd, sessionId: 'session-tail' }), '{"type":')

    const loaded = await loadSession({ configDir, cwd, sessionId: 'session-tail' })

    expect(loaded.messages).toHaveLength(1)
    expect(loaded.truncatedTail).toBe(true)
  })

  it('prevents a second writer from opening the same session', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'dock-session-lock-'))
    const cwd = '/work/project'
    const first = await SessionWriter.create({ configDir, cwd, sessionId: 'session-lock' })

    await expect(SessionWriter.open({ configDir, cwd, sessionId: 'session-lock' })).rejects.toThrow(
      'already open',
    )

    await first.close()
    const second = await SessionWriter.open({ configDir, cwd, sessionId: 'session-lock' })
    await second.close()
  })

  it('persists the latest session name as append-only metadata', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'dock-session-name-'))
    const cwd = '/work/project'
    const writer = await SessionWriter.create({ configDir, cwd, sessionId: 'session-name' })
    await writer.rename('first name')
    await writer.rename('final name')
    await writer.close()

    const loaded = await loadSession({ configDir, cwd, sessionId: 'session-name' })

    expect(loaded.name).toBe('final name')
  })
})
