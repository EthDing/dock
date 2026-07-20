import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { ProviderProtocol, ProviderSettings } from '../config/load-settings.js'
import { AnthropicMessagesAdapter } from './anthropic-messages-adapter.js'
import type { ModelAdapter } from './types.js'
import { OpenAIChatAdapter } from './openai-chat-adapter.js'
import { OpenAIResponsesAdapter } from './openai-responses-adapter.js'

export function createModelAdapter(
  settings: ProviderSettings & { protocol: ProviderProtocol },
  environment: Record<string, string | undefined> = process.env,
): ModelAdapter {
  const keyName = settings.apiKeyEnv ?? defaultApiKeyEnvironment(settings.protocol)
  const apiKey = environment[keyName]
  if (!apiKey) throw new Error(`Missing API key environment variable ${keyName}`)

  if (settings.protocol === 'anthropic-messages') {
    const client = new Anthropic({
      apiKey,
      ...(settings.baseUrl ? { baseURL: settings.baseUrl } : {}),
    })
    return new AnthropicMessagesAdapter(client as never)
  }

  const client = new OpenAI({
    apiKey,
    ...(settings.baseUrl ? { baseURL: settings.baseUrl } : {}),
  })
  return settings.protocol === 'openai-responses'
    ? new OpenAIResponsesAdapter(client as never)
    : new OpenAIChatAdapter(client as never)
}

function defaultApiKeyEnvironment(protocol: ProviderProtocol): string {
  return protocol === 'anthropic-messages' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'
}
