import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@dock/tui'
import { accent, muted, paint, uiPalette } from './presentation.js'
export const selectListTheme: SelectListTheme = {
  description: muted,
  noMatch: muted,
  scrollInfo: muted,
  selectedPrefix: accent,
  selectedText: accent,
}
export const editorTheme: EditorTheme = { borderColor: muted, selectList: selectListTheme }
export const markdownTheme: MarkdownTheme = {
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  italic: muted,
  code: (text) => paint(text, uiPalette.body),
  codeBlock: (text) => text,
  codeBlockBorder: muted,
  heading: accent,
  hr: muted,
  link: accent,
  linkUrl: muted,
  listBullet: muted,
  quote: muted,
  quoteBorder: muted,
  strikethrough: muted,
  underline: (text) => `\x1b[4m${text}\x1b[24m`,
}
