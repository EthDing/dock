import { type Component, Markdown, Text, truncateToWidth } from '@dock/tui'
import { accent, muted, paint, safeText, uiPalette } from '../presentation.js'
import { markdownTheme } from '../themes.js'
import type { DisplayItem, MessageItem, ToolDisplay, TranscriptState } from '../transcript-state.js'

function lines(text: string, width: number): string[] {
  return new Text(safeText(text), 0, 0).render(width)
}
export class ToolComponent implements Component {
  constructor(
    readonly tool: ToolDisplay,
    readonly detailed: () => boolean,
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    const tool = this.tool,
      call = tool.call,
      detail = this.detailed()
    const arg =
      call?.input.file_path ??
      call?.input.command ??
      call?.input.pattern ??
      call?.input.description ??
      ''
    const result = [`${muted(`  ${safeText(call?.name ?? 'Tool')}`)} ${safeText(arg)}`]
    result[0] = truncateToWidth(result[0] ?? '', width)
    if (detail && call)
      result.push(
        ...lines(JSON.stringify(call.input, null, 2), Math.max(1, width - 4)).map(
          (x) => `    ${x}`,
        ),
      )
    if (call?.name === 'Edit') {
      for (const [key, prefix] of [
        ['old_string', '-'],
        ['new_string', '+'],
      ] as const) {
        const value = call.input[key]
        if (typeof value === 'string')
          result.push(
            ...lines(`${prefix} ${value}`, Math.max(1, width - 4))
              .slice(0, detail ? undefined : 2)
              .map((x) => `    ${x}`),
          )
      }
    }
    const label =
      tool.status === 'permission'
        ? 'Awaiting permission'
        : tool.status === 'denied'
          ? 'Denied'
          : tool.status === 'aborted'
            ? 'Interrupted'
            : tool.status === 'error'
              ? 'Error'
              : tool.status === 'success'
                ? 'Done'
                : tool.status === 'queued'
                  ? 'Queued'
                  : 'Running'
    result.push(
      (tool.status === 'error' ? (s: string) => paint(s, uiPalette.error) : muted)(`    ${label}`),
    )
    if (tool.result) {
      const all = lines(tool.result.content, Math.max(1, width - 4))
      const visible = detail
        ? all
        : tool.status === 'error' || tool.status === 'aborted'
          ? all.slice(-3)
          : all.slice(0, 3)
      result.push(...visible.map((x) => `    ${x}`))
      if (!detail && all.length > 3) result.push(muted('    … Ctrl+O for full output'))
    }
    return result.map((x) => truncateToWidth(x, width))
  }
}
class MessageComponent implements Component {
  constructor(
    readonly item: MessageItem,
    readonly state: TranscriptState,
    readonly detailed: () => boolean,
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    const entry = this.item,
      message = entry.message
    const content = message.message.content
    if (message.type === 'user' && message.isCompactSummary) {
      return [
        muted('── Conversation compacted ──'),
        ...(this.detailed()
          ? lines(
              content
                .filter((x) => x.type === 'text')
                .map((x) => x.text)
                .join('\n'),
              width,
            )
          : []),
        '',
      ]
    }
    if (message.type === 'user' && message.skillContext) {
      return [
        muted(`Loaded Skill: ${safeText(message.skillContext.name)}`),
        ...(this.detailed()
          ? lines(
              content
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
                .join('\n'),
              width,
            )
          : []),
        '',
      ]
    }
    const visible = content.some((b) => b.type !== 'tool_result')
    if (!visible) return []
    const role = message.type === 'assistant' ? 'Dock' : message.isMeta ? 'System' : 'You'
    const result = [message.type === 'assistant' ? accent(role) : muted(role)]
    const toolCalls = content.filter((block) => block.type === 'tool_use')
    const groupedTools = message.type === 'assistant' && toolCalls.length > 1 && !this.detailed()
    let renderedGroup = false
    for (const block of content) {
      if (block.type === 'text') {
        const text = safeText(block.text)
        result.push(...new Markdown(text, 0, 0, markdownTheme).render(width))
      } else if (block.type === 'thinking') {
        result.push(muted(`Thinking${this.detailed() ? '' : ' · Ctrl+O to expand'}`))
        if (this.detailed()) result.push(...lines(block.thinking, width).map(muted))
      } else if (block.type === 'tool_use') {
        if (groupedTools) {
          if (renderedGroup) continue
          renderedGroup = true
          result.push(...renderToolGroup(toolCalls, this.state, width))
          continue
        }
        const tool = this.state.tool(block.id) ?? { call: block, status: 'queued', revision: 0 }
        result.push(...new ToolComponent(tool, this.detailed).render(width))
      }
    }
    if (entry.partial) result.push(muted('Incomplete response'))
    result.push('')
    return result
  }
}

function renderToolGroup(
  calls: readonly Extract<
    MessageItem['message']['message']['content'][number],
    { type: 'tool_use' }
  >[],
  state: TranscriptState,
  width: number,
): string[] {
  const tools = calls.map(
    (call) => state.tool(call.id) ?? { call, status: 'queued' as const, revision: 0 },
  )
  const names = new Map<string, number>()
  const statuses = new Map<string, number>()
  for (const tool of tools) {
    const name = tool.call?.name ?? 'Tool'
    names.set(name, (names.get(name) ?? 0) + 1)
    statuses.set(tool.status, (statuses.get(tool.status) ?? 0) + 1)
  }
  const nameSummary = [...names].map(([name, count]) => `${name} ×${count}`).join(' · ')
  const statusSummary = [...statuses].map(([status, count]) => `${count} ${status}`).join(' · ')
  const lines = [muted(`  ${calls.length} tools · ${nameSummary} · ${statusSummary}`)]
  const exceptional = tools.filter((tool) =>
    ['running', 'permission', 'denied', 'aborted', 'error'].includes(tool.status),
  )
  for (const tool of exceptional) lines.push(...new ToolComponent(tool, () => false).render(width))
  lines.push(muted('    Ctrl+O to expand'))
  return lines
}
export class TranscriptView implements Component {
  #cache = new WeakMap<DisplayItem, { version: string; lines: string[] }>()
  detailed = false
  constructor(public state: TranscriptState) {}
  invalidate(): void {
    this.#cache = new WeakMap()
  }
  render(width: number): string[] {
    const result: string[] = []
    for (const item of this.state.items) {
      const tools =
        item.kind === 'message'
          ? item.message.message.content
              .filter((b) => b.type === 'tool_use')
              .map((b) => this.state.tool(b.id)?.revision ?? 0)
              .join(',')
          : ''
      const version = [width, this.detailed, item.revision, tools].join(':')
      let cached = this.#cache.get(item)
      if (!cached || cached.version !== version) {
        const rendered =
          item.kind === 'message'
            ? new MessageComponent(item, this.state, () => this.detailed).render(
                Math.max(1, width - 2),
              )
            : lines(item.text, Math.max(1, width - 2))
                .map((x) => (item.error ? paint(x, uiPalette.error) : muted(x)))
                .concat('')
        cached = { version, lines: rendered.map((x) => truncateToWidth(` ${x} `, width)) }
        this.#cache.set(item, cached)
      }
      result.push(...cached.lines)
    }
    return result
  }
}
