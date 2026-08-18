import { appendFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '../../src/messages/create-message.js'
import { createSessionId } from '../../src/sessions/ids.js'
import { SessionWriter, loadSession, getSessionPath } from '../../src/sessions/session-store.js'
const message = (text: string) => createUserMessage({ content: [{ type: 'text', text }] })
const summary = (text: string) =>
  createUserMessage({ content: [{ type: 'text', text }] }, { isCompactSummary: true })
async function setup() {
  const location = {
    configDir: await mkdtemp(join(tmpdir(), 'dock-display-')),
    cwd: '/work',
    sessionId: createSessionId(),
  }
  return { location, writer: await SessionWriter.create(location) }
}
describe('display history independent of model context', () => {
  it('retains pre-compact text and raw cleared results across consecutive compacts and resume', async () => {
    const { location, writer } = await setup()
    const first = message('original'),
      raw = createUserResult(),
      one = summary('one'),
      two = summary('two')
    await writer.recordTranscript([first, raw])
    await writer.recordToolResultClearing(['tool'])
    await writer.recordCompaction([one])
    const next = message('follow-up')
    await writer.recordTranscript([next])
    await writer.recordCompaction([two])
    await writer.close()
    const loaded = await loadSession(location)
    expect(loaded.messages).toEqual([two])
    expect(loaded.displayMessages.map((m) => m.uuid)).toEqual(
      [first, raw, one, next, two].map((m) => m.uuid),
    )
    expect(JSON.stringify(loaded.displayMessages)).toContain('RAW')
  })
  it('omits abandoned branches and uncommitted compaction staging', async () => {
    const { location, writer } = await setup(),
      first = message('first'),
      discarded = message('discarded'),
      kept = message('kept')
    await writer.recordTranscript([first, discarded])
    await writer.rewindConversation(first.uuid)
    await writer.recordTranscript([kept])
    await writer.close()
    const staged = summary('uncommitted')
    await appendFile(
      getSessionPath(location),
      `${JSON.stringify({
        ...staged,
        compactionId: staged.uuid,
        parentUuid: null,
        sessionId: location.sessionId,
        cwd: location.cwd,
      })}\n`,
    )
    expect((await loadSession(location)).displayMessages.map((m) => m.uuid)).toEqual([
      first.uuid,
      kept.uuid,
    ])
  })
  it('supports legacy boundaries with preserved tail IDs without duplicate messages or cycles', async () => {
    const { location, writer } = await setup(),
      first = message('first'),
      tail = message('tail'),
      compact = summary('legacy')
    await writer.recordTranscript([first, tail])
    await writer.close()
    await appendFile(
      getSessionPath(location),
      `${[
        JSON.stringify({
          ...compact,
          parentUuid: null,
          sessionId: location.sessionId,
          cwd: location.cwd,
        }),
        JSON.stringify({
          type: 'compact_boundary',
          summaryUuid: compact.uuid,
          preservedUuids: [tail.uuid],
          timestamp: new Date().toISOString(),
        }),
      ].join('\n')}\n`,
    )
    const loaded = await loadSession(location)
    expect(loaded.messages).toEqual([compact, tail])
    expect(loaded.displayMessages.map((m) => m.uuid)).toEqual([first.uuid, tail.uuid, compact.uuid])
  })
})
function createUserResult() {
  return createUserMessage({
    content: [{ type: 'tool_result', toolUseId: 'tool', content: 'RAW' }],
  })
}
