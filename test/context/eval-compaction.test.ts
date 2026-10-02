import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  runAgentLoop,
  type AgentEvent,
  type AgentLoopResult,
} from '../../src/agent/run-agent-loop.js'
import { EvalCompaction, parseEvalCompactAfter } from '../../src/context/eval-compaction.js'
import { ContextManager } from '../../src/context/context-manager.js'
import { createUserMessage } from '../../src/messages/create-message.js'
import { FakeModelAdapter } from '../../src/model/fake-model.js'
import type { ModelStreamEvent } from '../../src/model/types.js'
import { createSessionId } from '../../src/sessions/ids.js'
import { loadSession, SessionWriter } from '../../src/sessions/session-store.js'
import { FileReadState } from '../../src/tools/file-read-state.js'
import type { AgentTool } from '../../src/tools/types.js'

function response(names: string[]): ModelStreamEvent[] {
  return [
    { type: 'message_start', messageId: 'response' },
    ...names.flatMap((name, index): ModelStreamEvent[] => [
      {
        type: 'content_block_start',
        index,
        block: { type: 'tool_use', id: `${name}-${index}`, name },
      },
      {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partialJson: '{}' },
      },
      { type: 'content_block_stop', index },
    ]),
    { type: 'message_delta', stopReason: names.length ? 'tool_use' : 'end_turn', usage: {} },
    { type: 'message_stop' },
  ]
}
const skillContext = { name: 'review', location: '/review/SKILL.md', contentHash: 'hash' }
const tools: AgentTool[] = ['Skill', 'Read', 'Failed'].map((name) => ({
  name,
  description: name,
  inputSchema: {},
  isConcurrencySafe: () => name !== 'Skill',
  execute: async () =>
    name === 'Skill'
      ? { content: 'Loaded', context: { skillContext, text: 'instructions' } }
      : { content: name, ...(name === 'Failed' ? { isError: true } : {}) },
}))
async function drain(loop: AsyncGenerator<AgentEvent, AgentLoopResult>, writer?: SessionWriter) {
  const events: AgentEvent[] = []
  let next = await loop.next()
  while (!next.done) {
    const event = next.value
    events.push(event)
    if (event.type === 'user_message' || event.type === 'assistant_message')
      await writer?.recordTranscript([event.message])
    if (event.type === 'compact') await writer?.recordCompaction(event.messages, event.compaction)
    next = await loop.next()
  }
  return { events, result: next.value }
}
function manager(fail = false) {
  const summarize = vi.fn(async () => {
    if (fail) throw new Error('summary failed')
    return {
      summaryMessages: [
        createUserMessage(
          { content: [{ type: 'text', text: 'summary' }] },
          { isCompactSummary: true },
        ),
      ],
      attachments: [],
      usage: {},
      trigger: 'auto' as const,
    }
  })
  return {
    summarize,
    contextManager: new ContextManager({
      contextWindow: 200_000,
      maxOutputTokens: 8192,
      summarize,
    }),
  }
}

describe('fixed eval compaction', () => {
  it.each(['0', '-1', '1.5', 'abc', '', '1e2', '9007199254740992'])(
    'rejects invalid K: %s',
    (value) => {
      expect(() => parseEvalCompactAfter(value)).toThrow('DOCK_EVAL_COMPACT_AFTER')
    },
  )
  it('is opt-in and accepts positive integer K', () => {
    expect(parseEvalCompactAfter(undefined)).toBeUndefined()
    expect(parseEvalCompactAfter('2')).toBe(2)
  })
  it('counts individual post-activation results in a batch, including errors, before the next request', async () => {
    const persist = vi.fn(async () => {})
    const evalCompaction = new EvalCompaction(2, [], persist)
    const { contextManager, summarize } = manager()
    const model = new FakeModelAdapter([
      response(['Read', 'Skill', 'Read', 'Failed']),
      response(['Read']),
      response([]),
    ])
    const { events } = await drain(
      runAgentLoop({
        model,
        modelId: 'test',
        systemPrompt: [],
        messages: [],
        tools,
        contextManager,
        evalCompaction,
      }),
    )
    expect(persist).toHaveBeenCalledOnce()
    expect(summarize).toHaveBeenCalledOnce()
    expect(model.requests[1]?.messages[0]?.content).toEqual([{ type: 'text', text: 'summary' }])
    const boundary = events.find((event) => event.type === 'compact')
    expect(boundary).toMatchObject({ compaction: { evalCompactAfter: 2 } })
    expect(events.filter((event) => event.type === 'tool_result')).toHaveLength(5)
  })
  it('restores an unfinished count from JSONL and never repeats after a restart', async () => {
    const location = {
      configDir: await mkdtemp(join(tmpdir(), 'dock-eval-')),
      cwd: '/work',
      sessionId: createSessionId(),
    }
    const writer = await SessionWriter.create(location)
    const first = new EvalCompaction(2, [], () => writer.recordEvalCompactionTrigger(2))
    const { contextManager, summarize } = manager()
    await drain(
      runAgentLoop({
        model: new FakeModelAdapter([response(['Skill', 'Read']), response([])]),
        modelId: 'test',
        systemPrompt: [],
        messages: [],
        tools,
        contextManager,
        evalCompaction: first,
      }),
      writer,
    )
    expect(summarize).not.toHaveBeenCalled()
    await writer.close()
    const loaded = await loadSession(location)
    const reopened = await SessionWriter.open(location)
    const resumed = new EvalCompaction(2, loaded.records, () =>
      reopened.recordEvalCompactionTrigger(2),
    )
    await drain(
      runAgentLoop({
        model: new FakeModelAdapter([response(['Read']), response([])]),
        modelId: 'test',
        systemPrompt: [],
        messages: loaded.messages,
        tools,
        contextManager,
        evalCompaction: resumed,
      }),
      reopened,
    )
    expect(summarize).toHaveBeenCalledOnce()
    await reopened.close()
    const final = await loadSession(location)
    expect(
      final.records.filter((record) => record.type === 'eval_compaction_trigger'),
    ).toHaveLength(1)
    expect(final.records.find((record) => record.type === 'compact_boundary')).toMatchObject({
      metadata: { evalCompactAfter: 2 },
    })
    const persist = vi.fn(async () => {})
    const again = new EvalCompaction(2, final.records, persist)
    again.observeResult(false)
    expect(await again.claim()).toBe(false)
    expect(persist).not.toHaveBeenCalled()
  })
  it('does not trigger without a successful activation or without the option', async () => {
    for (const enabled of [false, true]) {
      const { contextManager, summarize } = manager()
      const persist = vi.fn(async () => {})
      await drain(
        runAgentLoop({
          model: new FakeModelAdapter([
            response(enabled ? ['Read', 'Failed'] : ['Skill', 'Read']),
            response([]),
          ]),
          modelId: 'test',
          systemPrompt: [],
          messages: [],
          tools,
          contextManager,
          ...(enabled ? { evalCompaction: new EvalCompaction(1, [], persist) } : {}),
        }),
      )
      expect(summarize).not.toHaveBeenCalled()
      expect(persist).not.toHaveBeenCalled()
    }
  })
  it('ignores the eval option for subagents', async () => {
    const { contextManager, summarize } = manager()
    const persist = vi.fn(async () => {})
    await drain(
      runAgentLoop({
        model: new FakeModelAdapter([response(['Skill', 'Read']), response([])]),
        modelId: 'test',
        systemPrompt: [],
        messages: [],
        tools,
        contextManager,
        evalCompaction: new EvalCompaction(1, [], persist),
        getAgentIdentity: () => ({
          agentId: createSessionId(),
          sessionId: createSessionId(),
          depth: 1,
          contextMode: 'fresh',
          cwd: '/work',
          modelReference: 'test',
          fileReadState: new FileReadState(),
        }),
      }),
    )
    expect(summarize).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
  })
  it('attempts only once on summary failure, including subsequent turns', async () => {
    const persist = vi.fn(async () => {})
    const evalCompaction = new EvalCompaction(1, [], persist)
    const { contextManager, summarize } = manager(true)
    for (let turn = 0; turn < 2; turn++) {
      await drain(
        runAgentLoop({
          model: new FakeModelAdapter([response(['Read']), response([])]),
          modelId: 'test',
          systemPrompt: [],
          tools,
          contextManager,
          evalCompaction,
          messages: [
            createUserMessage(
              { content: [{ type: 'text', text: 'slash activation' }] },
              { skillContext },
            ),
          ],
        }),
      )
    }
    expect(summarize).toHaveBeenCalledOnce()
    expect(persist).toHaveBeenCalledOnce()
  })
})
