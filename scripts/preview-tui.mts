import { startTuiPreview, type LogoRows } from '../src/ui/preview/dock-preview.js'
import { ProcessTerminal } from '@dock/tui'
const arg = process.argv.find((value) => /^--logo=(3|5|7)$/.test(value))
const logoRows = Number(arg?.split('=')[1] ?? 5) as LogoRows
if (process.argv.includes('--snapshot')) {
  const preview = startTuiPreview({ terminal: new ProcessTerminal(), start: false })
  preview.preview.setLogoRows(logoRows)
  process.stdout.write(`${preview.tui.render(100).join('\n')}\n`)
  await preview.stop()
} else {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('The UI preview needs a terminal.')
  const preview = startTuiPreview({ onStop: () => process.exit(0) })
  preview.preview.setLogoRows(logoRows)
  process.on('SIGTERM', () => {
    void preview.stop()
  })
  process.on('SIGINT', () => {
    void preview.stop()
  })
}
