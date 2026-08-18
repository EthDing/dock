import { type Component, truncateToWidth, visibleWidth } from '@dock/tui'
import type { SessionViewInfo } from '../contracts.js'
import {
  bg,
  paint as color,
  fg,
  muted,
  uiPalette as palette,
  reset,
  safeText,
} from '../presentation.js'
export type LogoRows = 3 | 5 | 7
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

export class Brand implements Component {
  constructor(
    readonly info: () => SessionViewInfo,
    readonly rows: () => number,
    readonly requested: () => LogoRows = () => 5,
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    const info = this.info(),
      height = this.rows(),
      size = Math.min(this.requested(), height < 20 ? 3 : 7) as LogoRows
    const logo = renderCaseLogo(size),
      logoWidth = size * 3 + 3
    const details = [
      `${color('Dock', palette.text)}  ${muted('0.0.0')}`,
      safeText(info.cwd),
      muted(safeText(info.modelReference)),
    ]
    if (width < 48)
      return [...logo, ...details, ''].map((line) => truncateToWidth(` ${line}`, width))
    return [
      '',
      ...logo.map(
        (line, i) =>
          `  ${line}${' '.repeat(Math.max(1, logoWidth - visibleWidth(line) + 4))}${details[i] ?? ''}`,
      ),
      '',
    ].map((line) => truncateToWidth(line, width))
  }
}
