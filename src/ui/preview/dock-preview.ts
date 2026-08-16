import {
  type Component,
  type Focusable,
  Input,
  Key,
  matchesKey,
  ProcessTerminal,
  type Terminal,
  Text,
  TuiMainScreen,
  truncateToWidth,
  visibleWidth,
} from '@dock/tui'

export type LogoRows = 3 | 5 | 7
export type PreviewScene = 'welcome' | 'chat' | 'permission'
const palette = {
  body: '242;239;231',
  shade: '187;188;186',
  seam: '83;84;82',
  green: '103;207;149',
  accent: '218;138;102',
  text: '216;216;211',
  muted: '139;140;135',
}
const reset = '\x1b[0m'
const fg = (rgb: string) => `\x1b[38;2;${rgb}m`
const bg = (rgb: string) => `\x1b[48;2;${rgb}m`
const color = (text: string, rgb: string) => fg(rgb) + text + reset
const dim = (text: string) => color(text, palette.muted)
const accent = (text: string) => color(text, palette.accent)

export function renderCaseLogo(rows: LogoRows): string[] {
  const width = rows * 3 + 3,
    height = rows * 2
  const pixels: Array<Array<string | null>> = []
  for (let y = 0; y < height; y++) {
    const edge = Math.min(y, height - 1 - y)
    const inset = edge === 0 ? Math.floor(width / 6) : edge === 1 ? 1 : 0
    pixels.push(
      Array.from({ length: width }, (_, x) => {
        if (x < inset || x >= width - inset) return null
        return y === height - 1 || x === width - inset - 1 ? palette.shade : palette.body
      }),
    )
  }
  const seamY = Math.max(1, Math.floor(height * 0.28))
  const seam = pixels[seamY]
  if (seam) for (let x = 0; x < width; x++) if (seam[x]) seam[x] = palette.seam
  const eyeY = Math.floor(height * 0.52),
    eyeX = Math.floor(width * 0.3)
  for (let y = eyeY; y < eyeY + (rows === 7 ? 3 : 2); y++) {
    const row = pixels[y]
    if (!row) continue
    for (let dx = 0; dx < (rows === 7 ? 2 : 1); dx++) {
      row[eyeX + dx] = null
      row[width - 1 - eyeX - dx] = null
    }
  }
  const led = pixels[height - (rows === 7 ? 3 : 2)]
  if (led) led[Math.floor(width / 2)] = palette.green

  // One terminal row stores two pixel rows with half-block glyphs, never a bitmap.
  const result: string[] = []
  for (let y = 0; y < height; y += 2) {
    let line = ''
    for (let x = 0; x < width; x++) {
      const top = pixels[y]?.[x] ?? null,
        bottom = pixels[y + 1]?.[x] ?? null
      if (top === bottom) line += top ? color('█', top) : ' '
      else if (!top) line += color('▄', bottom ?? palette.body)
      else if (!bottom) line += color('▀', top)
      else line += `${fg(top) + bg(bottom)}▀${reset}`
    }
    result.push(line)
  }
  return result
}

function pad(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width))
  return clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)))
}
function center(text: string, width: number): string {
  const left = Math.max(0, Math.floor((width - visibleWidth(text)) / 2))
  return pad(' '.repeat(left) + text, width)
}
function clean(text: string): string {
  return Array.from(text, (character) => {
    const code = character.codePointAt(0) ?? 0
    return code < 32 || code === 127 ? ' ' : character
  }).join('')
}

export class DockPreview implements Component, Focusable {
  readonly #rows: () => number
  readonly #requestRender: () => void
  readonly #input = new Input()
  #scene: PreviewScene = 'welcome'
  #logoRows: LogoRows = 5
  #effectiveLogoRows: LogoRows = 5
  #prompts: string[] = []
  #choice = 0
  #decision: string | undefined

  constructor(options: { rows: () => number; requestRender?: () => void }) {
    this.#rows = options.rows
    this.#requestRender = options.requestRender ?? (() => {})
    this.#input.onSubmit = (value) => {
      this.#prompts.push(clean(value.trim() || '把工具输出显示得更紧凑一些。'))
      this.#input.setValue('')
      this.#scene = 'chat'
      this.#decision = undefined
      this.#requestRender()
    }
  }
  get focused(): boolean {
    return this.#input.focused
  }
  set focused(value: boolean) {
    this.#input.focused = value
  }
  get scene(): PreviewScene {
    return this.#scene
  }
  get logoRows(): LogoRows {
    return this.#logoRows
  }
  get effectiveLogoRows(): LogoRows {
    return this.#effectiveLogoRows
  }
  setLogoRows(rows: LogoRows): void {
    this.#logoRows = rows
    this.#requestRender()
  }
  setScene(scene: PreviewScene): void {
    this.#scene = scene
    this.#decision = undefined
    this.#choice = 0
    if (scene === 'welcome') this.#prompts = []
    else if (!this.#prompts.length) this.#prompts = ['把工具输出显示得更紧凑一些。']
    this.#requestRender()
  }
  invalidate(): void {
    this.#input.invalidate()
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'f1')) this.setScene('welcome')
    else if (matchesKey(data, 'f2')) this.setScene('chat')
    else if (matchesKey(data, 'f3')) this.setScene('permission')
    else if (matchesKey(data, 'f4'))
      this.setLogoRows(this.#logoRows === 3 ? 5 : this.#logoRows === 5 ? 7 : 3)
    else if (this.#scene === 'permission') {
      if (matchesKey(data, Key.escape)) {
        this.#decision = 'Cancelled · preview only'
        this.#scene = 'chat'
      } else if (matchesKey(data, Key.up)) this.#choice = Math.max(0, this.#choice - 1)
      else if (matchesKey(data, Key.down)) this.#choice = Math.min(2, this.#choice + 1)
      else if (matchesKey(data, Key.enter) || /^[123]$/.test(data)) {
        if (/^[123]$/.test(data)) this.#choice = Number(data) - 1
        this.#decision = `${this.#choice === 2 ? 'Denied' : 'Allowed'} · preview only`
        this.#scene = 'chat'
      }
      this.#requestRender()
    } else {
      this.#input.handleInput(data)
      this.#requestRender()
    }
  }

  render(width: number): string[] {
    const height = Math.max(1, this.#rows()),
      inner = Math.max(1, width - 2)
    if (width < 32 || height < 14) {
      return ['Dock · UI preview', 'Enlarge the terminal', 'No backend', 'Ctrl+C exit']
        .slice(0, height)
        .map((line) => truncateToWidth(line, Math.max(1, width)))
    }
    const allowed: LogoRows = height >= 23 ? 7 : height >= 20 ? 5 : 3
    this.#effectiveLogoRows = Math.min(this.#logoRows, allowed) as LogoRows
    const compact = height < 20
    const content = [...this.#welcome(inner, compact), ...this.#conversation(inner)]
    const footer = this.#footer(inner)
    // Keep the prompt visible. Extra document rows use the terminal's real scrollback.
    const empty = Math.max(0, height - 1 - content.length - footer.length)
    return [...content, ...Array<string>(empty).fill(''), ...footer].map(
      (line) => ` ${pad(line, inner)} `,
    )
  }

  #welcome(width: number, compact: boolean): string[] {
    const inside = width - 4
    const columns = width >= 76 && !compact
    const leftWidth = columns ? Math.min(48, Math.floor(inside * 0.43)) : inside
    const logo = renderCaseLogo(this.#effectiveLogoRows)
    const left = [
      color('Welcome back!', palette.text),
      ...(compact ? [] : ['']),
      ...logo,
      ...(compact ? [] : ['']),
      dim('deepseek-v4-flash'),
      dim('~/code/dock'),
    ]
    const right = [
      accent('Commands'),
      '',
      `/compact   ${dim('Compact context')}`,
      `/tasks     ${dim('View subagents')}`,
      `/subtask   ${dim('Fork a task')}`,
      '',
      dim('Local UI preview'),
      dim('No model or tools connected'),
    ]
    const title = ` Dock ${dim('v0.0.0')} `
    const top =
      accent('╭─') + title + accent(`${'─'.repeat(Math.max(0, width - visibleWidth(title) - 3))}╮`)
    const body = Array.from(
      { length: Math.max(left.length, columns ? right.length : 0) },
      (_, i) => {
        const a = center(left[i] ?? '', leftWidth)
        const line = columns ? a + dim(' │ ') + pad(right[i] ?? '', inside - leftWidth - 3) : a
        return `${accent('│')} ${pad(line, inside)} ${accent('│')}`
      },
    )
    return [top, ...body, accent(`╰${'─'.repeat(width - 2)}╯`)]
  }

  #conversation(width: number): string[] {
    if (this.#scene === 'welcome') return []
    const result: string[] = ['', '']
    for (const prompt of this.#prompts) {
      result.push(...new Text(`❯ ${prompt}`, 0, 0).render(width), '')
      result.push('● 我先看看现有的显示逻辑。', '')
      result.push(`● Read ${dim('src/ui/dock-tui-app.ts')}`)
      result.push(dim('  └ Read 1 file'), '')
      result.push(`● Edit ${dim('src/ui/themes.ts')}`)
      if (this.#scene === 'permission') result.push(dim('  └ Waiting for approval'))
      else {
        result.push(dim(`  └ ${this.#decision ?? 'Updated styles (example)'}`), '')
        if (!this.#decision) result.push('● 工具名与结果保留，辅助信息使用灰色。')
      }
      result.push('')
    }
    return result
  }

  #footer(width: number): string[] {
    const status = this.#scene === 'permission' ? 'permission required' : 'ready'
    const size =
      this.#effectiveLogoRows === this.#logoRows
        ? `logo ${this.#logoRows} rows`
        : `logo ${this.#effectiveLogoRows}/${this.#logoRows} rows (fitted)`
    const input =
      this.#scene === 'permission'
        ? `❯ ${dim('Waiting for approval…')}`
        : (this.#input.render(width)[0] ?? '> ').replace(/^>/, '❯')
    const rows = [
      dim(`${status} · No backend`) +
        ' '.repeat(Math.max(1, width - status.length - 14 - size.length)) +
        dim(size),
      dim('─'.repeat(width)),
      input,
      dim('─'.repeat(width)),
      dim('F1 Start  F2 Chat  F3 Permission  F4 Logo'),
      dim('Ctrl+C Exit  ·  Preview only'),
    ]
    if (this.#scene === 'permission') {
      rows.push('', accent('Allow this edit?'), dim('Main agent · Edit · src/ui/themes.ts'))
      for (const [i, label] of [
        'Allow once',
        'Allow this call for this session',
        'Deny',
      ].entries()) {
        const line = `${(i === this.#choice ? '❯ ' : '  ') + (i + 1)}. ${label}`
        rows.push(i === this.#choice ? accent(line) : dim(line))
      }
    }
    return rows.map((line) => truncateToWidth(line, width))
  }
}

export function startTuiPreview(options: { terminal?: Terminal; onStop?: () => void } = {}) {
  const terminal = options.terminal ?? new ProcessTerminal()
  const tui = new TuiMainScreen(terminal)
  tui.setClearOnShrink(true)
  const preview = new DockPreview({
    rows: () => terminal.rows,
    requestRender: () => tui.requestRender(),
  })
  tui.addChild(preview)
  tui.setFocus(preview)
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    tui.stop()
    options.onStop?.()
  }
  tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl('c')) || matchesKey(data, Key.ctrl('d'))) {
      stop()
      return { consume: true }
    }
    return undefined
  })
  tui.start()
  terminal.setTitle('Dock UI Preview')
  return { tui, preview, stop }
}
