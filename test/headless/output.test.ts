import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '../../src/messages/create-message.js'
import { asSessionId } from '../../src/sessions/ids.js'
import { finalText, resultForLoop, streamEventForAgentEvent } from '../../src/headless/output.js'

const sessionId = asSessionId('00000000-0000-4000-8000-000000000001')

describe('headless output schema', () => {
  it('extracts only text from the final assistant message', () => {
    const messages = [
      createUserMessage({ content: [{ type: 'text', text: 'hello' }] }),
      createAssistantMessage({
        role: 'assistant',
        id: 'answer',
        stopReason: 'end_turn',
        usage: {},
        content: [
          { type: 'thinking', thinking: 'hidden' },
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
      }),
    ]
    expect(finalText(messages)).toBe('first\nsecond')
  })

  it('maps loop termination to stable result subtypes', () => {
    const completed = resultForLoop(
      { reason: 'completed', messages: [] },
      { sessionId, result: 'done' },
    )
    expect(completed).toEqual({
      schema_version: 1,
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: sessionId,
      result: 'done',
    })
    expect(
      resultForLoop({ reason: 'max_turns', messages: [] }, { sessionId, result: '' }),
    ).toMatchObject({ subtype: 'error_max_turns', is_error: true })
    expect(
      resultForLoop(
        { reason: 'model_error', messages: [], error: 'offline' },
        { sessionId, result: '' },
      ),
    ).toMatchObject({ subtype: 'error_during_execution', error: 'offline', is_error: true })
  })

  it('emits committed messages once and omits provisional stream events', () => {
    const assistant = createAssistantMessage({
      role: 'assistant',
      id: 'answer',
      stopReason: 'end_turn',
      usage: {},
      content: [{ type: 'text', text: 'done' }],
    })
    expect(
      streamEventForAgentEvent({ type: 'assistant_message', message: assistant }, sessionId),
    ).toMatchObject({ type: 'assistant', session_id: sessionId, uuid: assistant.uuid })
    expect(
      streamEventForAgentEvent(
        {
          type: 'model_stream',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'd' },
          },
        },
        sessionId,
      ),
    ).toBeUndefined()
  })
})
