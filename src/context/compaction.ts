import {
  createUserMessage,
  type TranscriptMessage,
  type UserTranscriptMessage,
} from '../messages/create-message.js'
import { collectAssistantResponse } from '../model/stream-response.js'
import { DEFAULT_MAX_OUTPUT_TOKENS } from '../model/output-tokens.js'
import type { AssistantMessage, ModelAdapter, ModelRequest, Usage } from '../model/types.js'
import type { SkillRestorationMetadata } from '../skills/context.js'
import {
  formatCompactSummary,
  getCompactPrompt,
  getCompactUserSummaryMessage,
} from './compact-prompt.js'

export type CompactionRequest = {
  messages: readonly TranscriptMessage[]
  request: ModelRequest
  signal: AbortSignal
  trigger: 'auto' | 'manual'
  instructions?: string
  transcriptPath?: string
}
export type CompactionResult = {
  skillRestoration?: SkillRestorationMetadata
  evalCompactAfter?: number
  summaryMessages: readonly UserTranscriptMessage[]
  attachments: readonly UserTranscriptMessage[]
  usage: Usage
  trigger: 'auto' | 'manual'
  preTokens?: number
  postTokens?: number
}
export function buildPostCompactMessages(result: CompactionResult): readonly TranscriptMessage[] {
  return [...result.summaryMessages, ...result.attachments]
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}
function validSummary(text: string): boolean {
  return (
    Boolean(formatCompactSummary(text).trim()) &&
    !/^(API Error:|Error:|Request was aborted\.?)/i.test(text.trim()) &&
    !isContextOverflow(text)
  )
}
export function isContextOverflow(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  return /prompt.{0,10}too long|context_length_exceeded|maximum context length|context (?:window|length).{0,25}exceed|input.{0,10}too long/i.test(
    text,
  )
}
function addUsage(total: Usage, usage: Usage): void {
  for (const key of [
    'inputTokens',
    'outputTokens',
    'cacheReadInputTokens',
    'cacheCreationInputTokens',
  ] as const) {
    if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key]
  }
}

export async function compactConversation(
  options: CompactionRequest & { model: ModelAdapter },
): Promise<CompactionResult> {
  const summaryRequest = {
    role: 'user' as const,
    content: [{ type: 'text' as const, text: getCompactPrompt(options.instructions) }],
  }
  let history = options.messages
  const prefixLength = options.request.messages.length - history.length
  const contextPrefix = options.request.messages.slice(0, prefixLength)
  const usage: Usage = {}
  for (let attempt = 0; ; attempt++) {
    options.signal.throwIfAborted()
    const prefix = [...contextPrefix, ...history.map((message) => message.message)]
    let summary: string | undefined
    try {
      try {
        // This isolated, single-generation fork shares the main request prefix.
        // It deliberately has no tool executor, transcript writer or nested compactor.
        const response = await collectAssistantResponse(
          options.model,
          {
            ...options.request,
            maxOutputTokens: Math.min(
              options.request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
              20_000,
            ),
            messages: [...prefix, summaryRequest],
            cachePrefixMessageCount: prefix.length,
          },
          options.signal,
        )
        addUsage(usage, response.usage)
        const text = textOf(response)
        if (isContextOverflow(text)) throw new Error(text)
        if (validSummary(text)) summary = text
      } catch (error) {
        options.signal.throwIfAborted()
        if (isContextOverflow(error)) throw error
      }
      if (!summary) {
        const response = await collectAssistantResponse(
          options.model,
          {
            ...options.request,
            maxOutputTokens: Math.min(
              options.request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
              20_000,
            ),
            systemPrompt: ['You are a helpful AI assistant tasked with summarizing conversations.'],
            messages: [...history.map((message) => message.message), summaryRequest],
            tools: options.request.tools.filter((tool) => tool.name === 'Read'),
            cachePrefixMessageCount: 0,
          },
          options.signal,
        )
        addUsage(usage, response.usage)
        const text = textOf(response)
        if (isContextOverflow(text)) throw new Error(text)
        if (!validSummary(text)) throw new Error('Compaction failed: no valid summary text')
        summary = text
      }
      options.signal.throwIfAborted()
      const formatted = formatCompactSummary(summary)
      if (!formatted.trim()) throw new Error('Compaction failed: empty formatted summary')
      return {
        summaryMessages: [
          createUserMessage(
            {
              content: [
                {
                  type: 'text',
                  text: getCompactUserSummaryMessage(
                    summary,
                    options.trigger === 'auto',
                    options.transcriptPath,
                  ),
                },
              ],
            },
            { isCompactSummary: true },
          ),
        ],
        attachments: [],
        usage,
        trigger: options.trigger,
      }
    } catch (error) {
      options.signal.throwIfAborted()
      if (!isContextOverflow(error) || attempt >= 3) throw error
      const truncated = truncateHeadForRetry(history, error)
      if (!truncated) throw error
      history = truncated
    }
  }
}

const RETRY_MARKER = '[earlier conversation truncated for compaction retry]'
export function truncateHeadForRetry(
  messages: readonly TranscriptMessage[],
  error?: unknown,
): readonly TranscriptMessage[] | undefined {
  const input = messages.filter(
    (message) =>
      !(
        message.type === 'user' &&
        message.isMeta &&
        message.message.content.some(
          (block) => block.type === 'text' && block.text === RETRY_MARKER,
        )
      ),
  )
  const groups: TranscriptMessage[][] = []
  let current: TranscriptMessage[] = []
  let lastId: string | undefined
  for (const message of input) {
    if (message.type === 'assistant' && message.message.id !== lastId && current.length) {
      groups.push(current)
      current = []
    }
    current.push(message)
    if (message.type === 'assistant') lastId = message.message.id
  }
  if (current.length) groups.push(current)
  if (groups.length < 2) return undefined
  const detail = error instanceof Error ? error.message : String(error ?? '')
  const counts = detail.match(/(\d[\d,]*)\s*(?:tokens)?\s*>\s*(\d[\d,]*)/)
  let drop = Math.max(1, Math.floor(groups.length * 0.2))
  if (counts) {
    let gap = Number(counts[1]?.replaceAll(',', '')) - Number(counts[2]?.replaceAll(',', ''))
    drop = 0
    while (gap > 0 && drop < groups.length - 1)
      gap -= Math.ceil(JSON.stringify(groups[drop++]).length / 4)
    drop = Math.max(1, drop)
  }
  const remaining = groups.slice(Math.min(drop, groups.length - 1)).flat()
  // Repair only the retry copy; the authoritative transcript is never rewritten.
  const uses = new Set(
    remaining.flatMap((m) =>
      m.message.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : [])),
    ),
  )
  const repaired = remaining.map((m) =>
    m.type === 'user'
      ? {
          ...m,
          message: {
            ...m.message,
            content: m.message.content.filter(
              (b) => b.type !== 'tool_result' || uses.has(b.toolUseId),
            ),
          },
        }
      : m,
  )
  const result: TranscriptMessage[] = []
  for (const message of repaired) {
    result.push(message)
    if (message.type !== 'assistant') continue
    const nextIndex = repaired.indexOf(message) + 1
    const following = repaired[nextIndex]
    const resultIds = new Set(
      following?.type === 'user'
        ? following.message.content.flatMap((b) => (b.type === 'tool_result' ? [b.toolUseId] : []))
        : [],
    )
    const missing = message.message.content.flatMap((b) =>
      b.type === 'tool_use' && !resultIds.has(b.id)
        ? [
            {
              type: 'tool_result' as const,
              toolUseId: b.id,
              content: 'Tool result unavailable during compaction retry',
              isError: true,
            },
          ]
        : [],
    )
    if (missing.length) {
      if (following?.type === 'user') {
        repaired[nextIndex] = {
          ...following,
          message: {
            ...following.message,
            content: [
              ...following.message.content.filter((block) => block.type === 'tool_result'),
              ...missing,
              ...following.message.content.filter((block) => block.type !== 'tool_result'),
            ],
          },
        }
      } else result.push(createUserMessage({ content: missing }, { isMeta: true }))
    }
  }
  if (result[0]?.type !== 'user')
    result.unshift(
      createUserMessage({ content: [{ type: 'text', text: RETRY_MARKER }] }, { isMeta: true }),
    )
  return result
}
