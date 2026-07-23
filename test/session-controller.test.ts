import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionController } from '../src/session-controller.js'
import { FakeModelAdapter } from '../src/model/fake-model.js'
import { createSessionId } from '../src/sessions/ids.js'
import { loadSession, SessionWriter } from '../src/sessions/session-store.js'
import { FileHistory } from '../src/checkpoint/file-history.js'

describe('SessionController', () => {
  it('persists a complete user and assistant turn', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'dock-controller-'))
    const cwd = '/work/project'
    const sessionId = createSessionId()
    const writer = await SessionWriter.create({ configDir, cwd, sessionId })
    const fileHistory = new FileHistory({
      configDir,
      cwd,
      onSnapshot: (snapshot, isUpdate) => writer.recordFileHistorySnapshot(snapshot, isUpdate),
      sessionId,
    })
    const model = new FakeModelAdapter([
      [
        { type: 'message_start', messageId: 'provider-message' },
        { type: 'content_block_start', index: 0, block: { type: 'text' } },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hello' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', stopReason: 'end_turn', usage: { outputTokens: 1 } },
        { type: 'message_stop' },
      ],
    ])
    const controller = new SessionController({
      fileHistory,
      model,
      modelId: 'test-model',
      systemPrompt: [],
      tools: [],
      writer,
    })

    for await (const _event of controller.submit('hi')) {
      // Drain the streamed turn.
    }
    await controller.close()
    const loaded = await loadSession({ configDir, cwd, sessionId })

    expect(loaded.messages.map(({ type }) => type)).toEqual(['user', 'assistant'])
    expect(loaded.messages[1]).toMatchObject({
      type: 'assistant',
      message: { id: 'provider-message', content: [{ type: 'text', text: 'hello' }] },
    })
    expect(loaded.fileHistorySnapshots).toHaveLength(1)
  })
})
