import { describe, expect, it } from 'vitest'
import { AnthropicMessagesAdapter } from '../../src/model/anthropic-messages-adapter.js'
import { createModelAdapter } from '../../src/model/create-model-adapter.js'
import { OpenAIResponsesAdapter } from '../../src/model/openai-responses-adapter.js'

describe('createModelAdapter', () => {
  it('creates adapters from provider settings without making a request', () => {
    expect(
      createModelAdapter(
        { apiKeyEnv: 'TEST_KEY', protocol: 'anthropic-messages' },
        { TEST_KEY: 'secret' },
      ),
    ).toBeInstanceOf(AnthropicMessagesAdapter)
    expect(
      createModelAdapter(
        { apiKeyEnv: 'TEST_KEY', protocol: 'openai-responses' },
        { TEST_KEY: 'secret' },
      ),
    ).toBeInstanceOf(OpenAIResponsesAdapter)
  })

  it('fails clearly when the configured API key environment variable is absent', () => {
    expect(() =>
      createModelAdapter({ apiKeyEnv: 'MISSING_KEY', protocol: 'anthropic-messages' }, {}),
    ).toThrow('MISSING_KEY')
  })
})
