import { stripVTControlCharacters } from 'node:util'
import { visibleWidth, type Terminal } from '@dock/tui'
import { describe, expect, it } from 'vitest'
import { DockPreview, renderCaseLogo, startTuiPreview } from '../../src/ui/preview/dock-preview.js'

describe('real terminal preview', () => {
  it.each([3, 5, 7] as const)(
    'renders the mascot in exactly %i character rows without image protocols',
    (rows) => {
      const lines = renderCaseLogo(rows)
      expect(lines).toHaveLength(rows)
      expect(lines.every((line) => visibleWidth(line) === rows * 3 + 3)).toBe(true)
      expect(lines.join('')).toContain('\x1b[38;2;')
      for (const marker of ['\x1b_G', '\x1b]1337', 'base64', 'data:image'])
        expect(lines.join('')).not.toContain(marker)
      expect(stripVTControlCharacters(lines.join(''))).toMatch(/[▀▄█]/)
    },
  )
  it('fits narrow and short terminals and keeps requested versus actual rows explicit', () => {
    for (const width of [1, 16, 32, 54, 80, 120]) {
      for (const rows of [1, 8, 14, 24, 42]) {
        const preview = new DockPreview({ rows: () => rows })
        preview.setLogoRows(7)
        for (const scene of ['welcome', 'chat', 'permission'] as const) {
          preview.setScene(scene)
          const lines = preview.render(width)
          expect(
            lines.every((line) => visibleWidth(line) <= width),
            `${width}x${rows} ${scene}`,
          ).toBe(true)
          if (scene === 'welcome') expect(lines.length).toBeLessThanOrEqual(rows)
        }
      }
    }
    const preview = new DockPreview({ rows: () => 16 })
    preview.setLogoRows(7)
    preview.render(80)
    expect(preview.effectiveLogoRows).toBe(3)
  })
  it('puts permission choices in document flow after the input, not in a covering overlay', () => {
    const preview = new DockPreview({ rows: () => 24 })
    preview.setScene('permission')
    const lines = preview.render(96).map(stripVTControlCharacters)
    const input = lines.findIndex((line) => line.startsWith(' ›'))
    const permission = lines.findIndex((line) => line.includes('Allow this edit?'))
    expect(permission).toBeGreaterThan(input)
    expect(lines.some((line) => line.includes('No backend'))).toBe(true)
    preview.handleInput('\x1b')
    expect(preview.scene).toBe('chat')
  })
  it('uses the actual pi-tui renderer, handles F4 and typed input, and closes cleanly', () => {
    let input: ((data: string) => void) | undefined
    let stopped = false
    const terminal: Terminal = {
      columns: 100,
      rows: 30,
      kittyProtocolActive: false,
      start(onInput) {
        input = onInput
      },
      stop() {
        stopped = true
      },
      async drainInput() {},
      write() {},
      moveBy() {},
      hideCursor() {},
      showCursor() {},
      clearLine() {},
      clearFromCursor() {},
      clearScreen() {},
      setTitle() {},
      setProgress() {},
    }
    const app = startTuiPreview({ terminal })
    input?.('\x1bOS')
    expect(app.preview.logoRows).toBe(7)
    input?.('hello preview')
    input?.('\r')
    expect(app.preview.scene).toBe('chat')
    expect(stripVTControlCharacters(app.preview.render(100).join('\n'))).toContain('hello preview')
    expect(stripVTControlCharacters(app.preview.render(100).join('\n'))).not.toContain('❯ >')
    app.stop()
    expect(stopped).toBe(true)
  })
})

it('uses a compact unframed Dock identity and puts command hints by the input', () => {
  const preview = new DockPreview({ rows: () => 30 })
  const output = preview.render(110)
  const plain = output.map(stripVTControlCharacters)
  expect(preview.logoRows).toBe(5)
  expect(plain.join('\n')).not.toMatch(/[╭╮╰╯]/)
  expect(plain.join('\n')).not.toContain('Welcome back!')
  expect(plain.join('\n')).not.toContain('Commands')
  expect(output.join('')).not.toContain('218;138;102')
  const title = plain.findIndex((line) => line.includes('Dock'))
  const logoTop = plain.findIndex((line) => /[▀▄█]/.test(line))
  expect(Math.abs(title - logoTop)).toBeLessThanOrEqual(1)
  const input = plain.findIndex((line) => line.startsWith(' ›'))
  expect(plain.findIndex((line) => line.includes('/compact'))).toBeGreaterThan(input)
})
