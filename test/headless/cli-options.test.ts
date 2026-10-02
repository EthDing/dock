import { describe, expect, it } from 'vitest'
import { combineHeadlessPrompt, parseCliOptions } from '../../src/cli-options.js'

describe('headless CLI options', () => {
  it('parses print mode and its execution options', () => {
    expect(
      parseCliOptions([
        '-p',
        '--model',
        'deepseek:deepseek-v4-pro',
        '--permission-mode',
        'acceptEdits',
        '--max-turns',
        '3',
        '--output-format',
        'stream-json',
        '--no-memory',
        'fix the tests',
      ]),
    ).toMatchObject({
      print: true,
      prompt: 'fix the tests',
      model: 'deepseek:deepseek-v4-pro',
      permissionMode: 'acceptEdits',
      maxTurns: 3,
      outputFormat: 'stream-json',
      noMemory: true,
    })
  })

  it('keeps existing interactive options unchanged', () => {
    expect(
      parseCliOptions(['--continue', '--fork-session', '--resume', 'named', '--name', 'run']),
    ).toEqual({
      continueSession: true,
      forkSession: true,
      name: 'run',
      noMemory: false,
      outputFormat: 'text',
      print: false,
      resume: 'named',
    })
  })

  it('rejects invalid or interactive-only combinations', () => {
    expect(() => parseCliOptions(['-p', '--max-turns', '0', 'task'])).toThrow(
      '--max-turns requires a positive integer',
    )
    expect(() => parseCliOptions(['--max-turns', '2'])).toThrow(
      '--max-turns is only available with --print',
    )
    expect(() => parseCliOptions(['--output-format', 'yaml', '-p', 'task'])).toThrow(
      'Unknown output format yaml',
    )
    expect(() => parseCliOptions(['task'])).toThrow('A prompt argument requires --print')
    expect(() => parseCliOptions(['-p', 'one', 'two'])).toThrow(
      'Print mode accepts only one prompt argument',
    )
  })

  it('combines piped input before the explicit prompt', () => {
    expect(combineHeadlessPrompt('Explain the error', 'test output\n')).toBe(
      'test output\n\nExplain the error',
    )
    expect(combineHeadlessPrompt(undefined, 'piped prompt\n')).toBe('piped prompt')
    expect(() => combineHeadlessPrompt(undefined, '')).toThrow('Print mode requires a prompt')
  })
})
