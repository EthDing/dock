import { type Component, Text, truncateToWidth } from '@dock/tui'
import type { AgentView } from '../../agents/types.js'
import { accent, muted, safeText } from '../presentation.js'
export class TaskList implements Component {
  items: AgentView[] = []
  selected = 0
  invalidate(): void {}
  update(items: readonly AgentView[]): void {
    const selected = this.items[this.selected]?.id
    this.items = [...items]
    const index = this.items.findIndex((a) => a.id === selected)
    this.selected = Math.max(0, index >= 0 ? index : Math.min(this.selected, this.items.length - 1))
  }
  render(width: number): string[] {
    const lines = [accent('Tasks'), muted('Enter view · x stop · Esc main conversation'), '']
    for (const [i, agent] of this.items.entries()) {
      const prefix = i === this.selected ? '› ' : '  '
      lines.push(
        (i === this.selected ? accent : muted)(
          `${prefix + safeText(agent.name ?? agent.description)} · ${agent.status}`,
        ),
      )
      lines.push(...new Text(`  ${safeText(agent.id)}`, 0, 0).render(width))
    }
    if (!this.items.length) lines.push(muted('No subagents in this session'))
    lines.push('', muted('Subagent edits are not restored by the parent /rewind.'))
    return lines.map((line) => truncateToWidth(line, width))
  }
}
