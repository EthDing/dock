import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { type Terminal, TuiAltScreen } from '@dock/tui'
import { describe, expect, it } from 'vitest'
import { FileHistory } from '../../src/checkpoint/file-history.js'
import { FakeModelAdapter } from '../../src/model/fake-model.js'
import { SessionController } from '../../src/session-controller.js'
import { createSessionId } from '../../src/sessions/ids.js'
import { loadSession, SessionWriter } from '../../src/sessions/session-store.js'
import { FileReadState } from '../../src/tools/file-read-state.js'
import { createReadTool } from '../../src/tools/file-tools.js'
import { DockTuiApp } from '../../src/ui/dock-tui-app.js'

class MemoryTerminal implements Terminal {
  columns = 100
  rows = 30
  kittyProtocolActive = false
  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

describe('Dock end-to-end flow', () => {
  it('streams a tool-using turn through the TUI and persists the transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-e2e-'))
    const cwd = join(root, 'project')
    const configDir = join(root, 'config')
    const filePath = join(cwd, 'hello.txt')
    await mkdir(cwd, { recursive: true })
    await writeFile(filePath, 'hello from the workspace')

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
        { type: 'message_start', messageId: 'tool-request' },
        {
          type: 'content_block_start',
          index: 0,
          block: { type: 'tool_use', id: 'read-1', name: 'Read' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partialJson: JSON.stringify({ file_path: filePath }) },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', stopReason: 'tool_use', usage: { outputTokens: 8 } },
        { type: 'message_stop' },
      ],
      [
        { type: 'message_start', messageId: 'final-answer' },
        { type: 'content_block_start', index: 0, block: { type: 'text' } },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'The file says hello from the workspace.' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', stopReason: 'end_turn', usage: { outputTokens: 9 } },
        { type: 'message_stop' },
      ],
    ])
    const controller = new SessionController({
      fileHistory,
      model,
      modelId: 'fake-model',
      systemPrompt: ['You are Dock.'],
      tools: [createReadTool({ cwd, fileHistory, readFileState: new FileReadState() })],
      writer,
    })
    const tui = new TuiAltScreen(new MemoryTerminal())
    const app = new DockTuiApp({ controller, tui })

    await app.submit('Read hello.txt')
    const rendered = stripVTControlCharacters(tui.render(100).join('\n'))
    expect(rendered.split('Read hello.txt')).toHaveLength(2)
    expect(rendered).toContain('Read')
    expect(rendered).toContain('The file says hello from the workspace.')

    await app.stop()
    const loaded = await loadSession({ configDir, cwd, sessionId })
    expect(loaded.messages.map((message) => message.type)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ])
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'read-1' }],
    })
  })
})
