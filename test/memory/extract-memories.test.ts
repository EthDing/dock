import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createAssistantMessage, createUserMessage } from '../../src/messages/create-message.js'
import { createMemoryCanUseTool, ExtractMemories } from '../../src/memory/extract-memories.js'
import { MemoryManager } from '../../src/memory/memory-manager.js'
import { FakeModelAdapter } from '../../src/model/fake-model.js'
import type { ModelAdapter, ModelRequest, ModelStreamEvent } from '../../src/model/types.js'
import type { AgentTool } from '../../src/tools/types.js'

const finalResponse = (id: string): readonly ModelStreamEvent[] => [
  { type: 'message_start', messageId: id },
  { type: 'content_block_start', index: 0, block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', stopReason: 'end_turn', usage: {} },
  { type: 'message_stop' },
]

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

const tool = (name: string, execute = vi.fn(async () => ({ content: 'ok' }))): AgentTool => ({
  description: name,
  execute,
  inputSchema: { type: 'object' },
  isConcurrencySafe: () => false,
  name,
})

async function createMemory() {
  const root = await mkdtemp(join(tmpdir(), 'dock-extract-memory-'))
  const memory = await MemoryManager.create({
    configDir: join(root, '.dock'),
    homeDir: root,
    projectRoot: join(root, 'repo'),
    settings: {},
  })
  await memory.initialize()
  return memory
}

describe('ExtractMemories', () => {
  it('skips extraction when the main agent already wrote memory', async () => {
    const memory = await createMemory()
    const model = new FakeModelAdapter([])
    const extractor = new ExtractMemories({
      memory,
      model,
      modelId: 'test-model',
      systemPrompt: [],
      tools: [tool('Write')],
    })
    const messages = [
      createUserMessage({ content: [{ text: 'remember this', type: 'text' }] }),
      createAssistantMessage({
        content: [
          {
            id: 'main-write',
            input: { file_path: join(memory.directory, 'user.md'), content: 'fact' },
            name: 'Write',
            type: 'tool_use',
          },
        ],
        id: 'assistant-main',
        role: 'assistant',
        stopReason: 'tool_use',
        usage: {},
      }),
    ]

    extractor.schedule(messages)
    await extractor.drain()

    expect(model.requests).toHaveLength(0)
  })

  it('runs a restricted fork and reports only topic files as saved', async () => {
    const memory = await createMemory()
    const write = vi.fn(async () => ({ content: 'ok' }))
    const model = new FakeModelAdapter([
      toolResponse('extract-tools', [
        {
          id: 'topic',
          input: { file_path: join(memory.directory, 'feedback.md'), content: 'fact' },
          name: 'Write',
        },
        {
          id: 'index',
          input: { file_path: memory.entrypoint, content: '- feedback' },
          name: 'Write',
        },
      ]),
      finalResponse('extract-final'),
    ])
    const onSaved = vi.fn()
    const extractor = new ExtractMemories({
      memory,
      model,
      modelId: 'test-model',
      onSaved,
      systemPrompt: ['memory rules'],
      tools: [tool('Write', write)],
      userContext: { AUTO_MEMORY: 'index' },
    })
    const messages = [createUserMessage({ content: [{ text: 'Prefer pnpm', type: 'text' }] })]

    extractor.schedule(messages)
    await extractor.drain()

    expect(write).toHaveBeenCalledTimes(2)
    expect(onSaved).toHaveBeenCalledWith([join(memory.directory, 'feedback.md')])
    expect(model.requests[0]?.systemPrompt).toEqual(['memory rules'])
    expect(model.requests[0]?.messages.at(-1)).toMatchObject({ role: 'user' })
  })

  it('does not advance its cursor after a model failure', async () => {
    const memory = await createMemory()
    const model = new FakeModelAdapter([
      [{ type: 'message_start', messageId: 'incomplete' }],
      finalResponse('retry-success'),
    ])
    const extractor = new ExtractMemories({
      memory,
      model,
      modelId: 'test-model',
      systemPrompt: [],
      tools: [],
    })
    const messages = [createUserMessage({ content: [{ text: 'durable fact', type: 'text' }] })]

    extractor.schedule(messages)
    await extractor.drain()
    extractor.schedule(messages)
    await extractor.drain()

    expect(model.requests).toHaveLength(2)
  })

  it('restricts tools to reads, read-only Bash, and memory writes', async () => {
    const memory = await createMemory()
    const canUseTool = createMemoryCanUseTool(memory)
    const context = {
      parentMessageUuid: crypto.randomUUID(),
      signal: new AbortController().signal,
      toolUseId: 'tool',
    }

    await expect(canUseTool(tool('Read'), {}, context)).resolves.toEqual({ behavior: 'allow' })
    await expect(canUseTool(tool('Bash'), { command: 'git status' }, context)).resolves.toEqual({
      behavior: 'allow',
    })
    await expect(
      canUseTool(tool('Write'), { file_path: join(memory.directory, 'topic.md') }, context),
    ).resolves.toEqual({ behavior: 'allow' })
    await expect(
      canUseTool(tool('Bash'), { command: 'rm -rf /tmp/example' }, context),
    ).resolves.toMatchObject({ behavior: 'deny' })
    await expect(
      canUseTool(tool('Write'), { file_path: '/tmp/outside.md' }, context),
    ).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('coalesces overlapping requests and processes only the latest trailing context', async () => {
    const memory = await createMemory()
    const firstGate = deferred()
    const secondGate = deferred()
    const requests: ModelRequest[] = []
    const gates = [firstGate, secondGate]
    const model: ModelAdapter = {
      async *stream(request) {
        requests.push(request)
        await gates[requests.length - 1]?.promise
        yield* finalResponse(`response-${requests.length}`)
      },
    }
    const extractor = new ExtractMemories({
      memory,
      model,
      modelId: 'test-model',
      systemPrompt: [],
      tools: [],
    })
    const first = createUserMessage({ content: [{ text: 'first', type: 'text' }] })
    const second = createUserMessage({ content: [{ text: 'second', type: 'text' }] })
    const third = createUserMessage({ content: [{ text: 'third', type: 'text' }] })

    extractor.schedule([first])
    await waitFor(() => requests.length === 1)
    extractor.schedule([first, second])
    extractor.schedule([first, second, third])
    firstGate.resolve()
    await waitFor(() => requests.length === 2)
    secondGate.resolve()
    await extractor.drain()

    expect(requests).toHaveLength(2)
    const trailingPrompt = requests[1]?.messages.at(-1)?.content[0]
    expect(trailingPrompt).toMatchObject({ type: 'text' })
    if (trailingPrompt?.type === 'text') expect(trailingPrompt.text).toContain('recent 2 messages')
  })
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('Timed out waiting for predicate')
}

it('freezes each scheduled context snapshot while extraction is running', async () => {
  const memory = await createMemory()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const requests: ModelRequest[] = []
  const model: ModelAdapter = {
    async *stream(request) {
      requests.push(request)
      if (requests.length === 1) await gate
      yield* finalResponse(String(requests.length))
    },
  }
  const extractor = new ExtractMemories({
    memory,
    model,
    modelId: 'test',
    tools: [],
    systemPrompt: ['fixed'],
  })
  const first = createUserMessage({ content: [{ type: 'text', text: 'first' }] })
  extractor.schedule([first], { AGENTS: 'old' })
  const deadline = Date.now() + 2000
  while (!requests.length) {
    if (Date.now() > deadline) throw new Error('Extraction did not start')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const second = createUserMessage({ content: [{ type: 'text', text: 'second' }] })
  const newContext = { AGENTS: 'new' }
  extractor.schedule([first, second], newContext)
  newContext.AGENTS = 'mutated later'
  release()
  await extractor.drain()
  expect(JSON.stringify(requests[0]?.messages[0])).toContain('old')
  expect(JSON.stringify(requests[1]?.messages[0])).toContain('new')
  expect(JSON.stringify(requests[1]?.messages[0])).not.toContain('mutated later')
})
