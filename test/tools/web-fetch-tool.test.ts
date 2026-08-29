import { describe, expect, it, vi } from 'vitest'
import type { ModelAdapter } from '../../src/model/types.js'
import { createWebFetchTool, isPublicAddress } from '../../src/tools/web-fetch-tool.js'

const model: ModelAdapter = {
  async *stream() {
    yield { type: 'message_start', messageId: 'web' }
    yield { type: 'content_block_start', index: 0, block: { type: 'text' } }
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } }
    yield { type: 'content_block_stop', index: 0 }
    yield { type: 'message_delta', stopReason: 'end_turn', usage: {} }
    yield { type: 'message_stop' }
  },
}

describe('WebFetch', () => {
  it('asks by default, supports domain allow, and runs one tool-less model request', async () => {
    const fetchText = vi.fn(async () => ({ url: 'https://example.com/', text: 'source' }))
    const tool = createWebFetchTool({ model, modelId: 'test', fetchText })
    const input = { url: 'https://example.com', prompt: 'Summarize' }
    expect(tool.checkPermissions?.(input, { mode: 'default', rules: {} })).toMatchObject({
      behavior: 'passthrough',
    })
    expect(
      tool.checkPermissions?.(input, {
        mode: 'default',
        rules: { allow: ['WebFetch(domain:example.com)'] },
      }),
    ).toMatchObject({ behavior: 'allow' })
    const result = await tool.execute(input, {
      parentMessageUuid: crypto.randomUUID(),
      signal: new AbortController().signal,
      toolUseId: 'web',
    })
    expect(result.content).toBe('answer')
    expect(fetchText).toHaveBeenCalledOnce()
  })
  it('classifies private and public addresses', () => {
    expect(isPublicAddress('127.0.0.1')).toBe(false)
    expect(isPublicAddress('10.0.0.1')).toBe(false)
    expect(isPublicAddress('169.254.169.254')).toBe(false)
    expect(isPublicAddress('100.64.0.1')).toBe(false)
    expect(isPublicAddress('::1')).toBe(false)
    expect(isPublicAddress('::ffff:172.16.0.1')).toBe(false)
    expect(isPublicAddress('8.8.8.8')).toBe(true)
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true)
  })
})
