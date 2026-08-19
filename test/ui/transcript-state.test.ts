import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '../../src/messages/create-message.js'
import { createSessionId } from '../../src/sessions/ids.js'
import { TranscriptState } from '../../src/ui/transcript-state.js'

it('merges streaming and committed messages, correlates results, and ignores other sessions', () => {
  const sessionId = createSessionId(),
    operationId = randomUUID(),
    state = new TranscriptState(sessionId)
  state.apply({
    type: 'model_stream',
    event: { type: 'message_start', messageId: 'response' },
    sessionId,
    operationId,
  })
  state.apply({
    type: 'model_stream',
    event: { type: 'content_block_start', index: 0, block: { type: 'text' } },
    sessionId,
    operationId,
  })
  state.apply({
    type: 'model_stream',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
    sessionId,
    operationId,
  })
  const assistant = createAssistantMessage({
    role: 'assistant',
    id: 'response',
    usage: {},
    stopReason: 'tool_use',
    content: [
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 'tool', name: 'Read', input: { file_path: '/work/x' } },
    ],
  })
  state.apply({ type: 'assistant_message', message: assistant, sessionId, operationId })
  state.apply({ type: 'assistant_message', message: assistant, sessionId, operationId })
  state.apply({
    type: 'tool_result',
    result: { type: 'tool_result', toolUseId: 'tool', content: '拒绝', isError: true },
    outcome: 'denied',
    sessionId,
    operationId,
  })
  state.apply({
    type: 'user_message',
    message: createUserMessage({
      content: [{ type: 'tool_result', toolUseId: 'tool', content: '拒绝', isError: true }],
    }),
    sessionId,
    operationId,
  })
  expect(
    state.items.filter((x) => x.kind === 'message' && x.message.type === 'assistant'),
  ).toHaveLength(1)
  expect(state.tool('tool')?.status).toBe('denied')
  state.apply({
    type: 'user_message',
    message: createUserMessage({ content: [{ type: 'text', text: 'foreign' }] }),
    sessionId: createSessionId(),
  })
  expect(JSON.stringify(state.items)).not.toContain('foreign')
})
it('retains pre-compact history and partial text on model failure', () => {
  const sessionId = createSessionId(),
    state = new TranscriptState(sessionId)
  state.addPrompt('old prompt')
  state.apply({ type: 'model_stream', event: { type: 'message_start', messageId: 'm' } })
  state.apply({
    type: 'model_stream',
    event: { type: 'content_block_start', index: 0, block: { type: 'text' } },
  })
  state.apply({
    type: 'model_stream',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'partial' },
    },
  })
  state.apply({ type: 'turn_end', result: { reason: 'model_error', error: 'offline' } })
  expect(JSON.stringify(state.items)).toContain('partial')
  expect(state.status).toBe('failed')
  const summary = createUserMessage(
    { content: [{ type: 'text', text: 'summary' }] },
    { isCompactSummary: true },
  )
  state.apply({ type: 'compact', messages: [summary] })
  expect(JSON.stringify(state.items)).toContain('old prompt')
})
it.each(['你好', '你是什么模型', '第一行\nsecond 😀'])(
  'reconciles a pending prompt regardless of block property order: %s',
  (text) => {
    const state = new TranscriptState(createSessionId())
    state.addPrompt(text)
    const pending = state.items[0]
    const committed = createUserMessage({ content: [{ text, type: 'text' }] })
    state.apply({ type: 'user_message', message: committed })
    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toBe(pending)
    expect(state.items[0]).toMatchObject({ message: { uuid: committed.uuid }, pending: false })
    state.apply({ type: 'user_message', message: committed })
    expect(state.items).toHaveLength(1)
    state.addPrompt(text)
    const second = createUserMessage({ content: [{ text, type: 'text' }] })
    state.apply({ type: 'user_message', message: second })
    expect(state.items).toHaveLength(2)
    expect(state.items.map((item) => (item.kind === 'message' ? item.message.uuid : ''))).toEqual([
      committed.uuid,
      second.uuid,
    ])
  },
)
