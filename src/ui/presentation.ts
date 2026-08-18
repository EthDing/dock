import { stripVTControlCharacters } from 'node:util'
export const uiPalette = {
  body: '242;239;231',
  shade: '187;188;186',
  seam: '83;84;82',
  green: '103;207;149',
  accent: '124;190;163',
  text: '216;216;211',
  muted: '139;147;147',
  error: '235;130;125',
}
export const reset = '\x1b[0m'
export const fg = (rgb: string) => `\x1b[38;2;${rgb}m`
export const bg = (rgb: string) => `\x1b[48;2;${rgb}m`
export const paint = (text: string, rgb: string) => fg(rgb) + text + reset
export const muted = (text: string) => paint(text, uiPalette.muted)
export const accent = (text: string) => paint(text, uiPalette.accent)
export function safeText(value: unknown): string {
  return Array.from(stripVTControlCharacters(String(value)), (c) => {
    const n = c.codePointAt(0) ?? 0
    return (n < 32 && n !== 9 && n !== 10) || (n >= 127 && n <= 159) ? '' : c
  }).join('')
}
