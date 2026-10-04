import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseCliOptions } from '../../src/cli-options.js'
import { loadSettings } from '../../src/config/load-settings.js'
import { trustWorkspace } from '../../src/config/workspace-trust.js'
import { startHeadless } from '../../src/headless/start-headless.js'
import { createDockRuntime } from '../../src/runtime/create-runtime.js'
import { FakeModelAdapter } from '../../src/model/fake-model.js'
import type { ModelAdapter, ModelRequest, ModelStreamEvent } from '../../src/model/types.js'
import { response, review } from '../permissions/auto-fixtures.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const call = (name: string, input: Record<string, unknown>): ModelStreamEvent[] => [
  { type: 'message_start', messageId: 'call' },
  {
    type: 'content_block_start',
    index: 0,
    block: { type: 'tool_use', id: crypto.randomUUID(), name },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partialJson: JSON.stringify(input) },
  },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', stopReason: 'tool_use', usage: {} },
  { type: 'message_stop' },
]
async function fixture(classifierModel?: string) {
  const root = await mkdtemp(join(tmpdir(), 'dock-auto-runtime-'))
  roots.push(root)
  const cwd = join(root, 'repo'),
    homeDir = join(root, 'home')
  await mkdir(join(cwd, '.git'), { recursive: true })
  await mkdir(join(homeDir, '.dock'), { recursive: true })
  await writeFile(
    join(homeDir, '.dock/settings.json'),
    JSON.stringify({
      model: 'fake:session-model',
      autoMemoryEnabled: false,
      providers: { fake: { protocol: 'openai-chat-completions', apiKeyEnv: 'TEST_CREDENTIAL' } },
      permissions: {
        defaultMode: 'auto',
        auto: {
          ...(classifierModel ? { model: classifierModel } : {}),
          environment: 'Trusted test repository',
          blockRules: ['Never publish secrets'],
          allowExceptions: ['Local test fixtures are disposable'],
        },
      },
    }),
  )
  await trustWorkspace({ homeDir, workspace: cwd })
  return { root, cwd, homeDir, environment: { TEST_CREDENTIAL: 'fake-test-only' } }
}
function router(main: ModelAdapter, child?: ModelAdapter) {
  const classifierRequests: ModelRequest[] = []
  const model: ModelAdapter = {
    async *stream(request, options) {
      if (request.systemPrompt[0]?.startsWith("You are Dock's tool permission classifier")) {
        classifierRequests.push(request)
        const text = request.messages[0]?.content[0]
        const pending = text?.type === 'text' ? JSON.parse(text.text).pending : {}
        yield* response(
          pending.name === 'Agent'
            ? 'ALLOW'
            : JSON.stringify(request.messages.at(-1)).includes('Stage 1:')
              ? 'BLOCK'
              : review(),
        )
      } else if (child && request.systemPrompt[0]?.startsWith('You are an agent for Dock')) {
        yield* child.stream(request, options)
      } else yield* main.stream(request, options)
    },
  }
  return { model, classifierRequests }
}

describe('auto mode through the runtime', () => {
  it.each([undefined, 'fake:review-model'])(
    'blocks execution, returns an error tool result, continues with a safe edit and selects model %s',
    async (classifierModel) => {
      const f = await fixture(classifierModel)
      const forbidden = join(f.cwd, 'forbidden'),
        safe = join(f.cwd, 'safe.txt')
      const main = new FakeModelAdapter([
        call('Bash', { command: `touch ${forbidden}`, description: 'DESCRIPTION-POISON' }),
        call('Write', { file_path: safe, content: 'safe alternative' }),
        response('done'),
      ])
      const r = router(main)
      const args = ['-p', '--permission-mode', 'auto', 'Implement the requested feature']
      const code = await startHeadless({
        ...f,
        args,
        cli: parseCliOptions(args),
        modelFactory: () => r.model,
        io: { stdout() {}, stderr() {} },
      })
      expect(code).toBe(0)
      await expect(readFile(forbidden)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(safe, 'utf8')).toBe('safe alternative')
      expect(r.classifierRequests).toHaveLength(2)
      expect(r.classifierRequests[0]?.modelId).toBe(
        classifierModel ? 'review-model' : 'session-model',
      )
      const result = main.requests[1]?.messages
        .flatMap((m) => (m.role === 'user' ? m.content : []))
        .find((b) => b.type === 'tool_result')
      expect(result).toMatchObject({
        isError: true,
        content: expect.stringContaining('do not bypass'),
      })
      const serialized = JSON.stringify(r.classifierRequests)
      expect(serialized).toContain('Implement the requested feature')
      expect(serialized).toContain('Never publish secrets')
      expect(serialized).not.toContain('DESCRIPTION-POISON')
    },
  )
  it('inherits settings auto mode and checks both delegation and fresh child actions against the real user request', async () => {
    const f = await fixture()
    const childFile = join(f.cwd, 'child.txt')
    const main = new FakeModelAdapter([
      call('Agent', { prompt: 'DELEGATED-TEXT', description: 'worker' }),
      response('main done'),
    ])
    const child = new FakeModelAdapter([
      call('Bash', { command: 'echo unsafe-choice' }),
      call('Write', { file_path: childFile, content: 'child safe alternative' }),
      response('child done'),
    ])
    const r = router(main, child)
    const args = ['-p', 'USER-REQUEST: implement the feature']
    expect(
      await startHeadless({
        ...f,
        args,
        cli: parseCliOptions(args),
        modelFactory: () => r.model,
        io: { stdout() {}, stderr() {} },
      }),
    ).toBe(0)
    expect(await readFile(childFile, 'utf8')).toBe('child safe alternative')
    expect(r.classifierRequests).toHaveLength(3)
    const childRequest = r.classifierRequests[1]?.messages[0]?.content[0]
    if (childRequest?.type !== 'text') throw new Error('Missing classifier transcript')
    const transcript = JSON.parse(childRequest.text).transcript as Array<{
      type: string
      text?: string
    }>
    expect(transcript.filter((e) => e.type === 'user')).toEqual([
      { type: 'user', text: 'USER-REQUEST: implement the feature' },
    ])
  })
  it('uses original user messages after compaction and excludes the generated summary', async () => {
    const f = await fixture()
    const skill = join(f.cwd, '.dock/skills/test-skill')
    await mkdir(skill, { recursive: true })
    await writeFile(
      join(skill, 'SKILL.md'),
      '---\nname: test-skill\ndescription: test instructions\n---\nSKILL-POISON',
    )
    const source = join(f.cwd, 'source.txt')
    await writeFile(source, 'TOOL-RESULT-POISON')
    const main = new FakeModelAdapter([
      call('Skill', { name: 'test-skill' }),
      call('Read', { file_path: source }),
      response('SUMMARY-POISON'),
      call('Bash', { command: 'echo task' }),
      response('done'),
    ])
    const r = router(main)
    const args = ['-p', 'ORIGINAL-USER-REQUEST']
    expect(
      await startHeadless({
        ...f,
        environment: { ...f.environment, DOCK_EVAL_COMPACT_AFTER: '1' },
        args,
        cli: parseCliOptions(args),
        modelFactory: () => r.model,
        io: { stdout() {}, stderr() {} },
      }),
    ).toBe(0)
    expect(r.classifierRequests).toHaveLength(2)
    const serialized = JSON.stringify(r.classifierRequests)
    expect(serialized).toContain('ORIGINAL-USER-REQUEST')
    expect(serialized).not.toContain('SUMMARY-POISON')
    expect(serialized).not.toContain('TOOL-RESULT-POISON')
    expect(serialized).not.toContain('SKILL-POISON')
  })
  it('follows an interactive session model change when no classifier override is set', async () => {
    const f = await fixture()
    const main = new FakeModelAdapter([call('Bash', { command: 'echo task' }), response('done')])
    const r = router(main)
    const runtime = await createDockRuntime({ ...f, args: [], modelFactory: () => r.model })
    try {
      await runtime.sessionCommands.setModel('fake:changed-model')
      for await (const _ of runtime.controller.submit('test the feature')) {
        /* drain */
      }
      expect(r.classifierRequests[0]?.modelId).toBe('changed-model')
    } finally {
      await runtime.close()
    }
  })
  it('merges policy additions across settings scopes without losing the model selection', async () => {
    const f = await fixture('fake:judge')
    await mkdir(join(f.cwd, '.dock'))
    await writeFile(
      join(f.cwd, '.dock/settings.json'),
      JSON.stringify({
        permissions: {
          auto: {
            environment: 'More trusted infrastructure',
            blockRules: ['No production writes'],
            allowExceptions: ['Fixture cleanup'],
          },
        },
      }),
    )
    const settings = (await loadSettings(f)).settings.permissions
    expect(settings?.defaultMode).toBe('auto')
    expect(settings?.auto).toEqual({
      model: 'fake:judge',
      environment: 'Trusted test repository\nMore trusted infrastructure',
      blockRules: ['Never publish secrets', 'No production writes'],
      allowExceptions: ['Local test fixtures are disposable', 'Fixture cleanup'],
    })
  })
})
