import { describe, expect, it, vi } from 'vitest'
import { createAgentTools } from '../../src/agents/tools.js'
import { createUserMessage } from '../../src/messages/create-message.js'
import { createSessionId } from '../../src/sessions/ids.js'
import { runAgentLoop } from '../../src/agent/run-agent-loop.js'
import { FakeModelAdapter } from '../../src/model/fake-model.js'
import type { SubagentManager } from '../../src/agents/manager.js'
import type { AgentSnapshot } from '../../src/agents/types.js'

describe('Agent tools through the shared loop', () => {
  it('passes the current structured batch to Agent and parses before spawning', async () => {
    const spawn = vi.fn(async (_parent: AgentSnapshot) => ({
      id: 'child',
      status: 'running',
      outputFile: '/child.jsonl',
    }))
    const tools = createAgentTools({ spawn } as unknown as SubagentManager)
    const model = new FakeModelAdapter([
      [
        { type: 'message_start', messageId: 'm' },
        {
          type: 'content_block_start',
          index: 0,
          block: { type: 'tool_use', id: 'call', name: 'Agent' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partialJson: JSON.stringify({ prompt: 'work', description: 'Work', context: 'fork' }),
          },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', stopReason: 'tool_use', usage: {} },
        { type: 'message_stop' },
      ],
      [
        { type: 'message_start', messageId: 'done' },
        { type: 'content_block_start', index: 0, block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', stopReason: 'end_turn', usage: {} },
        { type: 'message_stop' },
      ],
    ])
    const identity = {
      sessionId: createSessionId(),
      cwd: '/repo',
      depth: 0,
      contextMode: 'main' as const,
      modelReference: 'test:model',
    }
    const loop = runAgentLoop({
      model,
      modelId: 'model',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'user request' }] })],
      systemPrompt: ['sys'],
      tools,
      getAgentIdentity: () => identity,
    })
    for await (const _ of loop) {
      /* consume */
    }
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      sessionId: identity.sessionId,
      systemPrompt: ['sys'],
    })
    expect(JSON.stringify(spawn.mock.calls[0]?.[0])).toContain('"id":"call"')
    const agent = tools.find((tool) => tool.name === 'Agent')
    expect(() =>
      agent?.parseInput?.({ prompt: 'x', description: 'x', context: 'fork', model: 'other:model' }),
    ).toThrow()
  })
})
