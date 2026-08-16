import { DockPreview, startTuiPreview, type LogoRows } from '../src/ui/preview/dock-preview.js'

const logoArg = process.argv.find((value) => /^--logo=(3|5|7)$/.test(value))
const logoRows = Number(logoArg?.split('=')[1] ?? 5) as LogoRows
if (process.argv.includes('--snapshot')) {
  const preview = new DockPreview({ rows: () => 30 })
  preview.setLogoRows(logoRows)
  process.stdout.write(`${preview.render(100).join('\n')}\n`)
} else {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('The UI preview needs a terminal. Use --snapshot for a static ANSI frame.')
  }
  const app = startTuiPreview({ onStop: () => process.exit(0) })
  app.preview.setLogoRows(logoRows)
  process.on('SIGTERM', app.stop)
  process.on('SIGINT', app.stop)
}
