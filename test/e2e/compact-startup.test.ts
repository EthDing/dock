import { mkdir, mkdtemp, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@dock/tui'
import * as modelFactory from '../../src/model/create-model-adapter.js'
import type { ModelAdapter, ModelRequest, ModelStreamEvent } from '../../src/model/types.js'
import { MemoryManager } from '../../src/memory/memory-manager.js'
import { startDock } from '../../src/start-dock.js'
import { loadSession, getProjectSessionsDirectory } from '../../src/sessions/session-store.js'
import { asSessionId } from '../../src/sessions/ids.js'

class TestTerminal implements Terminal {
  columns = 100
  rows = 30
  kittyProtocolActive = false
  input: ((data: string) => void) | undefined
  output = ''
  start(input: (data: string) => void) {
    this.input = input
  }
  stop() {}
  async drainInput() {}
  write(data: string) {
    this.output += data
  }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  send(text: string) {
    this.input?.(text)
    this.input?.('\r')
  }
}
const response = (text: string): ModelStreamEvent[] => [
  { type: 'message_start', messageId: 'response' },
  { type: 'content_block_start', index: 0, block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', stopReason: 'end_turn', usage: { inputTokens: 500, outputTokens: 10 } },
  { type: 'message_stop' },
]
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for terminal')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
describe('compact through the startup and TUI pipeline', () => {
  it('reloads project instructions and memory after /compact and persists a resumable result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-compact-startup-'))
    const cwd = join(root, 'repo'),
      homeDir = join(root, 'home'),
      configDir = join(homeDir, '.dock')
    await mkdir(join(cwd, '.git'), { recursive: true })
    await mkdir(configDir, { recursive: true })
    await writeFile(
      join(configDir, 'settings.json'),
      JSON.stringify({
        model: 'test:test-model',
        providers: { test: { protocol: 'openai-responses', apiKeyEnv: 'TEST_KEY' } },
        sandbox: { enabled: false },
      }),
    )
    await writeFile(join(cwd, 'AGENTS.md'), 'OLD_RULES')
    const memory = await MemoryManager.create({
      configDir,
      homeDir,
      projectRoot: cwd,
      settings: {},
    })
    await memory.initialize()
    await writeFile(memory.entrypoint, 'OLD_MEMORY')
    const normal: ModelRequest[] = []
    const summaries: ModelRequest[] = []
    let extractions = 0
    const model: ModelAdapter = {
      async *stream(request) {
        const tail = JSON.stringify(request.messages.at(-1))
        if (tail.includes('Primary Request and Intent')) {
          summaries.push(request)
          yield* response(
            '<summary>The user is discussing this project. Continue the current request.</summary>',
          )
        } else if (tail.includes('Review only the most recent')) {
          extractions++
          yield* response('No memory updates')
        } else {
          normal.push(request)
          yield* response(`MAIN-${normal.length}`)
        }
      },
    }
    const spy = vi.spyOn(modelFactory, 'createModelAdapter').mockReturnValue(model)
    const terminal = new TestTerminal()
    const running = startDock({
      args: [],
      cwd,
      homeDir,
      environment: { TEST_KEY: 'test-only' },
      terminal,
      workspaceTrustPrompter: async () => true,
    })
    try {
      await until(() => Boolean(terminal.input))
      terminal.send('hello')
      await until(() => extractions >= 1)
      await writeFile(join(cwd, 'AGENTS.md'), 'NEW_RULES')
      await writeFile(memory.entrypoint, 'NEW_MEMORY')
      terminal.send('/compact')
      await until(() => terminal.output.includes('Conversation compacted'))
      terminal.send('continue')
      await until(() => extractions >= 2)
      expect(summaries).toHaveLength(1)
      expect(JSON.stringify(summaries[0]?.messages)).toContain('OLD_RULES')
      expect(JSON.stringify(normal[1]?.messages)).toContain('NEW_RULES')
      expect(JSON.stringify(normal[1]?.messages)).toContain('NEW_MEMORY')
      expect(JSON.stringify(normal[1]?.messages)).not.toContain('OLD_RULES')
      terminal.send('/exit')
      await running
      const sessions = await readdir(getProjectSessionsDirectory({ configDir, cwd }))
      const name = sessions.find((path) => path.endsWith('.jsonl'))
      if (!name) throw new Error('Session not saved')
      const loaded = await loadSession({
        configDir,
        cwd,
        sessionId: asSessionId(name.slice(0, -6)),
      })
      expect(loaded.messages[0]).toMatchObject({ isCompactSummary: true })
      expect(loaded.records.some((record) => record.type === 'compact_boundary')).toBe(true)
      expect(JSON.stringify(loaded.records)).not.toContain('CRITICAL: Respond with TEXT ONLY')
    } finally {
      terminal.input?.('\u0003')
      await running
      spy.mockRestore()
    }
  })
})
