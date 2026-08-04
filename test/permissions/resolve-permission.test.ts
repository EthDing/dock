import { describe, expect, it, vi } from 'vitest'
import {
  filterDeniedTools,
  resolvePermission,
  type PermissionMode,
  type PermissionResult,
} from '../../src/permissions/evaluate-permission.js'
import type { AgentTool } from '../../src/tools/types.js'

const createTool = (result: PermissionResult, checkPermissions = vi.fn(async () => result)) =>
  ({
    checkPermissions,
    description: 'Test tool',
    execute: async () => ({ content: '' }),
    inputSchema: { type: 'object' },
    isConcurrencySafe: () => false,
    name: 'Bash',
    parseInput: (input) => input,
  }) satisfies AgentTool

const decide = (
  tool: AgentTool,
  options: {
    allow?: string[]
    ask?: string[]
    deny?: string[]
    mode?: PermissionMode
  } = {},
) =>
  resolvePermission(
    tool,
    {},
    {
      mode: options.mode ?? 'default',
      rules: {
        ...(options.allow ? { allow: options.allow } : {}),
        ...(options.ask ? { ask: options.ask } : {}),
        ...(options.deny ? { deny: options.deny } : {}),
      },
    },
  )

describe('resolvePermission', () => {
  it('checks whole-tool deny and ask before the tool implementation', async () => {
    const deniedCheck = vi.fn(async () => ({ behavior: 'allow' as const, source: 'tool' as const }))
    await expect(
      decide(createTool({ behavior: 'allow', source: 'tool' }, deniedCheck), { deny: ['Bash'] }),
    ).resolves.toMatchObject({ behavior: 'deny', rule: 'Bash', source: 'rule' })
    expect(deniedCheck).not.toHaveBeenCalled()

    const askedCheck = vi.fn(async () => ({ behavior: 'allow' as const, source: 'tool' as const }))
    await expect(
      decide(createTool({ behavior: 'allow', source: 'tool' }, askedCheck), { ask: ['Bash'] }),
    ).resolves.toMatchObject({ behavior: 'ask', rule: 'Bash', source: 'rule' })
    expect(askedCheck).not.toHaveBeenCalled()
  })

  it('preserves tool denies and forced asks before bypass mode', async () => {
    await expect(
      decide(createTool({ behavior: 'deny', message: 'blocked', source: 'tool' }), {
        mode: 'bypassPermissions',
      }),
    ).resolves.toMatchObject({ behavior: 'deny', message: 'blocked' })

    await expect(
      decide(createTool({ behavior: 'ask', message: 'critical', source: 'circuit_breaker' }), {
        mode: 'bypassPermissions',
      }),
    ).resolves.toMatchObject({ behavior: 'ask', source: 'circuit_breaker' })
  })

  it('applies bypass and whole-tool allow after tool-specific checks', async () => {
    const passthrough = createTool({ behavior: 'passthrough', source: 'tool' })

    await expect(decide(passthrough, { mode: 'bypassPermissions' })).resolves.toMatchObject({
      behavior: 'allow',
      source: 'mode',
    })
    await expect(decide(passthrough, { allow: ['Bash'] })).resolves.toMatchObject({
      behavior: 'allow',
      rule: 'Bash',
      source: 'rule',
    })
  })

  it('turns passthrough into ask and applies dontAsk last', async () => {
    const passthrough = createTool({ behavior: 'passthrough', source: 'tool' })

    await expect(decide(passthrough)).resolves.toMatchObject({
      behavior: 'ask',
      source: 'fallback',
    })
    await expect(decide(passthrough, { mode: 'dontAsk' })).resolves.toMatchObject({
      behavior: 'deny',
      source: 'mode',
    })
    await expect(decide(passthrough, { mode: 'plan' })).resolves.toMatchObject({
      behavior: 'deny',
      source: 'mode',
    })
    await expect(decide(passthrough, { allow: ['Bash'], mode: 'plan' })).resolves.toMatchObject({
      behavior: 'allow',
      source: 'rule',
    })
  })
})

describe('filterDeniedTools', () => {
  it('removes bare and whole-tool wildcard denies but keeps content-scoped denies', () => {
    const bash = createTool({ behavior: 'passthrough', source: 'tool' })
    const read = { ...bash, name: 'Read' }

    expect(filterDeniedTools([bash, read], { deny: ['Bash'] }).map((tool) => tool.name)).toEqual([
      'Read',
    ])
    expect(filterDeniedTools([bash, read], { deny: ['Bash(*)'] }).map((tool) => tool.name)).toEqual(
      ['Read'],
    )
    expect(
      filterDeniedTools([bash, read], { deny: ['Bash(git push *)'] }).map((tool) => tool.name),
    ).toEqual(['Bash', 'Read'])
  })
})
