import type { TranscriptMessage } from '../messages/create-message.js'
import { createUserMessage } from '../messages/create-message.js'
import type { ModelToolDefinition } from '../model/types.js'

const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000
const AUTOCOMPACT_BUFFER_TOKENS = 13_000

export type ContextAnalysis = {
  estimatedTokens: number
  threshold: number
  shouldCompact: boolean
}

export type ContextPreparation = {
  analysis: ContextAnalysis
  compacted: boolean
  messages: readonly TranscriptMessage[]
}

export class ContextManager {
  readonly #contextWindow: number
  readonly #maxOutputTokens: number
  readonly #preserveRecentMessages: number
  readonly #summarize: (input: { instructions?: string; transcript: string }) => Promise<string>

  constructor(options: {
    contextWindow: number
    maxOutputTokens: number
    preserveRecentMessages?: number
    summarize: (input: { instructions?: string; transcript: string }) => Promise<string>
  }) {
    this.#contextWindow = options.contextWindow
    this.#maxOutputTokens = options.maxOutputTokens
    this.#preserveRecentMessages = options.preserveRecentMessages ?? 4
    this.#summarize = options.summarize
  }

  analyze(
    messages: readonly TranscriptMessage[],
    systemPrompt: readonly string[] = [],
    tools: readonly ModelToolDefinition[] = [],
  ): ContextAnalysis {
    const estimatedTokens = estimateContextTokens(messages, systemPrompt, tools)
    const threshold = getAutoCompactThreshold(this.#contextWindow, this.#maxOutputTokens)
    return { estimatedTokens, shouldCompact: estimatedTokens >= threshold, threshold }
  }

  async prepare(
    messages: readonly TranscriptMessage[],
    options: { systemPrompt?: readonly string[]; tools?: readonly ModelToolDefinition[] } = {},
  ): Promise<ContextPreparation> {
    const pruned = clearOldToolResults(messages)
    const analysis = this.analyze(pruned, options.systemPrompt, options.tools)
    if (!analysis.shouldCompact || pruned.length <= this.#preserveRecentMessages) {
      return { analysis, compacted: false, messages: pruned }
    }
    const compacted = await this.compact(pruned)
    return { analysis, compacted: true, messages: compacted }
  }

  async compact(
    messages: readonly TranscriptMessage[],
    instructions?: string,
  ): Promise<readonly TranscriptMessage[]> {
    const splitAt = Math.max(1, messages.length - this.#preserveRecentMessages)
    const summarized = messages.slice(0, splitAt)
    const preserved = messages.slice(splitAt)
    const summary = await this.#summarize({
      ...(instructions ? { instructions } : {}),
      transcript: renderTranscript(summarized),
    })
    return [
      createUserMessage({ content: [{ text: summary, type: 'text' }] }, { isCompactSummary: true }),
      ...preserved,
    ]
  }
}

export function getAutoCompactThreshold(contextWindow: number, maxOutputTokens: number): number {
  const reserved = Math.min(maxOutputTokens, MAX_OUTPUT_TOKENS_FOR_SUMMARY)
  return Math.max(1, contextWindow - reserved - AUTOCOMPACT_BUFFER_TOKENS)
}

export function estimateContextTokens(
  messages: readonly TranscriptMessage[],
  systemPrompt: readonly string[] = [],
  tools: readonly ModelToolDefinition[] = [],
): number {
  const latestUsage = [...messages].reverse().find((message) => message.type === 'assistant')
    ?.message.usage
  if (latestUsage?.inputTokens !== undefined) {
    return latestUsage.inputTokens + (latestUsage.outputTokens ?? 0)
  }
  const serialized = JSON.stringify({
    messages: messages.map((message) => message.message),
    systemPrompt,
    tools,
  })
  return Math.ceil(serialized.length / 4)
}

function clearOldToolResults(messages: readonly TranscriptMessage[]): TranscriptMessage[] {
  let remaining = 3
  return [...messages]
    .reverse()
    .map((message) => {
      if (message.type !== 'user') return message
      const content = [...message.message.content].reverse().map((block) => {
        if (block.type !== 'tool_result') return block
        if (remaining > 0) {
          remaining -= 1
          return block
        }
        return { ...block, content: '[Old tool result content cleared]' }
      })
      return {
        ...message,
        message: { ...message.message, content: content.reverse() },
      }
    })
    .reverse()
}

function renderTranscript(messages: readonly TranscriptMessage[]): string {
  return messages
    .map((entry) => {
      const content = entry.message.content
        .map((block) => {
          if (block.type === 'text') return block.text
          if (block.type === 'thinking') return `[thinking]\n${block.thinking}`
          if (block.type === 'tool_use') {
            return `[tool_use ${block.name}]\n${JSON.stringify(block.input)}`
          }
          return `[tool_result ${block.toolUseId}]\n${block.content}`
        })
        .join('\n')
      return `${entry.type.toUpperCase()}:\n${content}`
    })
    .join('\n\n')
}
