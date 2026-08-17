import { expect, it } from 'vitest'
import { runAgentLoop } from '../../src/agent/run-agent-loop.js'
import type { AgentTool } from '../../src/tools/types.js'
import type { ModelAdapter } from '../../src/model/types.js'
it.each(['success', 'error', 'denied', 'aborted'] as const)(
  'reports %s out of band without adding model fields',
  async (outcome) => {
    const abort = new AbortController()
    let calls = 0
    const model: ModelAdapter = {
      async *stream() {
        yield { type: 'message_start', messageId: 'm' + calls }
        if (calls++ === 0) {
          yield {
            type: 'content_block_start',
            index: 0,
            block: { type: 'tool_use', id: 't', name: 'Test' },
          }
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partialJson: '{}' },
          }
          yield { type: 'content_block_stop', index: 0 }
          yield { type: 'message_delta', stopReason: 'tool_use', usage: {} }
        } else {
          yield { type: 'message_delta', stopReason: 'end_turn', usage: {} }
        }
        yield { type: 'message_stop' }
      },
    }
    const tool: AgentTool = {
      name: 'Test',
      description: 'test',
      inputSchema: {},
      isConcurrencySafe: () => true,
      async execute() {
        if (outcome === 'aborted') abort.abort()
        return {
          content: 'localized message',
          isError: outcome === 'error' || outcome === 'aborted',
        }
      },
    }
    const events = []
    for await (const event of runAgentLoop({
      model,
      modelId: 'm',
      messages: [],
      systemPrompt: [],
      tools: [tool],
      signal: abort.signal,
      canUseTool: async () =>
        outcome === 'denied' ? { behavior: 'deny', message: '无权限' } : { behavior: 'allow' },
    }))
      events.push(event)
    const event = events.find((e) => e.type === 'tool_result')
    expect(event).toMatchObject({ outcome })
    if (event?.type === 'tool_result') expect(event.result).not.toHaveProperty('outcome')
  },
)
