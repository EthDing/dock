import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@dock/tui'

const identity = (text: string) => text

export const selectListTheme: SelectListTheme = {
  description: identity,
  noMatch: identity,
  scrollInfo: identity,
  selectedPrefix: identity,
  selectedText: identity,
}

export const editorTheme: EditorTheme = {
  borderColor: identity,
  selectList: selectListTheme,
}

export const markdownTheme: MarkdownTheme = {
  bold: identity,
  code: identity,
  codeBlock: identity,
  codeBlockBorder: identity,
  heading: identity,
  hr: identity,
  italic: identity,
  link: identity,
  linkUrl: identity,
  listBullet: identity,
  quote: identity,
  quoteBorder: identity,
  strikethrough: identity,
  underline: identity,
}
