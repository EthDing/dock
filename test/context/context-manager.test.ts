import { describe, expect, it, vi } from 'vitest'
import { buildModelRequest, roughRequestTokens } from '../../src/agent/request.js'
import type { CompactionRequest } from '../../src/context/compaction.js'
import {
  ContextManager,
  estimateContextTokens,
  getAutoCompactThreshold,
} from '../../src/context/context-manager.js'
import { createAssistantMessage, createUserMessage } from '../../src/messages/create-message.js'

const context = {
  modelId: 'model',
  systemPrompt: ['system'],
  userContext: { AGENTS: 'rules' },
  tools: [],
}
const messages = [createUserMessage({ content: [{ type: 'text', text: 'original' }] })]
const request = buildModelRequest(messages, context)
const summaryMessages = [
  createUserMessage({ content: [{ type: 'text', text: 'summary' }] }, { isCompactSummary: true }),
]
describe('ContextManager', () => {
  it('uses the existing Claude auto-compact threshold formula', () => {
    expect(getAutoCompactThreshold(200_000, 32_000)).toBe(167_000)
    expect(getAutoCompactThreshold(200_000, 8_192)).toBe(178_808)
  })
  it('passes the structured history and commits restoration only on acceptance', async () => {
    const commit = vi.fn()
    const summarize = vi.fn(async (_request: CompactionRequest) => ({
      summaryMessages,
      attachments: [],
      usage: {},
      trigger: 'manual' as const,
    }))
    const manager = new ContextManager({
      contextWindow: 200_000,
      maxOutputTokens: 8192,
      summarize,
      prepareRestoration: async () => ({
        attachments: [],
        userContext: { AGENTS: 'new rules' },
        commit,
      }),
    })
    const result = await manager.compact(messages, request, new AbortController().signal, 'manual')
    expect(summarize.mock.calls[0]?.[0]).toMatchObject({ messages, request })
    expect(result.summaryMessages).toEqual(summaryMessages)
    expect(result.userContext).toEqual({ AGENTS: 'new rules' })
    expect(commit).not.toHaveBeenCalled()
    result.commit()
    expect(commit).toHaveBeenCalledOnce()
    expect(messages[0]?.message.content[0]).toMatchObject({ text: 'original' })
  })
  it('stops auto attempts after three failures, but manual retry can reset them', async () => {
    let fail = true
    const summarize = vi.fn(async () => {
      if (fail) throw new Error('offline')
      return { summaryMessages, attachments: [], usage: {}, trigger: 'manual' as const }
    })
    const manager = new ContextManager({ contextWindow: 1, maxOutputTokens: 1, summarize })
    for (let i = 0; i < 3; i++)
      await expect(
        manager.compact(messages, request, new AbortController().signal, 'auto'),
      ).rejects.toThrow('offline')
    expect(manager.shouldAutoCompact(messages, context)).toBe(false)
    fail = false
    const success = await manager.compact(messages, request, new AbortController().signal, 'manual')
    success.commit()
    expect(manager.shouldAutoCompact(messages, context)).toBe(true)
  })
  it('uses normalized input usage plus the change since that request, including cleared outputs', () => {
    const before = [createUserMessage({ content: [{ type: 'text', text: 'x'.repeat(4000) }] })]
    const baseline = roughRequestTokens(buildModelRequest(before, context))
    const assistant = {
      ...createAssistantMessage({
        id: 'a',
        role: 'assistant',
        stopReason: 'end_turn',
        usage: { inputTokens: 3000 },
        content: [{ type: 'text', text: 'answer' }],
      }),
      requestTokenEstimate: baseline,
    }
    const full = [...before, assistant]
    const cleared = [
      {
        ...createUserMessage({ content: [] }),
        message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'cleared' }] },
      },
      assistant,
    ]
    expect(
      estimateContextTokens(full, context.systemPrompt, context.tools, context.userContext),
    ).toBeGreaterThan(3000)
    expect(
      estimateContextTokens(cleared, context.systemPrompt, context.tools, context.userContext),
    ).toBeLessThan(2300)
  })
})
