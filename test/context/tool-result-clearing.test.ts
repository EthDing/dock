import { describe, expect, it } from 'vitest'
import {
  applyClearedToolResults,
  CLEARED_TOOL_RESULT,
  clearOldToolResults,
} from '../../src/context/tool-result-clearing.js'
import {
  createAssistantMessage,
  createUserMessage,
  type TranscriptMessage,
} from '../../src/messages/create-message.js'

const now = Date.parse('2026-08-28T12:00:00Z')
function history(count = 7, names = ['Read']): TranscriptMessage[] {
  return Array.from({ length: count }, (_, i) => [
    createAssistantMessage(
      {
        id: String(i),
        role: 'assistant',
        stopReason: 'tool_use',
        usage: {},
        content: [
          {
            type: 'tool_use',
            id: String(i),
            name: names[i % names.length] ?? 'Read',
            input: { file_path: '/file' },
          },
        ],
      },
      { now: () => new Date(now - 3_600_000) },
    ),
    createUserMessage({
      content: [
        {
          type: 'tool_result',
          toolUseId: String(i),
          content: i === 0 ? 'tiny' : 'x'.repeat(10000),
        },
      ],
    }),
  ]).flat()
}
describe('time-based tool result clearing', () => {
  it('does nothing before the time threshold, even for large results', () => {
    const messages = history()
    expect(clearOldToolResults(messages, {}, now - 1).messages).toBe(messages)
  })
  it('clears old results at the boundary, preserving five calls and all identities', () => {
    const messages = history()
    const result = clearOldToolResults(messages, {}, now)
    expect(result.clearedToolUseIds).toEqual(['0', '1'])
    expect(result.messages.map((m) => m.uuid)).toEqual(messages.map((m) => m.uuid))
    expect(result.messages[1]?.message.content[0]).toMatchObject({
      content: CLEARED_TOOL_RESULT,
      toolUseId: '0',
    })
    expect(messages[1]?.message.content[0]).toMatchObject({ content: 'tiny' })
    expect(clearOldToolResults(result.messages, {}, now).clearedToolUseIds).toEqual([])
    expect(applyClearedToolResults(messages, new Set(result.clearedToolUseIds))).toEqual(
      result.messages,
    )
  })
  it('selects by tool call order, not result size or result arrival order', () => {
    const messages = history(3)
    const assistant = createAssistantMessage(
      {
        id: 'batch',
        role: 'assistant',
        stopReason: 'tool_use',
        usage: {},
        content: ['a', 'b', 'c'].map((id) => ({
          type: 'tool_use' as const,
          id,
          name: 'Bash',
          input: {},
        })),
      },
      { now: () => new Date(now - 3_600_000) },
    )
    messages.push(
      assistant,
      createUserMessage({
        content: ['c', 'a', 'b'].map((id) => ({
          type: 'tool_result' as const,
          toolUseId: id,
          content: id,
        })),
      }),
    )
    expect(clearOldToolResults(messages, { keepRecent: 1 }, now).clearedToolUseIds).toEqual([
      '0',
      '1',
      '2',
      'a',
      'b',
    ])
  })
  it('excludes other tools and respects disabled or missing timestamps', () => {
    const messages = history(7, ['Other'])
    expect(clearOldToolResults(messages, {}, now).clearedToolUseIds).toEqual([])
    expect(clearOldToolResults(history(), { enabled: false }, now).clearedToolUseIds).toEqual([])
    const invalid = history().map((m) => ({ ...m, timestamp: 'invalid' }))
    expect(clearOldToolResults(invalid, {}, now).clearedToolUseIds).toEqual([])
    expect(
      clearOldToolResults([createUserMessage({ content: [] })], {}, now).clearedToolUseIds,
    ).toEqual([])
  })
})
