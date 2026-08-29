import {
  type Component,
  type Editor,
  ScrollView,
  type TuiAltScreen,
  truncateToWidth,
  VStack,
} from '@dock/tui'
import { accent, muted, safeText } from '../presentation.js'
type BottomPanel = Component & { maxHeight: number }
export class FullscreenView {
  readonly scroll: ScrollView
  readonly root: VStack
  constructor(
    readonly options: {
      tui: TuiAltScreen
      editor: Editor
      body: () => Component
      panel: () => BottomPanel | undefined
      status: () => string
      target: () => string
      helper: () => string
    },
  ) {
    const body: Component = {
      render: (width) => options.body().render(width),
      invalidate: () => options.body().invalidate(),
    }
    this.scroll = new ScrollView(body, { follow: 'end', primary: true, scrollbar: 'auto' })
    const bottom: Component = {
      render: (width) => this.#bottom(width),
      invalidate: () => options.editor.invalidate(),
    }
    this.root = new (class extends VStack {
      override render(width: number): string[] {
        return [...body.render(width), ...bottom.render(width)]
      }
    })([
      { component: this.scroll, basis: 0, grow: 1, shrink: 1, minSize: 0 },
      { component: bottom, basis: 'auto', shrink: 0 },
    ])
    options.tui.setLayoutRoot(this.root)
  }
  #bottom(width: number): string[] {
    const o = this.options,
      height = Math.max(1, o.tui.terminal.rows),
      panel = o.panel()
    const budget = Math.max(1, height - 1)
    const result: string[] = []
    const historyHint = !this.scroll.isFollowingEnd ? 'History · Ctrl+End to follow latest' : ''
    const footer = panel ? [] : [o.target(), o.helper(), historyHint].filter(Boolean)
    const panelBudget = panel ? Math.min(14, Math.max(1, Math.floor(budget * 0.6))) : 0
    if (budget >= 5) result.push(muted(safeText(o.status())))
    const footerBudget = panel
      ? 0
      : Math.min(footer.length, Math.max(budget >= 3 ? 1 : 0, budget - 5))
    const editorBudget = Math.max(1, budget - result.length - panelBudget - footerBudget)
    const completionBudget = o.editor.isShowingAutocomplete()
      ? Math.min(4, Math.max(0, editorBudget - 3))
      : 0
    o.editor.setMaxVisibleLines(Math.max(1, Math.min(8, editorBudget - 2 - completionBudget)))
    o.editor.setAutocompleteMaxVisible(3)
    let editorLines = o.editor.render(Math.max(1, width - 2))
    // At tiny heights borders and hints yield to the cursor-bearing editor row.
    if (editorBudget < 3) editorLines = editorLines.slice(1, 2)
    else editorLines = editorLines.slice(0, editorBudget)
    result.push(
      ...editorLines.map(
        (line, i) => (i === (editorBudget < 3 ? 0 : 1) ? accent('› ') : '  ') + line,
      ),
    )
    if (panel) {
      panel.maxHeight = Math.max(1, budget - result.length)
      result.push(...panel.render(width))
    } else result.push(...footer.slice(0, footerBudget).map((line) => muted(safeText(line))))
    return result.slice(0, budget).map((line) => truncateToWidth(line, width))
  }
}
