import { expect, it } from 'vitest'
import { safeText } from '../../src/ui/presentation.js'
it('removes terminal control payloads while preserving normal text and line breaks', () => {
  const text = safeText('hello\x1b]52;c;ZXhmaWw=\x07\x1b[2J\x1b[31mred\x1b[0m\n中文')
  expect(text).toBe('hellored\n中文')
})
