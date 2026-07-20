import { describe, expect, it, vi } from 'vitest'
import { ContextManager, getAutoCompactThreshold } from '../../src/context/context-manager.js'
import { createAssistantMessage, createUserMessage } from '../../src/messages/create-message.js'

describe('ContextManager', () => {
  it('uses the Claude Code auto-compact threshold formula', () => {
    expect(getAutoCompactThreshold(200_000, 32_000)).toBe(167_000)
    expect(getAutoCompactThreshold(200_000, 8_192)).toBe(178_808)
  })

  it('compacts old history while preserving recent messages', async () => {
    const summarize = vi.fn(async () => 'summary of earlier work')
    const manager = new ContextManager({
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      preserveRecentMessages: 2,
      summarize,
    })
    const messages = [
      createUserMessage({ content: [{ type: 'text', text: 'old request' }] }),
      createAssistantMessage({
        content: [{ type: 'text', text: 'old answer' }],
        id: 'provider-1',
        role: 'assistant',
        stopReason: 'end_turn',
        usage: { inputTokens: 179_000, outputTokens: 1_000 },
      }),
      createUserMessage({ content: [{ type: 'text', text: 'recent request' }] }),
      createAssistantMessage({
        content: [{ type: 'text', text: 'recent answer' }],
        id: 'provider-2',
        role: 'assistant',
        stopReason: 'end_turn',
        usage: { inputTokens: 179_000, outputTokens: 1_000 },
      }),
    ]

    const result = await manager.prepare(messages)

    expect(result.compacted).toBe(true)
    expect(result.messages).toHaveLength(3)
    expect(result.messages[0]).toMatchObject({
      type: 'user',
      isCompactSummary: true,
      message: { content: [{ type: 'text', text: 'summary of earlier work' }] },
    })
    expect(result.messages.slice(1)).toEqual(messages.slice(-2))
    expect(summarize).toHaveBeenCalledOnce()
  })
})
