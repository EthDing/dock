import { stripVTControlCharacters } from 'node:util'
import { visibleWidth } from '@dock/tui'
import { describe, expect, it } from 'vitest'
import { VirtualTerminal } from '../../packages/tui/test/virtual-terminal.js'
import { renderCaseLogo, startTuiPreview } from '../../src/ui/preview/dock-preview.js'
describe('shared real fullscreen preview', () => {
  it.each([3, 5, 7] as const)('renders exactly %i character rows without a bitmap', (rows) => {
    const lines = renderCaseLogo(rows)
    expect(lines).toHaveLength(rows)
    expect(lines.every((line) => visibleWidth(line) === rows * 3 + 3)).toBe(true)
    for (const marker of ['\x1b_G', '\x1b]1337', 'base64', 'data:image'])
      expect(lines.join('')).not.toContain(marker)
  })
  it('shares the real application layout, stays inside the screen, and uses five rows by default', async () => {
    const terminal = new VirtualTerminal(100, 30),
      preview = startTuiPreview({ terminal })
    expect(preview.preview.logoRows).toBe(5)
    await terminal.waitForRender()
    for (const [width, rows] of [
      [100, 30],
      [38, 15],
      [32, 10],
      [80, 24],
    ]) {
      terminal.resize(width ?? 80, rows ?? 24)
      await terminal.waitForRender()
      const lines = terminal.getViewport()
      expect(lines.every((line) => visibleWidth(line) <= (width ?? 80))).toBe(true)
      expect(lines.join('\n')).toContain('No backend')
    }
    const plain = stripVTControlCharacters(preview.tui.render(100).join('\n'))
    expect(plain).not.toContain('Welcome back!')
    expect(plain).not.toMatch(/[╭╮╰╯]/)
    expect(plain).toContain('Dock')
    terminal.sendInput('\x1bOS')
    expect(preview.preview.logoRows).toBe(7)
    await preview.stop()
  })
  it('routes the example permission through the same bottom panel and restores terminal state', async () => {
    const terminal = new VirtualTerminal(100, 28),
      preview = startTuiPreview({ terminal })
    const pending = preview.preview.setScene('permission')
    await new Promise((r) => setTimeout(r, 20))
    await terminal.waitForRender()
    expect(terminal.getViewport().join('\n')).toContain('Permission required')
    terminal.sendInput('\x1b')
    await pending
    await terminal.waitForRender()
    expect(stripVTControlCharacters(preview.tui.render(100).join('\n'))).toContain('Denied')
    await preview.stop()
  })
})
