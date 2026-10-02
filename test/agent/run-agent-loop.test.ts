import { describe, expect, it, vi } from 'vitest'
import {
  type AgentEvent,
  type AgentLoopResult,
  runAgentLoop,
} from '../../src/agent/run-agent-loop.js'
import { ContextManager } from '../../src/context/context-manager.js'
import { createAssistantMessage, createUserMessage } from '../../src/messages/create-message.js'
import { FakeModelAdapter } from '../../src/model/fake-model.js'
import type { ModelStreamEvent } from '../../src/model/types.js'
import type { AgentTool } from '../../src/tools/types.js'

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
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }] })],
        model,
        modelId: 'test-model',
        systemPrompt: ['You are Dock.'],
        tools: [],
      }),
    )

    expect(result.reason).toBe('completed')
    expect(result.messages.at(-1)).toMatchObject({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        id: 'assistant-1',
        stopReason: 'end_turn',
        usage: { outputTokens: 1 },
      },
    })
    expect(model.requests).toHaveLength(1)
  })

  it('passes the configured output token limit to the model', async () => {
    const model = new FakeModelAdapter([textResponse('done')])

    await drain(
      runAgentLoop({
        maxOutputTokens: 4096,
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }] })],
        model,
        modelId: 'test-model',
        systemPrompt: [],
        tools: [],
      }),
    )

    expect(model.requests[0]?.maxOutputTokens).toBe(4096)
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

    const { events, result } = await drain(
      runAgentLoop({
        messages: [createUserMessage({ content: [{ type: 'text', text: 'read it' }] })],
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
    expect(events.find((event) => event.type === 'user_message')).toMatchObject({
      message: {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', toolUseId: 'tool-1' }],
        },
      },
    })
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

  it('inserts protected Skill context after the matching tool result', async () => {
    const model = new FakeModelAdapter([
      [
        { type: 'message_start', messageId: 'assistant-skill' },
        {
          type: 'content_block_start',
          index: 0,
          block: { type: 'tool_use', id: 'skill-1', name: 'Skill' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partialJson: '{"name":"review"}' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', stopReason: 'tool_use', usage: {} },
        { type: 'message_stop' },
      ],
      textResponse('reviewing'),
    ])
    const skillContext = {
      contentHash: 'hash',
      location: '/skills/review/SKILL.md',
      name: 'review',
    }

    const { result } = await drain(
      runAgentLoop({
        messages: [createUserMessage({ content: [{ type: 'text', text: 'review it' }] })],
        model,
        modelId: 'test-model',
        systemPrompt: [],
        tools: [
          {
            description: 'Skill',
            execute: async () => ({
              content: 'Loaded Skill: review',
              context: { skillContext, text: '<skill_content>full file</skill_content>' },
            }),
            inputSchema: { type: 'object' },
            isConcurrencySafe: () => false,
            name: 'Skill',
          },
        ],
      }),
    )

    const inserted = result.messages.find(
      (message) => message.type === 'user' && message.skillContext?.name === 'review',
    )
    expect(inserted).toMatchObject({ isMeta: true, skillContext })
    expect(model.requests[1]?.messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '<skill_content>full file</skill_content>' }],
    })
  })

  it('feeds a denied tool result back without executing the tool', async () => {
    const model = new FakeModelAdapter([
      [
        { type: 'message_start', messageId: 'assistant-denied-tool' },
        {
          type: 'content_block_start',
          index: 0,
          block: { type: 'tool_use', id: 'tool-denied', name: 'Write' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partialJson: '{"file_path":"/tmp/a"}' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', stopReason: 'tool_use', usage: {} },
        { type: 'message_stop' },
      ],
      textResponse('understood'),
    ])
    let executions = 0

    await drain(
      runAgentLoop({
        canUseTool: async () => ({ behavior: 'deny', message: 'Permission denied' }),
        messages: [createUserMessage({ content: [{ type: 'text', text: 'write' }] })],
        model,
        modelId: 'test-model',
        systemPrompt: [],
        tools: [
          {
            description: 'Write a file',
            execute: async () => {
              executions += 1
              return { content: 'unexpected' }
            },
            inputSchema: { type: 'object' },
            isConcurrencySafe: () => false,
            name: 'Write',
          },
        ],
      }),
    )

    expect(executions).toBe(0)
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({
      role: 'user',
      content: [
        {
          content: 'Permission denied',
          isError: true,
          toolUseId: 'tool-denied',
          type: 'tool_result',
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
        messages: [createUserMessage({ content: [{ type: 'text', text: 'read both' }] })],
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
        messages: [createUserMessage({ content: [{ type: 'text', text: 'read' }] })],
        model,
        modelId: 'test-model',
        systemPrompt: [],
        tools: [],
      }),
    )

    expect(result.reason).toBe('model_error')
    expect(result.error).toContain('Invalid JSON input for tool Read')
  })

  it('returns invalid tool input before permissions or execution', async () => {
    const model = new FakeModelAdapter([
      [
        { type: 'message_start', messageId: 'assistant-invalid-input' },
        {
          type: 'content_block_start',
          index: 0,
          block: { type: 'tool_use', id: 'tool-invalid', name: 'Write' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partialJson: '{"file_path":42}' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', stopReason: 'tool_use', usage: {} },
        { type: 'message_stop' },
      ],
      textResponse('understood'),
    ])
    const checkPermissions = vi.fn()
    const execute = vi.fn(async () => ({ content: 'unexpected' }))
    const canUseTool = vi.fn(async () => ({ behavior: 'allow' as const }))
    const write: AgentTool = {
      checkPermissions,
      description: 'Write',
      execute,
      inputSchema: { type: 'object' },
      isConcurrencySafe: () => false,
      name: 'Write',
      parseInput: () => {
        throw new Error('file_path must be a string')
      },
    }

    await drain(
      runAgentLoop({
        canUseTool,
        messages: [createUserMessage({ content: [{ type: 'text', text: 'write' }] })],
        model,
        modelId: 'test-model',
        systemPrompt: [],
        tools: [write],
      }),
    )

    expect(checkPermissions).not.toHaveBeenCalled()
    expect(canUseTool).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({
      content: [
        {
          content: 'Invalid input for Write: file_path must be a string',
          isError: true,
          toolUseId: 'tool-invalid',
          type: 'tool_result',
        },
      ],
      role: 'user',
    })
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
        messages: [createUserMessage({ content: [{ type: 'text', text: 'read' }] })],
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
    expect(result.messages.at(-1)).toMatchObject({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            toolUseId: 'tool-1',
            isError: true,
          },
        ],
      },
    })
  })

  it('does not call the model when already aborted', async () => {
    const model = new FakeModelAdapter([])
    const controller = new AbortController()
    controller.abort('user')

    const { result } = await drain(
      runAgentLoop({
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }] })],
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

  it('pairs a tool use with an error result when interrupted before execution', async () => {
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
    const controller = new AbortController()
    let executions = 0
    const generator = runAgentLoop({
      messages: [createUserMessage({ content: [{ type: 'text', text: 'read' }] })],
      model,
      modelId: 'test-model',
      signal: controller.signal,
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
    })

    const events: AgentEvent[] = []
    let next = await generator.next()
    while (!next.done) {
      events.push(next.value)
      if (next.value.type === 'tool_execution_start') controller.abort('user')
      next = await generator.next()
    }

    expect(executions).toBe(0)
    expect(events.find((event) => event.type === 'user_message')).toMatchObject({
      message: {
        message: {
          content: [
            {
              content: 'Tool execution aborted',
              isError: true,
              toolUseId: 'tool-1',
              type: 'tool_result',
            },
          ],
        },
      },
    })
    expect(next.value).toMatchObject({ reason: 'aborted' })
  })

  it('prepares compacted history before a model request', async () => {
    const model = new FakeModelAdapter([textResponse('done')])
    const contextManager = new ContextManager({
      contextWindow: 100_000,
      maxOutputTokens: 8_000,
      summarize: async () => ({
        summaryMessages: [
          createUserMessage(
            { content: [{ type: 'text', text: 'compact summary' }] },
            { isCompactSummary: true },
          ),
        ],
        attachments: [],
        usage: {},
        trigger: 'auto',
      }),
    })

    await drain(
      runAgentLoop({
        contextManager,
        messages: [
          createUserMessage({ content: [{ type: 'text', text: 'old' }] }),
          createAssistantMessage({
            content: [{ type: 'text', text: 'large'.repeat(70_000) }],
            id: 'provider-large',
            role: 'assistant',
            stopReason: 'end_turn',
            usage: { inputTokens: 80_000, outputTokens: 1_000 },
          }),
          createUserMessage({ content: [{ type: 'text', text: 'recent' }] }),
        ],
        model,
        modelId: 'test-model',
        systemPrompt: [],
        tools: [],
      }),
    )

    expect(model.requests[0]?.messages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'compact summary' }],
    })
  })

  it('prepends project instructions as ephemeral user context', async () => {
    const model = new FakeModelAdapter([textResponse('done')])

    const { result } = await drain(
      runAgentLoop({
        messages: [createUserMessage({ content: [{ type: 'text', text: 'work' }] })],
        model,
        modelId: 'test-model',
        systemPrompt: [],
        tools: [],
        userContext: { AGENTS: 'Always run tests.' },
      }),
    )

    expect(model.requests[0]?.messages[0]).toMatchObject({
      role: 'user',
      content: [
        {
          type: 'text',
          text: expect.stringContaining('Always run tests.'),
        },
      ],
    })
    expect(result.messages).toHaveLength(2)
  })
})

it('closes the provider stream when the loop consumer stops early', async () => {
  let closed = false
  const model = {
    async *stream() {
      try {
        yield { type: 'message_start' as const, messageId: 'partial' }
      } finally {
        closed = true
      }
    },
  }
  const loop = runAgentLoop({ model, modelId: 'test', messages: [], systemPrompt: [], tools: [] })
  await loop.next()
  await loop.return({ reason: 'aborted', messages: [] })
  expect(closed).toBe(true)
})
