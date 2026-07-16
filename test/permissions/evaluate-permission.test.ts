import { describe, expect, it } from 'vitest'
import {
  evaluatePermission,
  type PermissionMode,
  type PermissionSubject,
} from '../../src/permissions/evaluate-permission.js'

const subject = (
  name: string,
  options: {
    readOnly?: boolean
    specifier?: string
    requiresBypassConfirmation?: boolean
  } = {},
): PermissionSubject => ({
  isReadOnly: options.readOnly ?? false,
  matchesSpecifier: (pattern) => pattern === options.specifier,
  name,
  requiresBypassConfirmation: options.requiresBypassConfirmation ?? false,
})

const decide = (
  mode: PermissionMode,
  value: PermissionSubject,
  rules: { allow?: string[]; ask?: string[]; deny?: string[] } = {},
) => evaluatePermission({ mode, rules, subject: value }).behavior

describe('evaluatePermission', () => {
  it('evaluates deny before ask before allow', () => {
    const edit = subject('Edit', { specifier: 'src/**' })

    expect(
      decide('default', edit, {
        allow: ['Edit(src/**)'],
        ask: ['Edit(src/**)'],
        deny: ['Edit(src/**)'],
      }),
    ).toBe('deny')
    expect(
      decide('default', edit, {
        allow: ['Edit(src/**)'],
        ask: ['Edit(src/**)'],
      }),
    ).toBe('ask')
    expect(decide('default', edit, { allow: ['Edit(src/**)'] })).toBe('allow')
  })

  it.each([
    ['default', subject('Read', { readOnly: true }), 'allow'],
    ['default', subject('Edit'), 'ask'],
    ['acceptEdits', subject('Edit'), 'allow'],
    ['acceptEdits', subject('Bash'), 'ask'],
    ['plan', subject('Grep', { readOnly: true }), 'allow'],
    ['plan', subject('Write'), 'deny'],
    ['dontAsk', subject('Bash'), 'deny'],
    ['bypassPermissions', subject('Bash'), 'allow'],
  ] as const)('%s resolves %s as %s', (mode, value, behavior) => {
    expect(decide(mode, value)).toBe(behavior)
  })

  it('keeps explicit ask rules and destructive circuit breakers in bypass mode', () => {
    expect(decide('bypassPermissions', subject('Bash'), { ask: ['Bash'] })).toBe('ask')
    expect(decide('bypassPermissions', subject('Bash', { requiresBypassConfirmation: true }))).toBe(
      'ask',
    )
  })
})
