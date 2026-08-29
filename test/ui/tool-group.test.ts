import { randomUUID } from 'node:crypto'
import { stripVTControlCharacters } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '../../src/messages/create-message.js'
import { TranscriptView } from '../../src/ui/components/transcript.js'
import { TranscriptState } from '../../src/ui/transcript-state.js'
import { asSessionId } from '../../src/sessions/ids.js'

describe('tool group rendering', () => {
  it('collapses multiple tools in normal view and expands them with detailed mode', () => {
    const first = { type: 'tool_use' as const, id: 'one', name: 'Read', input: { file_path: '/a' } }
    const second = {
      type: 'tool_use' as const,
      id: 'two',
      name: 'Read',
      input: { file_path: '/b' },
    }
    const state = new TranscriptState(asSessionId(randomUUID()))
    state.setMessages([
      createAssistantMessage({
        role: 'assistant',
        id: 'a',
        usage: {},
        stopReason: 'tool_use',
        content: [first, second],
      }),
      createUserMessage({
        content: [
          { type: 'tool_result', toolUseId: 'one', content: 'first body' },
          { type: 'tool_result', toolUseId: 'two', content: 'second body' },
        ],
      }),
    ])
    const view = new TranscriptView(state)
    const compact = stripVTControlCharacters(view.render(80).join('\n'))
    expect(compact).toContain('2 tools · Read ×2')
    expect(compact).not.toContain('first body')
    view.detailed = true
    const detailed = stripVTControlCharacters(view.render(80).join('\n'))
    expect(detailed).toContain('/a')
    expect(detailed).toContain('/b')
    expect(detailed).toContain('first body')
  })
  it('keeps grouped errors visible', () => {
    const state = new TranscriptState(asSessionId(randomUUID()))
    state.setMessages([
      createAssistantMessage({
        role: 'assistant',
        id: 'a',
        usage: {},
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'one', name: 'Read', input: { file_path: '/a' } },
          { type: 'tool_use', id: 'two', name: 'Read', input: { file_path: '/b' } },
        ],
      }),
      createUserMessage({
        content: [
          { type: 'tool_result', toolUseId: 'one', content: 'ok' },
          { type: 'tool_result', toolUseId: 'two', content: 'visible failure', isError: true },
        ],
      }),
    ])
    expect(stripVTControlCharacters(new TranscriptView(state).render(80).join('\n'))).toContain(
      'visible failure',
    )
  })
})
