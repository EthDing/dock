import { type Component, Text, truncateToWidth } from '@dock/tui'
import type { AgentView } from '../../agents/types.js'
import type { WorkTask } from '../../tasks/task-store.js'
import { accent, muted, safeText } from '../presentation.js'

export type TaskListItem =
  | { kind: 'work'; id: string; task: WorkTask }
  | { kind: 'agent'; id: string; agent: AgentView }

export class TaskList implements Component {
  items: TaskListItem[] = []
  selected = 0
  invalidate(): void {}
  update(tasks: readonly WorkTask[], agents: readonly AgentView[]): void {
    const selected = this.items[this.selected]?.id
    this.items = [
      ...tasks.map((task) => ({ kind: 'work' as const, id: task.id, task })),
      ...agents.map((agent) => ({ kind: 'agent' as const, id: agent.id, agent })),
    ]
    const index = this.items.findIndex((item) => item.id === selected)
    this.selected = Math.max(0, index >= 0 ? index : Math.min(this.selected, this.items.length - 1))
  }
  render(width: number): string[] {
    const lines = [accent('Tasks'), muted('Enter view · x stop agent · Esc main conversation'), '']
    const work = this.items.filter((item) => item.kind === 'work')
    lines.push(accent('Work'))
    if (!work.length) lines.push(muted('  No work tasks'))
    for (const item of work) {
      if (item.kind !== 'work') continue
      const index = this.items.indexOf(item)
      const prefix = index === this.selected ? '› ' : '  '
      const blocked = item.task.blockedBy.length
        ? ` · blocked by ${item.task.blockedBy.length}`
        : ''
      lines.push(
        (index === this.selected ? accent : muted)(
          `${prefix + safeText(item.task.subject)} · ${item.task.status}${blocked}`,
        ),
      )
    }
    lines.push('', accent('Agents'))
    const agents = this.items.filter((item) => item.kind === 'agent')
    if (!agents.length) lines.push(muted('  No subagents in this session'))
    for (const item of agents) {
      if (item.kind !== 'agent') continue
      const index = this.items.indexOf(item)
      const prefix = index === this.selected ? '› ' : '  '
      lines.push(
        (index === this.selected ? accent : muted)(
          `${prefix + safeText(item.agent.name ?? item.agent.description)} · ${item.agent.status}`,
        ),
      )
      lines.push(...new Text(`  ${safeText(item.agent.id)}`, 0, 0).render(width))
    }
    lines.push('', muted('Subagent edits are not restored by the parent /rewind.'))
    return lines.map((line) => truncateToWidth(line, width))
  }
}
