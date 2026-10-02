import type { TranscriptMessage } from '../messages/create-message.js'
import type { SessionRecord } from '../sessions/session-store.js'

export function parseEvalCompactAfter(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const count = Number(value)
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(count))
    throw new Error('DOCK_EVAL_COMPACT_AFTER must be a positive safe integer')
  return count
}

// Owned by the root session, not by an individual model turn or subagent.
export class EvalCompaction {
  #active = false
  #results = 0
  #triggered = false

  constructor(
    readonly after: number,
    records: readonly SessionRecord[],
    readonly persistTrigger: () => Promise<void>,
  ) {
    // Activation context follows the complete result batch in JSONL. Link it
    // back to its result so later results in that same batch count on resume.
    const activations = new Set(
      records.flatMap((record) =>
        record.type === 'user' && !record.compactionId && record.skillContext?.activationToolUseId
          ? [record.skillContext.activationToolUseId]
          : [],
      ),
    )
    for (const record of records) {
      if (record.type === 'eval_compaction_trigger') this.#triggered = true
      if (record.type !== 'user' || record.compactionId) continue
      for (const block of record.message.content) {
        if (block.type === 'tool_result') this.observeResult(activations.has(block.toolUseId))
      }
      if (record.skillContext) this.activate()
    }
  }

  activate(): void {
    this.#active = true
  }

  observeMessage(message: TranscriptMessage): void {
    if (message.type === 'user' && message.skillContext) this.activate()
  }

  observeResult(activated: boolean): void {
    if (this.#active) this.#results++
    else if (activated) this.activate()
  }

  async claim(): Promise<boolean> {
    if (this.#triggered || !this.#active || this.#results < this.after) return false
    // Persist the attempt before requesting a summary, so even failure or
    // cancellation cannot repeat the eval trigger after reopening a session.
    await this.persistTrigger()
    this.#triggered = true
    return true
  }
}
