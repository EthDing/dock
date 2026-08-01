import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FileHistory } from '../../src/checkpoint/file-history.js'
import { ExtractMemories } from '../../src/memory/extract-memories.js'
import { MemoryManager } from '../../src/memory/memory-manager.js'
import { FakeModelAdapter } from '../../src/model/fake-model.js'
import type { ModelStreamEvent } from '../../src/model/types.js'
import { SessionController } from '../../src/session-controller.js'
import { createSessionId } from '../../src/sessions/ids.js'
import { SessionWriter } from '../../src/sessions/session-store.js'
import { FileReadState } from '../../src/tools/file-read-state.js'
import { createEditTool, createReadTool, createWriteTool } from '../../src/tools/file-tools.js'

describe('auto memory flow', () => {
  it('extracts a missed memory and makes its index available to the next conversation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-memory-flow-'))
    const cwd = join(root, 'project')
    const configDir = join(root, '.dock')
    await mkdir(cwd)
    const memory = await MemoryManager.create({
      configDir,
      homeDir: root,
      now: () => new Date('2026-08-27T12:00:00.000Z'),
      projectRoot: cwd,
      settings: {},
    })
    await memory.initialize()
    const topicPath = join(memory.directory, 'feedback-package-manager.md')
    const model = new FakeModelAdapter([
      finalResponse('main-final', 'Understood.'),
      toolResponse('extract-write', [
        {
          id: 'write-topic',
          input: {
            content:
              '---\nname: feedback-package-manager\ndescription: Prefer pnpm for this project\ntype: feedback\n---\n\nUse pnpm rather than npm.',
            file_path: topicPath,
          },
          name: 'Write',
        },
        {
          id: 'write-index',
          input: {
            content:
              '- [Package manager preference](feedback-package-manager.md) — use pnpm, not npm',
            file_path: memory.entrypoint,
          },
          name: 'Write',
        },
      ]),
      finalResponse('extract-final', 'Saved.'),
    ])
    const writeLifecycle = {
      afterWrite: (filePath: string, content: string) => memory.inspectWrite(filePath, content),
      prepareWrite: (filePath: string, content: string) => memory.prepareWrite(filePath, content),
    }
    const extractorDependencies = {
      cwd,
      fileHistory: { trackEdit: async () => {} },
      readFileState: new FileReadState(),
      writeLifecycle,
    }
    const extractorTools = [
      createReadTool(extractorDependencies),
      createWriteTool(extractorDependencies),
      createEditTool(extractorDependencies),
    ]
    const onSaved = vi.fn()
    const extractMemories = new ExtractMemories({
      memory,
      model,
      modelId: 'test-model',
      onSaved,
      systemPrompt: [memory.buildSystemPrompt() ?? ''],
      tools: extractorTools,
    })
    const sessionId = createSessionId()
    const writer = await SessionWriter.create({ configDir, cwd, sessionId })
    const fileHistory = new FileHistory({ configDir, cwd, sessionId })
    const controller = new SessionController({
      fileHistory,
      model,
      modelId: 'test-model',
      systemPrompt: [memory.buildSystemPrompt() ?? ''],
      tools: [],
      turnComplete: extractMemories,
      writer,
    })

    for await (const _event of controller.submit('Remember that I prefer pnpm here')) {
      // Drain the visible main turn. Extraction continues in the background.
    }
    await controller.close()

    expect(await readFile(topicPath, 'utf8')).toContain('modified: 2026-08-27T12:00:00.000Z')
    expect(await readFile(memory.entrypoint, 'utf8')).toContain('feedback-package-manager.md')
    expect(onSaved).toHaveBeenCalledWith([topicPath])

    const nextConversationIndex = await memory.loadIndex()
    expect(nextConversationIndex?.content).toContain('use pnpm, not npm')
  })
})

function finalResponse(id: string, text: string): readonly ModelStreamEvent[] {
  return [
    { type: 'message_start', messageId: id },
    { type: 'content_block_start', index: 0, block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', stopReason: 'end_turn', usage: {} },
    { type: 'message_stop' },
  ]
}

function toolResponse(
  id: string,
  calls: Array<{ id: string; input: Record<string, unknown>; name: string }>,
): readonly ModelStreamEvent[] {
  const events: ModelStreamEvent[] = [{ type: 'message_start', messageId: id }]
  for (const [index, call] of calls.entries()) {
    events.push(
      {
        type: 'content_block_start',
        index,
        block: { type: 'tool_use', id: call.id, name: call.name },
      },
      {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partialJson: JSON.stringify(call.input) },
      },
      { type: 'content_block_stop', index },
    )
  }
  events.push(
    { type: 'message_delta', stopReason: 'tool_use', usage: {} },
    { type: 'message_stop' },
  )
  return events
}
