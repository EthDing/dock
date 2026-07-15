import { describe, expect, it } from 'vitest'
import {
  runAgentLoop,
  type AgentEvent,
  type AgentLoopResult,
} from '../../src/agent/run-agent-loop.js'
import { FakeModelAdapter } from '../../src/model/fake-model.js'
import type { ModelStreamEvent } from '../../src/model/types.js'

async function drain(
  generator: AsyncGenerator<AgentEvent, AgentLoopResult>,
): Promise<{ events: AgentEvent[]; result: AgentLoopResult }> {
  const events: AgentEvent[] = []
  let next = await generator.next()
  while (!next.done) {
    events.push(next.value)
    next = await generator.next()
  }
  return { events, result: next.value }
}

const textResponse = (text: string): readonly ModelStreamEvent[] => [
  { type: 'message_start', messageId: 'assistant-1' },
  { type: 'content_block_start', index: 0, block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', stopReason: 'end_turn', usage: { outputTokens: 1 } },
  { type: 'message_stop' },
]

describe('runAgentLoop', () => {
  it('stops when the model returns text without a tool call', async () => {
    const model = new FakeModelAdapter([textResponse('done')])

    const { result } = await drain(
      runAgentLoop({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        model,
        modelId: 'test-model',
        systemPrompt: ['You are Dock.'],
        tools: [],
      }),
    )

    expect(result.reason).toBe('completed')
    expect(result.messages.at(-1)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      id: 'assistant-1',
      stopReason: 'end_turn',
      usage: { outputTokens: 1 },
    })
    expect(model.requests).toHaveLength(1)
  })

  it('executes a tool and feeds its result into the next model turn', async () => {
    const model = new FakeModelAdapter([
      [
        { type: 'message_start', messageId: 'assistant-tool' },
        {
          type: 'content_block_start',
          index: 0,
          block: { type: 'tool_use', id: 'tool-1', name: 'Read' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partialJson: '{"path":"README.md"}' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', stopReason: 'tool_use', usage: { outputTokens: 2 } },
        { type: 'message_stop' },
      ],
      textResponse('read complete'),
    ])

    const { result } = await drain(
      runAgentLoop({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'read it' }] }],
        model,
        modelId: 'test-model',
        systemPrompt: [],
        tools: [
          {
            description: 'Read a file',
            execute: async (input) => ({ content: JSON.stringify(input) }),
            inputSchema: { type: 'object' },
            isConcurrencySafe: () => true,
            name: 'Read',
          },
        ],
      }),
    )

    expect(result.reason).toBe('completed')
    expect(model.requests).toHaveLength(2)
    expect(model.requests[1]?.messages.at(-1)).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          toolUseId: 'tool-1',
          content: '{"path":"README.md"}',
        },
      ],
    })
  })

  it('runs consecutive concurrency-safe tools in parallel', async () => {
    const model = new FakeModelAdapter([
      [
        { type: 'message_start', messageId: 'assistant-tools' },
        {
          type: 'content_block_start',
          index: 0,
          block: { type: 'tool_use', id: 'tool-1', name: 'Read' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partialJson: '{"path":"a"}' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          block: { type: 'tool_use', id: 'tool-2', name: 'Read' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partialJson: '{"path":"b"}' },
        },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', stopReason: 'tool_use', usage: { outputTokens: 2 } },
        { type: 'message_stop' },
      ],
      textResponse('done'),
    ])
    let active = 0
    let maximumActive = 0

    await drain(
      runAgentLoop({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'read both' }] }],
        model,
        modelId: 'test-model',
        systemPrompt: [],
        tools: [
          {
            description: 'Read a file',
            execute: async (input) => {
              active += 1
              maximumActive = Math.max(maximumActive, active)
              await new Promise((resolve) => setTimeout(resolve, 5))
              active -= 1
              return { content: String(input.path) }
            },
            inputSchema: { type: 'object' },
            isConcurrencySafe: () => true,
            name: 'Read',
          },
        ],
      }),
    )

    expect(maximumActive).toBe(2)
  })

  it('returns a model error when streamed tool input is invalid JSON', async () => {
    const model = new FakeModelAdapter([
      [
        { type: 'message_start', messageId: 'assistant-invalid-tool' },
        {
          type: 'content_block_start',
          index: 0,
          block: { type: 'tool_use', id: 'tool-1', name: 'Read' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partialJson: '{invalid' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', stopReason: 'tool_use', usage: {} },
        { type: 'message_stop' },
      ],
    ])

    const { result } = await drain(
      runAgentLoop({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'read' }] }],
        model,
        modelId: 'test-model',
        systemPrompt: [],
        tools: [],
      }),
    )

    expect(result.reason).toBe('model_error')
    expect(result.error).toContain('Invalid JSON input for tool Read')
  })

  it('stops before tool execution when the tool-turn limit is exhausted', async () => {
    const model = new FakeModelAdapter([
      [
        { type: 'message_start', messageId: 'assistant-tool' },
        {
          type: 'content_block_start',
          index: 0,
          block: { type: 'tool_use', id: 'tool-1', name: 'Read' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', stopReason: 'tool_use', usage: {} },
        { type: 'message_stop' },
      ],
    ])
    let executions = 0

    const { result } = await drain(
      runAgentLoop({
        maxTurns: 0,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'read' }] }],
        model,
        modelId: 'test-model',
        systemPrompt: [],
        tools: [
          {
            description: 'Read a file',
            execute: async () => {
              executions += 1
              return { content: 'unexpected' }
            },
            inputSchema: { type: 'object' },
            isConcurrencySafe: () => true,
            name: 'Read',
          },
        ],
      }),
    )

    expect(result.reason).toBe('max_turns')
    expect(executions).toBe(0)
  })

  it('does not call the model when already aborted', async () => {
    const model = new FakeModelAdapter([])
    const controller = new AbortController()
    controller.abort('user')

    const { result } = await drain(
      runAgentLoop({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        model,
        modelId: 'test-model',
        signal: controller.signal,
        systemPrompt: [],
        tools: [],
      }),
    )

    expect(result.reason).toBe('aborted')
    expect(model.requests).toHaveLength(0)
  })
})
