import { describe, expect, it, vi } from 'vitest'
import { AnthropicMessagesAdapter } from '../../src/model/anthropic-messages-adapter.js'
import { OpenAIChatAdapter } from '../../src/model/openai-chat-adapter.js'
import { OpenAIResponsesAdapter } from '../../src/model/openai-responses-adapter.js'
import type { ModelAdapter, ModelRequest } from '../../src/model/types.js'

const request: ModelRequest = { modelId: 'test', messages: [], systemPrompt: [], tools: [] }
const adapters = [
  {
    field: 'max_tokens',
    make: (create: () => Promise<AsyncIterable<unknown>>) =>
      new AnthropicMessagesAdapter({ messages: { create } }),
  },
  {
    field: 'max_completion_tokens',
    make: (create: () => Promise<AsyncIterable<unknown>>) =>
      new OpenAIChatAdapter({ chat: { completions: { create } } }),
  },
  {
    field: 'max_output_tokens',
    make: (create: () => Promise<AsyncIterable<unknown>>) =>
      new OpenAIResponsesAdapter({ responses: { create } }),
  },
]
async function consume(model: ModelAdapter, maxOutputTokens?: number) {
  for await (const _ of model.stream(
    { ...request, ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) },
    { signal: new AbortController().signal },
  )) {
    /* consume */
  }
}

describe.each(adapters)('$field output limit', ({ field, make }) => {
  it.each([undefined, 8192, 64_000])(
    'uses 32000 by default and honors explicit %s',
    async (limit) => {
      const create = vi.fn(async () => (async function* () {})())
      await consume(make(create), limit)
      expect(create).toHaveBeenCalledOnce()
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ [field]: limit ?? 32_000 }),
        expect.anything(),
      )
    },
  )

  it('adds a settings hint to an oversized-token 400 without retrying or replacing the error', async () => {
    const error = Object.assign(new Error(`400 ${field} exceeds the model maximum`), {
      status: 400,
    })
    const create = vi.fn(async () => {
      throw error
    })
    await expect(consume(make(create))).rejects.toBe(error)
    expect(error.message).toContain('providers.<provider>.maxOutputTokens')
    expect(error.message).toContain('settings.json')
    expect(error.message).toContain(`400 ${field} exceeds the model maximum`)
    expect(create).toHaveBeenCalledOnce()
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ [field]: 32_000 }),
      expect.anything(),
    )
  })

  it('recognizes an oversized-token 400 whose parameter is in the SDK error field', async () => {
    const error = Object.assign(new Error('400 Must be less than or equal to 16384'), {
      status: 400,
      param: field,
    })
    const create = vi.fn(async () => {
      throw error
    })
    await expect(consume(make(create))).rejects.toBe(error)
    expect(error.message).toContain('maxOutputTokens')
    expect(create).toHaveBeenCalledOnce()
  })

  it.each([
    [400, 'Invalid model ID'],
    [401, 'Authentication failed'],
    [429, 'max_tokens exceeds the rate limit'],
    [400, 'max_tokens must be positive'],
  ])('preserves unrelated %s errors: %s', async (status, message) => {
    const error = Object.assign(new Error(String(message)), { status })
    const create = vi.fn(async () => {
      throw error
    })
    await expect(consume(make(create))).rejects.toBe(error)
    expect(error.message).toBe(message)
    expect(create).toHaveBeenCalledOnce()
  })
})
