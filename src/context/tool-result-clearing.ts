import type { TranscriptMessage } from '../messages/create-message.js'

export const CLEARED_TOOL_RESULT = '[Old tool result content cleared]'
export type ToolResultClearingSettings = {
  enabled?: boolean | undefined
  gapThresholdMinutes?: number | undefined
  keepRecent?: number | undefined
}
const COMPACTABLE_TOOLS = new Set(['Read', 'Bash', 'Grep', 'Glob', 'Write', 'Edit'])

export function applyClearedToolResults(
  messages: readonly TranscriptMessage[],
  ids: ReadonlySet<string>,
): readonly TranscriptMessage[] {
  if (ids.size === 0) return messages
  return messages.map((message) => {
    if (message.type !== 'user') return message
    let changed = false
    const content = message.message.content.map((block) => {
      if (
        block.type !== 'tool_result' ||
        !ids.has(block.toolUseId) ||
        block.content === CLEARED_TOOL_RESULT
      )
        return block
      changed = true
      return { ...block, content: CLEARED_TOOL_RESULT }
    })
    return changed ? { ...message, message: { ...message.message, content } } : message
  })
}

export function clearOldToolResults(
  messages: readonly TranscriptMessage[],
  settings: ToolResultClearingSettings = {},
  now = Date.now(),
): { messages: readonly TranscriptMessage[]; clearedToolUseIds: string[] } {
  const unchanged = { messages, clearedToolUseIds: [] as string[] }
  if (settings.enabled === false) return unchanged
  const last = messages.findLast((message) => message.type === 'assistant')
  if (!last) return unchanged
  const elapsed = now - Date.parse(last.timestamp)
  if (!Number.isFinite(elapsed) || elapsed < (settings.gapThresholdMinutes ?? 60) * 60_000)
    return unchanged
  const ids = messages.flatMap((message) =>
    message.type === 'assistant'
      ? message.message.content.flatMap((block) =>
          block.type === 'tool_use' && COMPACTABLE_TOOLS.has(block.name) ? [block.id] : [],
        )
      : [],
  )
  const oldIds = ids.slice(0, Math.max(0, ids.length - Math.max(1, settings.keepRecent ?? 5)))
  const uncleared = new Set(
    messages.flatMap((message) =>
      message.type === 'user'
        ? message.message.content.flatMap((block) =>
            block.type === 'tool_result' && block.content !== CLEARED_TOOL_RESULT
              ? [block.toolUseId]
              : [],
          )
        : [],
    ),
  )
  const clearedToolUseIds = [...new Set(oldIds.filter((id) => uncleared.has(id)))]
  return {
    messages: applyClearedToolResults(messages, new Set(clearedToolUseIds)),
    clearedToolUseIds,
  }
}
