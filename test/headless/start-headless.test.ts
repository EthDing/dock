import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseCliOptions, type HeadlessOutputFormat } from '../../src/cli-options.js'
import { trustWorkspace } from '../../src/config/workspace-trust.js'
import { startHeadless } from '../../src/headless/start-headless.js'
import { FakeModelAdapter } from '../../src/model/fake-model.js'
import type { ModelStreamEvent } from '../../src/model/types.js'
import { findMostRecentSession } from '../../src/sessions/session-manager.js'
import { loadSession } from '../../src/sessions/session-store.js'
import { createDockRuntime } from '../../src/runtime/create-runtime.js'
import type { SandboxManagerApi } from '../../src/sandbox/dock-sandbox.js'

const finalResponse = (text: string, id = 'answer'): readonly ModelStreamEvent[] => [
  { type: 'message_start', messageId: id },
  { type: 'content_block_start', index: 0, block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 } },
  { type: 'message_stop' },
]

const toolResponse = (
  name: string,
  input: Record<string, unknown>,
  id = 'tool-turn',
): readonly ModelStreamEvent[] => [
  { type: 'message_start', messageId: id },
  { type: 'content_block_start', index: 0, block: { type: 'tool_use', id, name } },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partialJson: JSON.stringify(input) },
  },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', stopReason: 'tool_use', usage: {} },
  { type: 'message_stop' },
]

async function fixture(options: { memory?: string; agents?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dock-headless-'))
  const homeDir = join(root, 'home')
  await mkdir(join(root, '.git'))
  await mkdir(join(homeDir, '.dock'), { recursive: true })
  await writeFile(
    join(homeDir, '.dock', 'settings.json'),
    `${JSON.stringify({
      model: 'fake:test-model',
      providers: {
        fake: {
          protocol: 'openai-chat-completions',
          apiKeyEnv: 'FAKE_API_KEY',
          contextWindow: 200_000,
          maxOutputTokens: 8192,
        },
      },
    })}\n`,
  )
  if (options.agents) await writeFile(join(root, 'AGENTS.md'), options.agents)
  await trustWorkspace({ homeDir, workspace: root })
  if (options.memory) {
    const memoryDirectory = join(homeDir, '.dock', 'projects')
    await mkdir(memoryDirectory, { recursive: true })
    // The exact encoded project directory is discovered after the first memory-enabled run.
  }
  return { root, homeDir }
}

async function run(
  format: HeadlessOutputFormat,
  modelOrFactory: FakeModelAdapter | ((root: string) => FakeModelAdapter),
  options: { noMemory?: boolean; agents?: string; maxTurns?: number; signal?: AbortSignal } = {},
) {
  const { root, homeDir } = await fixture({
    ...(options.agents !== undefined ? { agents: options.agents } : {}),
  })
  const model = typeof modelOrFactory === 'function' ? modelOrFactory(root) : modelOrFactory
  const stdout: string[] = []
  const stderr: string[] = []
  const args = [
    '-p',
    '--output-format',
    format,
    ...(options.maxTurns !== undefined ? ['--max-turns', String(options.maxTurns)] : []),
    ...(options.noMemory ? ['--no-memory'] : []),
    'do the task',
  ]
  const cli = parseCliOptions(args)
  const code = await startHeadless({
    args,
    cli,
    cwd: root,
    homeDir,
    environment: { FAKE_API_KEY: 'test-key' },
    io: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
    modelFactory: () => model,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return { code, root, homeDir, model, stdout, stderr }
}

describe('headless runtime', () => {
  it.each(['none', 'full', 'head5k', 'pointer'] as const)(
    'wires eval environment and persists %s restoration metrics',
    async (mode) => {
      const { root, homeDir } = await fixture()
      const directory = join(root, '.dock', 'skills', 'review')
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, 'SKILL.md'),
        `---\nname: review\ndescription: Review code\n---\n${'x'.repeat(25_000)}\nTAIL`,
      )
      const file = join(root, 'file.txt')
      await writeFile(file, 'data')
      const model = new FakeModelAdapter([
        toolResponse('Skill', { name: 'review' }, 'activate'),
        toolResponse('Read', { file_path: file }, 'read'),
        finalResponse('compact summary', 'summary'),
        finalResponse('done'),
      ])
      const code = await startHeadless({
        args: ['-p', '--no-memory', 'work'],
        cli: parseCliOptions(['-p', '--no-memory', 'work']),
        cwd: root,
        homeDir,
        environment: {
          FAKE_API_KEY: 'test-key',
          DOCK_EVAL_SKILL_RESTORE: mode,
          DOCK_EVAL_COMPACT_AFTER: '1',
        },
        modelFactory: () => model,
        io: { stdout: () => {}, stderr: () => {} },
      })
      expect(code).toBe(0)
      expect(model.requests).toHaveLength(4)
      const latest = await findMostRecentSession({ configDir: join(homeDir, '.dock'), cwd: root })
      if (!latest) throw new Error('Missing session')
      const loaded = await loadSession({
        configDir: join(homeDir, '.dock'),
        cwd: root,
        sessionId: latest.sessionId,
      })
      const boundary = loaded.records.find((record) => record.type === 'compact_boundary')
      expect(boundary).toMatchObject({
        metadata: { evalCompactAfter: 1, skillRestoration: { mode } },
      })
      if (boundary?.type !== 'compact_boundary') throw new Error('Missing boundary')
      const metric = boundary.metadata?.skillRestoration?.skills[0]
      const restored = loaded.messages.find(
        (message) => message.type === 'user' && message.skillContext?.name === 'review',
      )
      const text =
        restored?.message.content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('\n') ?? ''
      expect(metric?.tokens).toBe(Math.ceil(text.length / 4))
      if (mode === 'none') expect(metric?.tokens).toBe(0)
      if (mode === 'head5k') expect(metric?.tokens).toBe(5000)
      if (mode === 'full') expect(text).toContain('TAIL')
      if (mode === 'pointer') expect(text).toContain('Skill tool or Read')
    },
  )
  it('prints only the final assistant text in text mode', async () => {
    const result = await run('text', new FakeModelAdapter([finalResponse('done')]))
    expect(result.code).toBe(0)
    expect(result.stdout).toEqual(['done\n'])
    expect(result.stderr).toEqual([])
    await expect(
      findMostRecentSession({ configDir: join(result.homeDir, '.dock'), cwd: result.root }),
    ).resolves.toBeDefined()
  })

  it('emits one result object in json mode', async () => {
    const result = await run('json', new FakeModelAdapter([finalResponse('done')]))
    expect(result.stdout).toHaveLength(1)
    expect(JSON.parse(result.stdout[0] ?? '')).toMatchObject({
      schema_version: 1,
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
    })
  })

  it('emits init, committed messages and a final result as NDJSON', async () => {
    const result = await run('stream-json', new FakeModelAdapter([finalResponse('done')]))
    const events = result.stdout.map((line) => JSON.parse(line))
    expect(events.map((event) => `${event.type}/${event.subtype ?? ''}`)).toEqual([
      'system/init',
      'user/',
      'assistant/',
      'result/success',
    ])
    expect(events.filter((event) => event.type === 'assistant')).toHaveLength(1)
  })

  it('emits each tool call and result once in stream-json', async () => {
    const result = await run(
      'stream-json',
      new FakeModelAdapter([
        toolResponse('Glob', { pattern: '*' }, 'glob-stream'),
        finalResponse('done', 'after-glob'),
      ]),
      { noMemory: true },
    )
    const events = result.stdout.map((line) => JSON.parse(line))
    const toolUses = events.flatMap((event) =>
      event.type === 'assistant'
        ? event.message.content.filter((block: { type: string }) => block.type === 'tool_use')
        : [],
    )
    const toolResults = events.flatMap((event) =>
      event.type === 'user'
        ? event.message.content.filter((block: { type: string }) => block.type === 'tool_result')
        : [],
    )
    expect(toolUses).toHaveLength(1)
    expect(toolResults).toHaveLength(1)
  })

  it('disables only Auto Memory while retaining AGENTS context', async () => {
    const model = new FakeModelAdapter([finalResponse('done')])
    await run('text', model, { noMemory: true, agents: '# Project rule\nUse pnpm.' })
    expect(model.requests[0]?.messages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text' }],
    })
    expect(JSON.stringify(model.requests[0])).toContain('Use pnpm.')
    expect(JSON.stringify(model.requests[0])).not.toContain('AUTO_MEMORY')
    expect(model.requests[0]?.systemPrompt.join('\n')).not.toContain(
      'persistent, file-based memory',
    )
  })

  it('denies interactive permissions without hanging and lets the model recover', async () => {
    const result = await run(
      'text',
      (root) =>
        new FakeModelAdapter([
          toolResponse('Write', { file_path: join(root, 'blocked.txt'), content: 'unsafe' }),
          finalResponse('permission denied, no changes made', 'answer-after-deny'),
        ]),
    )
    const request = result.model.requests[0]
    const writeCall = request?.messages
    expect(result.code).toBe(0)
    expect(result.stdout).toEqual(['permission denied, no changes made\n'])
    expect(JSON.stringify(result.model.requests[1])).toContain('User denied Write')
    await expect(readFile(join(result.root, 'blocked.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(writeCall).toBeDefined()
  })

  it('returns an explicit tool error when the model asks for headless interaction', async () => {
    const result = await run(
      'text',
      new FakeModelAdapter([
        toolResponse('AskUserQuestion', {
          questions: [
            {
              question: 'Choose one',
              header: 'Choice',
              multiSelect: false,
              options: [
                { label: 'A', description: 'first' },
                { label: 'B', description: 'second' },
              ],
            },
          ],
        }),
        finalResponse('interaction unavailable', 'answer-after-question'),
      ]),
    )
    expect(JSON.stringify(result.model.requests[1])).toContain(
      'User interaction is unavailable in headless mode',
    )
    expect(result.code).toBe(0)
  })

  it('returns a structured max-turn error before executing the next tool round', async () => {
    const result = await run(
      'json',
      new FakeModelAdapter([
        toolResponse('Glob', { pattern: '*' }, 'glob-one'),
        toolResponse('Glob', { pattern: '**/*' }, 'glob-two'),
      ]),
      { maxTurns: 1 },
    )
    expect(result.model.requests).toHaveLength(2)
    expect(JSON.parse(result.stdout[0] ?? '')).toMatchObject({
      subtype: 'error_max_turns',
      is_error: true,
    })
    expect(result.code).toBe(1)
  })

  it('waits for delegated agents before the parent continues', async () => {
    const result = await run(
      'text',
      new FakeModelAdapter([
        toolResponse('Agent', {
          prompt: 'inspect one thing',
          description: 'inspect',
          context: 'fresh',
        }),
        finalResponse('child done', 'child-answer'),
        finalResponse('parent done', 'parent-answer'),
      ]),
      { noMemory: true },
    )
    expect(result.model.requests).toHaveLength(3)
    expect(JSON.stringify(result.model.requests[2])).toContain('completed')
    expect(result.stdout).toEqual(['parent done\n'])
  })

  it('returns 130 for an interrupted headless run', async () => {
    const abort = new AbortController()
    abort.abort('test interrupt')
    const result = await run('json', new FakeModelAdapter([finalResponse('never')]), {
      signal: abort.signal,
    })
    expect(JSON.parse(result.stdout[0] ?? '')).toMatchObject({
      subtype: 'error_aborted',
      is_error: true,
    })
    expect(result.code).toBe(130)
  })

  it('resets initialized resources when runtime construction fails', async () => {
    const { root, homeDir } = await fixture()
    const settingsPath = join(homeDir, '.dock', 'settings.json')
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
    settings.sandbox = { enabled: true, failIfUnavailable: true }
    await writeFile(settingsPath, `${JSON.stringify(settings)}\n`)
    const initialize = vi.fn(async () => {})
    const reset = vi.fn(async () => {})
    const manager: SandboxManagerApi = {
      annotateStderrWithSandboxFailures: (_command, stderr) => stderr,
      checkDependencies: () => ({ errors: [], warnings: [] }),
      cleanupAfterCommand: () => {},
      initialize,
      isSupportedPlatform: () => true,
      reset,
      updateConfig: () => {},
      wrapWithSandbox: async (command) => command,
    }
    const args = ['-p', 'fail setup']
    await expect(
      createDockRuntime({
        args,
        cli: parseCliOptions(args),
        cwd: root,
        homeDir,
        environment: { FAKE_API_KEY: 'test-key' },
        modelFactory: () => {
          throw new Error('model factory failed')
        },
        sandboxManager: manager,
      }),
    ).rejects.toThrow('model factory failed')
    expect(initialize).toHaveBeenCalledOnce()
    expect(reset).toHaveBeenCalledOnce()
  })
})
