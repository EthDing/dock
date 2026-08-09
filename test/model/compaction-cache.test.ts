import { describe, expect, it } from 'vitest'
import { AnthropicMessagesAdapter } from '../../src/model/anthropic-messages-adapter.js'
import type { ModelRequest } from '../../src/model/types.js'

describe('Anthropic cache prefix and normalized usage', () => {
  it('keeps parent breakpoints and does not mark the appended compact prompt', async () => {
    type Body = {
      messages: Array<{ content: Array<{ cache_control?: unknown }> }>
      system: unknown
    }
    const bodies: Body[] = []
    const adapter = new AnthropicMessagesAdapter({
      messages: {
        create: async (body) => {
          bodies.push(body as Body)
          return (async function* () {
            yield {
              type: 'message_start',
              message: {
                id: 'a',
                usage: {
                  input_tokens: 10,
                  cache_read_input_tokens: 100,
                  cache_creation_input_tokens: 20,
                },
              },
            }
          })()
        },
      },
    })
    const request: ModelRequest = {
      modelId: 'test',
      systemPrompt: ['system'],
      tools: [{ name: 'Read', description: 'Read', inputSchema: {} }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'parent' }] }],
    }
    const events = []
    for await (const e of adapter.stream(request, { signal: new AbortController().signal }))
      events.push(e)
    for await (const _ of adapter.stream(
      {
        ...request,
        messages: [
          ...request.messages,
          { role: 'user', content: [{ type: 'text', text: 'compact now' }] },
        ],
        cachePrefixMessageCount: 1,
      },
      { signal: new AbortController().signal },
    )) {
      /* consume */
    }
    expect(bodies[0]?.messages[0]?.content[0]?.cache_control).toEqual({ type: 'ephemeral' })
    expect(bodies[1]?.messages[0]).toEqual(bodies[0]?.messages[0])
    expect(bodies[1]?.messages[1]?.content[0]?.cache_control).toBeUndefined()
    expect(bodies[1]?.system).toEqual(bodies[0]?.system)
    expect(events[0]).toMatchObject({
      usage: { inputTokens: 130, cacheReadInputTokens: 100, cacheCreationInputTokens: 20 },
    })
    expect(request.messages[0]?.content[0]).not.toHaveProperty('cache_control')
  })
})
