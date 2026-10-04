import type { TranscriptMessage } from '../messages/create-message.js'
import { collectAssistantResponse } from '../model/stream-response.js'
import type { JsonObject, ModelAdapter, ModelMessage } from '../model/types.js'
import type { ToolExecutionContext } from '../tools/types.js'
import {
  AUTO_FAST_INSTRUCTION,
  AUTO_REVIEW_INSTRUCTION,
  autoModePrompt,
  type AutoModeSettings,
} from './auto-prompt.js'

export type AutoVerdict = { behavior: 'allow' } | { behavior: 'deny'; message: string }

export function classifierToolInput(name: string, input: JsonObject): JsonObject {
  const copy = { ...input }
  if (name === 'Bash' || name === 'Agent') delete copy.description
  if (name === 'SendMessage') delete copy.summary
  return copy
}

export function classifierTranscript(messages: readonly TranscriptMessage[]): JsonObject[] {
  return messages.flatMap((entry): JsonObject[] => {
    if (entry.type === 'user') {
      if (entry.isMeta || entry.isCompactSummary || entry.skillContext || entry.agentEventKey)
        return []
      return entry.message.content.flatMap((block) =>
        block.type === 'text' ? [{ type: 'user', text: block.text }] : [],
      )
    }
    return entry.message.content.flatMap((block) =>
      block.type === 'tool_use'
        ? [
            {
              type: 'tool_call',
              name: block.name,
              input: classifierToolInput(block.name, block.input),
            },
          ]
        : [],
    )
  })
}

export class AutoClassifier {
  constructor(
    readonly options: {
      repository?: string | undefined
      settings?: AutoModeSettings
      resolveModel: (
        execution: ToolExecutionContext,
      ) => Promise<{ model: ModelAdapter; modelId: string }>
      getMessages?: (execution: ToolExecutionContext) => Promise<readonly TranscriptMessage[]>
      timeoutMs?: number
    },
  ) {}

  async classify(
    name: string,
    input: JsonObject,
    execution: ToolExecutionContext,
  ): Promise<AutoVerdict> {
    const abort = new AbortController()
    const onAbort = () => abort.abort()
    execution.signal.addEventListener('abort', onAbort, { once: true })
    if (execution.signal.aborted) onAbort()
    const timer = setTimeout(onAbort, this.options.timeoutMs ?? 60_000)
    let rejectAbort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new Error('Auto review cancelled or timed out'))
      abort.signal.addEventListener('abort', rejectAbort, { once: true })
      if (abort.signal.aborted) rejectAbort()
    })
    try {
      return await Promise.race([this.#review(name, input, execution, abort.signal), cancelled])
    } catch {
      // Provider errors can contain credentials or request bodies. Never echo them.
      return {
        behavior: 'deny',
        message:
          'Auto classifier unavailable, timed out, cancelled, or returned an invalid response.',
      }
    } finally {
      clearTimeout(timer)
      execution.signal.removeEventListener('abort', onAbort)
      abort.signal.removeEventListener('abort', rejectAbort)
    }
  }

  async #review(
    name: string,
    input: JsonObject,
    execution: ToolExecutionContext,
    signal: AbortSignal,
  ): Promise<AutoVerdict> {
    signal.throwIfAborted()
    const { model, modelId } = await this.options.resolveModel(execution)
    const messages =
      (await this.options.getMessages?.(execution)) ?? execution.agent?.messages ?? []
    signal.throwIfAborted()
    const prefix: ModelMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            transcript: classifierTranscript(messages),
            pending: { name, input: classifierToolInput(name, input), cwd: execution.agent?.cwd },
          }),
        },
      ],
    }
    const request = async (instruction: string) => {
      const response = await collectAssistantResponse(
        model,
        {
          modelId,
          systemPrompt: [autoModePrompt(this.options.repository, this.options.settings ?? {})],
          messages: [prefix, { role: 'user', content: [{ type: 'text', text: instruction }] }],
          cachePrefixMessageCount: 1,
          // Allow providers' hidden reasoning and minimum output budgets; the
          // fast pass still emits only one visible decision.
          maxOutputTokens: 2048,
          tools: [],
        },
        signal,
      )
      if (response.stopReason !== 'end_turn' || response.content.some((b) => b.type === 'tool_use'))
        throw new Error('Incomplete classifier response')
      return response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim()
    }
    const fast = await request(AUTO_FAST_INSTRUCTION)
    if (fast === 'ALLOW') return { behavior: 'allow' }
    if (fast !== 'BLOCK') throw new Error('Invalid fast decision')
    const result: unknown = JSON.parse(await request(AUTO_REVIEW_INSTRUCTION))
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new Error('Invalid review')
    const value = result as Record<string, unknown>
    if (
      Object.keys(value).sort().join(',') !== 'decision,reason,reasoning' ||
      typeof value.reasoning !== 'string' ||
      !value.reasoning.trim() ||
      typeof value.reason !== 'string' ||
      !value.reason.trim() ||
      !['ALLOW', 'BLOCK'].includes(String(value.decision))
    )
      throw new Error('Invalid review')
    return value.decision === 'ALLOW'
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: value.reason }
  }
}

export class AutoPermissionState {
  consecutiveBlocks = 0
  totalBlocks = 0
  #requiresHuman = false
  get requiresHuman(): boolean {
    return this.#requiresHuman
  }
  record(verdict: AutoVerdict): void {
    if (verdict.behavior === 'deny') {
      this.consecutiveBlocks++
      this.totalBlocks++
    } else this.consecutiveBlocks = 0
    if (this.consecutiveBlocks >= 3 || this.totalBlocks >= 20) this.#requiresHuman = true
  }
}
