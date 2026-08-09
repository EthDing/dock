import { appendFile, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '../../src/messages/create-message.js'
import { createSessionId } from '../../src/sessions/ids.js'
import { forkSession } from '../../src/sessions/session-manager.js'
import { getSessionPath, loadSession, SessionWriter } from '../../src/sessions/session-store.js'

async function setup() {
  const location = {
    configDir: await mkdtemp(join(tmpdir(), 'dock-compact-records-')),
    cwd: '/work/test',
    sessionId: createSessionId(),
  }
  return { location, writer: await SessionWriter.create(location) }
}
describe('compaction persistence', () => {
  it('replays clearing without rewriting raw output and forks the same effective history', async () => {
    const { location, writer } = await setup()
    const user = createUserMessage({
      content: [{ type: 'tool_result', toolUseId: 'old-call', content: 'RAW ORIGINAL' }],
    })
    await writer.recordTranscript([user])
    await writer.recordToolResultClearing(['old-call'])
    await writer.close()
    const loaded = await loadSession(location)
    expect(JSON.stringify(loaded.messages)).not.toContain('RAW ORIGINAL')
    expect(await readFile(getSessionPath(location), 'utf8')).toContain('RAW ORIGINAL')
    const fork = await forkSession({
      ...location,
      sourceSessionId: location.sessionId,
      targetSessionId: createSessionId(),
    })
    expect(fork.messages).toEqual(loaded.messages)
  })
  it('persists new attachments and can rewind before successive compactions', async () => {
    const { location, writer } = await setup()
    const old = createUserMessage({ content: [{ type: 'text', text: 'old' }] })
    await writer.recordTranscript([old])
    const summary = createUserMessage(
      { content: [{ type: 'text', text: 'summary' }] },
      { isCompactSummary: true },
    )
    const attachment = createUserMessage(
      { content: [{ type: 'text', text: 'restored file' }] },
      { isMeta: true },
    )
    await writer.recordCompaction([summary, attachment])
    const summary2 = createUserMessage(
      { content: [{ type: 'text', text: 'second' }] },
      { isCompactSummary: true },
    )
    await writer.recordCompaction([summary2])
    await writer.rewindConversation(attachment.uuid)
    await writer.close()
    expect((await loadSession(location)).messages).toEqual([summary, attachment])
    const reopened = await SessionWriter.open(location)
    await reopened.rewindConversation(old.uuid)
    await reopened.close()
    expect((await loadSession(location)).messages).toEqual([old])
  })
  it('ignores a staged summary without its commit boundary', async () => {
    const { location, writer } = await setup()
    const old = createUserMessage({ content: [{ type: 'text', text: 'old' }] })
    await writer.recordTranscript([old])
    await writer.close()
    const summary = createUserMessage(
      { content: [{ type: 'text', text: 'uncommitted' }] },
      { isCompactSummary: true },
    )
    await appendFile(
      getSessionPath(location),
      `${JSON.stringify({
        ...summary,
        parentUuid: null,
        compactionId: summary.uuid,
        sessionId: location.sessionId,
        cwd: location.cwd,
      })}\n`,
    )
    expect((await loadSession(location)).messages).toEqual([old])
  })

  it('can resume writing after a crash leaves a partial compact boundary', async () => {
    const { location, writer } = await setup()
    const original = createUserMessage({ content: [{ type: 'text', text: 'original' }] })
    await writer.recordTranscript([original])
    await writer.close()
    await appendFile(getSessionPath(location), '{"type":"compact_boundary"')
    const reopened = await SessionWriter.open(location)
    const next = createUserMessage({ content: [{ type: 'text', text: 'next' }] })
    await reopened.recordTranscript([next])
    await reopened.close()
    expect((await loadSession(location)).messages).toEqual([original, next])
  })
})
