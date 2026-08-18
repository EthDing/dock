import { expect, it } from 'vitest'
import { ToolComponent } from '../../src/ui/components/transcript.js'
import { safeText } from '../../src/ui/presentation.js'

it('removes terminal control payloads while preserving normal text and line breaks', () => {
  const text = safeText('hello\x1b]52;c;ZXhmaWw=\x07\x1b[2J\x1b[31mred\x1b[0m\n中文')
  expect(text).toBe('hellored\n中文')
})
it('sanitizes the tool name as well as its arguments and output', () => {
  const component = new ToolComponent(
    {
      status: 'denied',
      revision: 0,
      call: {
        type: 'tool_use',
        id: 'call',
        name: 'Read\x1b]52;c;ZXZpbA==\x07',
        input: { file_path: 'file\x1b[2J' },
      },
      result: { type: 'tool_result', toolUseId: 'call', isError: true, content: 'Denied\x1b[2J' },
    },
    () => true,
  )
  const rendered = component.render(80).join('\n')
  expect(rendered).not.toContain('\x1b]52;')
  expect(rendered).not.toContain('\x1b[2J')
  expect(rendered).toContain('Denied')
})
it('keeps a failed command termination visible in the three-line compact result', () => {
  const component = new ToolComponent(
    {
      status: 'error',
      revision: 0,
      call: { type: 'tool_use', id: 'bash', name: 'Bash', input: { command: 'build' } },
      result: {
        type: 'tool_result',
        toolUseId: 'bash',
        isError: true,
        content: 'log1\nlog2\nlog3\nerror detail\nExit code 7',
      },
    },
    () => false,
  )
  const rendered = component.render(80).join('\n')
  expect(rendered).toContain('Exit code 7')
  expect(rendered).toContain('error detail')
  expect(rendered).not.toContain('log1')
})
