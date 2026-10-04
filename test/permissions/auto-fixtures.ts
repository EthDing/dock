import { randomUUID } from 'node:crypto'
import type { ModelStreamEvent } from '../../src/model/types.js'

export const response = (text: string): ModelStreamEvent[] => [
  { type: 'message_start', messageId: 'classifier' },
  { type: 'content_block_start', index: 0, block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', stopReason: 'end_turn', usage: {} },
  { type: 'message_stop' },
]
export const execution = () => ({
  parentMessageUuid: randomUUID(),
  signal: new AbortController().signal,
  toolUseId: randomUUID(),
})
export const review = (decision = 'BLOCK') =>
  JSON.stringify({
    reasoning: 'The action affects an unapproved remote target.',
    decision,
    reason: 'Remote target not authorized',
  })
