import { type Component, Key, matchesKey, Text, truncateToWidth } from '@dock/tui'
import { accent, muted, safeText } from '../presentation.js'
export type Choice = { value: string; label: string; description?: string }
export class InteractionPanel implements Component {
  #selected = 0
  #offset = 0
  maxHeight = 12
  onSelect: ((value: string) => void) | undefined
  onCancel: (() => void) | undefined
  constructor(
    readonly title: string,
    readonly body: string,
    readonly choices: readonly Choice[],
  ) {}
  get selected(): number {
    return this.#selected
  }
  invalidate(): void {}
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.onCancel?.()
      return
    }
    if (matchesKey(data, Key.up)) this.#selected = Math.max(0, this.#selected - 1)
    else if (matchesKey(data, Key.down))
      this.#selected = Math.min(this.choices.length - 1, this.#selected + 1)
    else if (matchesKey(data, 'pageUp')) this.#offset = Math.max(0, this.#offset - 3)
    else if (matchesKey(data, 'pageDown')) this.#offset += 3
    else if (matchesKey(data, Key.enter)) {
      const selected = this.choices[this.#selected]
      if (selected) this.onSelect?.(selected.value)
    }
  }
  render(width: number): string[] {
    const height = Math.max(1, this.maxHeight),
      bodyLines = new Text(safeText(this.body), 0, 0).render(Math.max(1, width - 2))
    if (height <= 2) {
      const selected = this.choices[this.#selected]
      return [
        ...(height === 2 ? [accent(safeText(this.title))] : []),
        accent(`› ${safeText(selected?.label ?? 'Esc cancel')}`),
      ].map((line) => truncateToWidth(line, width))
    }
    const shownChoices = Math.max(1, Math.min(this.choices.length, height - 3))
    const start = Math.max(0, Math.min(this.#selected, this.choices.length - shownChoices))
    const options = this.choices.slice(start, start + shownChoices).map((choice, i) => {
      const text = (start + i === this.#selected ? '› ' : '  ') + safeText(choice.label)
      return start + i === this.#selected ? accent(text) : muted(text)
    })
    const budget = Math.max(0, height - 2 - options.length)
    this.#offset = Math.min(this.#offset, Math.max(0, bodyLines.length - budget))
    return [
      accent(safeText(this.title)),
      ...bodyLines.slice(this.#offset, this.#offset + budget).map(muted),
      ...options,
      muted(
        bodyLines.length > budget
          ? 'PgUp/PgDn details · Enter select · Esc cancel'
          : 'Enter select · Esc cancel',
      ),
    ]
      .slice(0, height)
      .map((line) => truncateToWidth(line, width))
  }
}
