import { buildModelRequest, type RequestContext, roughRequestTokens } from '../agent/request.js'
import type { TranscriptMessage, UserTranscriptMessage } from '../messages/create-message.js'
import type { ModelRequest, ModelToolDefinition } from '../model/types.js'
import {
  buildPostCompactMessages,
  type CompactionRequest,
  type CompactionResult,
} from './compaction.js'
import { clearOldToolResults, type ToolResultClearingSettings } from './tool-result-clearing.js'

export type ContextAnalysis = { estimatedTokens: number; threshold: number; shouldCompact: boolean }
export type CompactionRestoration = {
  attachments: readonly UserTranscriptMessage[]
  userContext?: Readonly<Record<string, string>>
  commit: () => void
}
export type PreparedCompaction = CompactionResult & {
  userContext?: Readonly<Record<string, string>>
  commit: () => void
}

export type ContextManagerOptions = {
  contextWindow: number
  maxOutputTokens: number
  summarize: (request: CompactionRequest) => Promise<CompactionResult>
  toolResultClearing?: ToolResultClearingSettings | undefined
  prepareRestoration?: (signal: AbortSignal) => Promise<CompactionRestoration>
  now?: () => number
}
export class ContextManager {
  readonly #options: ContextManagerOptions
  #failures = 0
  constructor(options: ContextManagerOptions) {
    this.#options = options
  }

  analyze(
    messages: readonly TranscriptMessage[],
    systemPrompt: readonly string[] = [],
    tools: readonly ModelToolDefinition[] = [],
    userContext?: Readonly<Record<string, string>>,
  ): ContextAnalysis {
    const estimatedTokens = estimateContextTokens(messages, systemPrompt, tools, userContext)
    const threshold = getAutoCompactThreshold(
      this.#options.contextWindow,
      this.#options.maxOutputTokens,
    )
    return { estimatedTokens, threshold, shouldCompact: estimatedTokens >= threshold }
  }
  clear(messages: readonly TranscriptMessage[]) {
    return clearOldToolResults(
      messages,
      this.#options.toolResultClearing,
      this.#options.now?.() ?? Date.now(),
    )
  }
  shouldAutoCompact(messages: readonly TranscriptMessage[], context: RequestContext): boolean {
    return (
      this.#failures < 3 &&
      this.analyze(messages, context.systemPrompt, context.tools, context.userContext).shouldCompact
    )
  }
  async compact(
    messages: readonly TranscriptMessage[],
    request: ModelRequest,
    signal: AbortSignal,
    trigger: 'auto' | 'manual',
    instructions?: string,
  ): Promise<PreparedCompaction> {
    try {
      signal.throwIfAborted()
      if (!messages.length) throw new Error('Not enough messages to compact')
      const result = await this.#options.summarize({
        messages,
        request,
        signal,
        trigger,
        ...(instructions ? { instructions } : {}),
      })
      const restoration = await this.#options.prepareRestoration?.(signal)
      signal.throwIfAborted()
      const prepared = {
        ...result,
        trigger,
        attachments: restoration?.attachments ?? result.attachments,
      }
      const output = buildPostCompactMessages(prepared)
      const restoredRequest =
        restoration?.userContext !== undefined
          ? buildModelRequest(output, { ...request, userContext: restoration.userContext })
          : {
              ...request,
              messages: [
                ...request.messages.slice(0, request.messages.length - messages.length),
                ...output.map((m) => m.message),
              ],
            }
      let committed = false
      return {
        ...prepared,
        preTokens: roughRequestTokens(request),
        postTokens: roughRequestTokens(restoredRequest),
        ...(restoration?.userContext !== undefined ? { userContext: restoration.userContext } : {}),
        // Preparation is side-effect free. Call only after the durable boundary.
        commit: () => {
          if (committed) return
          committed = true
          restoration?.commit()
          this.#failures = 0
        },
      }
    } catch (error) {
      if (trigger === 'auto' && !signal.aborted) this.#failures++
      throw error
    }
  }
}
export function getAutoCompactThreshold(contextWindow: number, maxOutputTokens: number): number {
  return Math.max(1, contextWindow - Math.min(maxOutputTokens, 20_000) - 13_000)
}

export function estimateContextTokens(
  messages: readonly TranscriptMessage[],
  systemPrompt: readonly string[] = [],
  tools: readonly ModelToolDefinition[] = [],
  userContext?: Readonly<Record<string, string>>,
): number {
  const current = roughRequestTokens(
    buildModelRequest(messages, {
      modelId: '',
      systemPrompt,
      tools,
      ...(userContext ? { userContext } : {}),
    }),
  )
  const last = messages.findLast((message) => message.type === 'assistant')
  // A saved request baseline makes edits to older results and newly appended
  // messages visible without treating cache hits as a smaller context window.
  if (
    last?.type === 'assistant' &&
    last.requestTokenEstimate !== undefined &&
    last.message.usage.inputTokens !== undefined
  ) {
    return Math.max(
      0,
      Math.ceil(last.message.usage.inputTokens + current - last.requestTokenEstimate),
    )
  }
  return current
}
