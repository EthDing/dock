import { appendFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FileHistorySnapshot } from '../../src/checkpoint/file-history.js'
import { createAssistantMessage, createUserMessage } from '../../src/messages/create-message.js'
import { asMessageUuid, asSessionId } from '../../src/sessions/ids.js'
import { SessionWriter, getSessionPath, loadSession } from '../../src/sessions/session-store.js'

const SESSION_ONE = asSessionId('10000000-0000-4000-8000-000000000001')
const MESSAGE_ONE = asMessageUuid('20000000-0000-4000-8000-000000000001')
const MESSAGE_TWO = asMessageUuid('20000000-0000-4000-8000-000000000002')
const MESSAGE_THREE = asMessageUuid('20000000-0000-4000-8000-000000000003')

describe('session store', () => {
  it('persists Skill context metadata for resume', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'dock-session-skill-'))
    const cwd = '/work/project'
    const writer = await SessionWriter.create({ configDir, cwd, sessionId: SESSION_ONE })
    await writer.recordTranscript([
      createUserMessage(
        { content: [{ type: 'text', text: '<skill_content>review</skill_content>' }] },
        {
          isMeta: true,
          skillContext: {
            contentHash: 'hash',
            location: '/skills/review/SKILL.md',
            name: 'review',
          },
          uuid: MESSAGE_ONE,
        },
      ),
    ])
    await writer.close()

    const loaded = await loadSession({ configDir, cwd, sessionId: SESSION_ONE })

    expect(loaded.messages[0]).toMatchObject({
      isMeta: true,
      skillContext: { contentHash: 'hash', name: 'review' },
    })
  })

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

  it('rewinds by moving the conversation head while retaining prior records', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'dock-session-rewind-'))
    const cwd = '/work/project'
    const sessionId = asSessionId('10000000-0000-4000-8000-000000000005')
    const writer = await SessionWriter.create({ configDir, cwd, sessionId })
    const first = createUserMessage(
      { content: [{ type: 'text', text: 'first' }] },
      { uuid: MESSAGE_ONE },
    )
    const discarded = createUserMessage(
      { content: [{ type: 'text', text: 'discarded' }] },
      { uuid: MESSAGE_TWO },
    )
    const replacement = createUserMessage(
      { content: [{ type: 'text', text: 'replacement' }] },
      { uuid: MESSAGE_THREE },
    )
    await writer.recordTranscript([first, discarded])
    await writer.rewindConversation(MESSAGE_ONE)
    await writer.recordTranscript([replacement])
    await writer.close()

    const loaded = await loadSession({ configDir, cwd, sessionId })

    expect(loaded.messages.map(({ uuid }) => uuid)).toEqual([MESSAGE_ONE, MESSAGE_THREE])
    expect(
      loaded.records.find(
        (record) =>
          (record.type === 'user' || record.type === 'assistant') && record.uuid === MESSAGE_THREE,
      ),
    ).toMatchObject({ parentUuid: MESSAGE_ONE })
    expect(loaded.records.some((record) => record.type === 'rewind')).toBe(true)
  })

  it('persists file-history snapshots for resume', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'dock-session-file-history-'))
    const cwd = '/work/project'
    const sessionId = asSessionId('10000000-0000-4000-8000-000000000006')
    const writer = await SessionWriter.create({ configDir, cwd, sessionId })
    const snapshot: FileHistorySnapshot = {
      messageId: MESSAGE_ONE,
      timestamp: new Date('2026-08-27T00:00:00.000Z'),
      trackedFileBackups: {
        'file.txt': {
          backupFileName: 'abc@v1',
          backupTime: new Date('2026-08-27T00:00:00.000Z'),
          version: 1,
        },
      },
    }
    await writer.recordFileHistorySnapshot(snapshot, false)
    await writer.close()

    const loaded = await loadSession({ configDir, cwd, sessionId })

    expect(loaded.fileHistorySnapshots).toHaveLength(1)
    expect(loaded.fileHistorySnapshots[0]).toMatchObject({ messageId: MESSAGE_ONE })
  })

  it('restores only summary, preserved tail, and new messages after compact', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'dock-session-compact-'))
    const cwd = '/work/project'
    const sessionId = asSessionId('10000000-0000-4000-8000-000000000007')
    const writer = await SessionWriter.create({ configDir, cwd, sessionId })
    const old = createUserMessage(
      { content: [{ type: 'text', text: 'old' }] },
      { uuid: MESSAGE_ONE },
    )
    const preserved = createUserMessage(
      { content: [{ type: 'text', text: 'preserved' }] },
      { uuid: MESSAGE_TWO },
    )
    const summary = createUserMessage(
      { content: [{ type: 'text', text: 'summary' }] },
      { isCompactSummary: true, uuid: MESSAGE_THREE },
    )
    const after = createUserMessage(
      { content: [{ type: 'text', text: 'after' }] },
      { uuid: asMessageUuid('20000000-0000-4000-8000-000000000004') },
    )
    await writer.recordTranscript([old, preserved])
    await writer.recordCompaction([summary, preserved])
    await writer.recordTranscript([after])
    await writer.close()

    const loaded = await loadSession({ configDir, cwd, sessionId })

    expect(
      loaded.messages.map((message) =>
        message.message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join(''),
      ),
    ).toEqual(['summary', 'preserved', 'after'])
  })
})
