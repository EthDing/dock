import type { UUID } from 'node:crypto'
import type { TranscriptMessage } from '../messages/create-message.js'
import type { SessionMessageRecord, SessionRecord } from './session-store.js'

type Node = { message: TranscriptMessage; parent: Node | undefined }
function transcript(record: SessionMessageRecord): TranscriptMessage {
  const {
    parentUuid: _parent,
    sessionId: _session,
    cwd: _cwd,
    compactionId: _compact,
    ...message
  } = record
  return message
}
export function buildDisplayHistory(
  records: readonly SessionRecord[],
): readonly TranscriptMessage[] {
  const committed = new Set(
    records.flatMap((r) =>
      r.type === 'compact_boundary' && r.compactionId ? [r.compactionId] : [],
    ),
  )
  const messages = new Map<UUID, SessionMessageRecord>()
  for (const r of records)
    if (
      (r.type === 'user' || r.type === 'assistant') &&
      (!r.compactionId || committed.has(r.compactionId))
    )
      messages.set(r.uuid, r)
  const nodes = new Map<UUID, Node>(),
    beforeSummary = new Map<UUID, Node | undefined>()
  let head: Node | undefined
  for (const r of records) {
    if (r.type === 'user' || r.type === 'assistant') {
      if (r.compactionId) continue
      if (r.type === 'user' && r.isCompactSummary) beforeSummary.set(r.uuid, head)
      const parent = r.parentUuid ? nodes.get(r.parentUuid) : undefined
      const node = { message: transcript(r), parent }
      nodes.set(r.uuid, node)
      head = node
    } else if (r.type === 'rewind') {
      head = nodes.get(r.targetUuid)
    } else if (r.type === 'compact_boundary') {
      // Keep the pre-commit display chain. The model's compact boundary still cuts context.
      const prefix = beforeSummary.has(r.summaryUuid) ? beforeSummary.get(r.summaryUuid) : head
      const seen = new Set<UUID>()
      for (let n = prefix; n; n = n.parent) seen.add(n.message.uuid)
      head = prefix
      for (const id of [r.summaryUuid, ...r.preservedUuids]) {
        const record = messages.get(id)
        if (!record) throw new Error(`Missing committed display message ${id}`)
        if (!seen.has(id)) {
          head = { message: transcript(record), parent: head }
          seen.add(id)
        }
        if (head) nodes.set(id, head)
      }
    }
  }
  const result: TranscriptMessage[] = []
  for (let node = head; node; node = node.parent) result.push(node.message)
  return result.reverse()
}
