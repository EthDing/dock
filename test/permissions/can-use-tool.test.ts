import { describe, expect, it, vi } from 'vitest'
import { createCanUseTool } from '../../src/permissions/can-use-tool.js'
import { findContentRule } from '../../src/permissions/evaluate-permission.js'
import { SessionPermissionState } from '../../src/permissions/session-permission-state.js'
import type { AgentTool } from '../../src/tools/types.js'
import { asMessageUuid } from '../../src/sessions/ids.js'

const tool = (
  name: string,
  readOnly: boolean,
  options: { destructive?: boolean; specifier?: string } = {},
): AgentTool => ({
  checkPermissions: (input, permissionContext) => {
    const matchesSpecifier = (pattern: string) => pattern === options.specifier
    const denyRule = findContentRule(permissionContext.rules, 'deny', name, matchesSpecifier)
    if (denyRule) return { behavior: 'deny', rule: denyRule, source: 'rule' }
    const askRule = findContentRule(permissionContext.rules, 'ask', name, matchesSpecifier)
    if (askRule) return { behavior: 'ask', rule: askRule, source: 'rule' }
    if (permissionContext.autoAllowInternalToolUse?.(tool(name, readOnly, options), input)) {
      return { behavior: 'allow', source: 'internal', updatedInput: input }
    }
    if (options.destructive) {
      return { behavior: 'ask', source: 'circuit_breaker' }
    }
    if (
      name === 'Bash' &&
      permissionContext.autoAllowBashIfSandboxed?.() === true &&
      permissionContext.isBashSandboxed?.(tool(name, readOnly, options), input) === true
    ) {
      return { behavior: 'allow', source: 'internal', updatedInput: input }
    }
    if (readOnly && permissionContext.mode !== 'dontAsk') {
      return { behavior: 'allow', source: 'tool', updatedInput: input }
    }
    if (permissionContext.mode === 'plan') {
      return { behavior: 'deny', source: 'mode' }
    }
    return { behavior: 'passthrough', source: 'tool', updatedInput: input }
  },
  description: name,
  execute: async () => ({ content: '' }),
  getPermissionRule: () => (options.specifier ? `${name}(${options.specifier})` : name),
  inputSchema: { type: 'object' },
  isConcurrencySafe: () => readOnly,
  name,
  parseInput: (input) => input,
})

const context = {
  parentMessageUuid: asMessageUuid('b0000000-0000-4000-8000-000000000001'),
  signal: new AbortController().signal,
  toolUseId: 'tool-1',
}

describe('createCanUseTool', () => {
  it('asks only when the policy returns ask', async () => {
    const requestApproval = vi.fn(async () => ({ behavior: 'allow_once' as const }))
    const canUseTool = createCanUseTool({ mode: 'default', requestApproval, rules: {} })

    await expect(canUseTool(tool('Read', true), {}, context)).resolves.toMatchObject({
      behavior: 'allow',
    })
    await expect(canUseTool(tool('Edit', false), {}, context)).resolves.toMatchObject({
      behavior: 'allow',
    })
    expect(requestApproval).toHaveBeenCalledTimes(1)
  })

  it('denies plan-mode writes without prompting', async () => {
    const requestApproval = vi.fn(async () => ({ behavior: 'allow_once' as const }))
    const canUseTool = createCanUseTool({ mode: 'plan', requestApproval, rules: {} })

    await expect(canUseTool(tool('Write', false), {}, context)).resolves.toMatchObject({
      behavior: 'deny',
    })
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it('auto-allows actually sandboxed Bash while preserving deny and circuit breakers', async () => {
    const requestApproval = vi.fn(async () => ({ behavior: 'allow_once' as const }))
    const canUseTool = createCanUseTool({
      autoAllowBashIfSandboxed: () => true,
      isBashSandboxed: () => true,
      mode: 'default',
      requestApproval,
      rules: { ask: ['Bash(*)'], deny: ['Bash(blocked)'] },
    })

    await expect(
      canUseTool(tool('Bash', false, { specifier: 'safe' }), { command: 'safe' }, context),
    ).resolves.toMatchObject({ behavior: 'allow' })
    await expect(
      canUseTool(tool('Bash', false, { specifier: 'blocked' }), { command: 'blocked' }, context),
    ).resolves.toMatchObject({ behavior: 'deny' })
    await expect(
      canUseTool(tool('Bash', false, { destructive: true }), { command: 'rm -rf /' }, context),
    ).resolves.toMatchObject({ behavior: 'allow' })

    expect(requestApproval).toHaveBeenCalledTimes(1)
  })

  it('reuses an exact session approval without overriding explicit deny', async () => {
    const requestApproval = vi.fn(async () => ({ behavior: 'allow_session' as const }))
    const sessionPermissions = new SessionPermissionState()
    const canUseTool = createCanUseTool({
      mode: 'default',
      requestApproval,
      rules: { deny: ['Edit(blocked)'] },
      sessionPermissions,
    })
    const edit = tool('Edit', false, { specifier: 'allowed' })

    await expect(canUseTool(edit, { file_path: '/work/a' }, context)).resolves.toMatchObject({
      behavior: 'allow',
    })
    await expect(canUseTool(edit, { file_path: '/work/a' }, context)).resolves.toMatchObject({
      behavior: 'allow',
    })
    await expect(canUseTool(edit, { file_path: '/work/b' }, context)).resolves.toMatchObject({
      behavior: 'allow',
    })
    expect(requestApproval).toHaveBeenCalledTimes(2)

    const denied = createCanUseTool({
      mode: 'default',
      requestApproval,
      rules: { deny: ['Edit(allowed)'] },
      sessionPermissions,
    })
    await expect(denied(edit, { file_path: '/work/a' }, context)).resolves.toMatchObject({
      behavior: 'deny',
    })
  })

  it('does not let a session approval override an explicit ask rule', async () => {
    const requestApproval = vi.fn(async () => ({ behavior: 'allow_session' as const }))
    const sessionPermissions = new SessionPermissionState()
    const edit = tool('Edit', false)
    const ordinary = createCanUseTool({
      mode: 'default',
      requestApproval,
      rules: {},
      sessionPermissions,
    })
    await ordinary(edit, { file_path: '/work/a' }, context)

    const explicitlyAsked = createCanUseTool({
      mode: 'default',
      requestApproval,
      rules: { ask: ['Edit'] },
      sessionPermissions,
    })
    await explicitlyAsked(edit, { file_path: '/work/a' }, context)

    expect(requestApproval).toHaveBeenCalledTimes(2)
  })

  it('persists an always-allow response and caches it for the active session', async () => {
    const persistApproval = vi.fn(async () => {})
    const requestApproval = vi.fn(async () => ({
      behavior: 'allow_always' as const,
      rule: 'Bash(pnpm test)',
    }))
    const sessionPermissions = new SessionPermissionState()
    const canUseTool = createCanUseTool({
      mode: 'default',
      persistApproval,
      requestApproval,
      rules: {},
      sessionPermissions,
    })
    const bash = tool('Bash', false)

    await canUseTool(bash, { command: 'pnpm test' }, context)
    await canUseTool(bash, { command: 'pnpm test' }, context)

    expect(persistApproval).toHaveBeenCalledOnce()
    expect(persistApproval).toHaveBeenCalledWith('Bash(pnpm test)')
    expect(requestApproval).toHaveBeenCalledOnce()
  })

  it('auto-allows internal calls across modes while preserving explicit rules', async () => {
    const requestApproval = vi.fn(async () => ({ behavior: 'allow_once' as const }))
    const internalWrite = tool('Write', false)
    const autoAllowInternalToolUse = () => true

    const plan = createCanUseTool({
      autoAllowInternalToolUse,
      mode: 'plan',
      requestApproval,
      rules: {},
    })
    await expect(
      plan(internalWrite, { file_path: '/memory/topic.md' }, context),
    ).resolves.toMatchObject({
      behavior: 'allow',
    })

    const denied = createCanUseTool({
      autoAllowInternalToolUse,
      mode: 'default',
      requestApproval,
      rules: { deny: ['Write'] },
    })
    await expect(
      denied(internalWrite, { file_path: '/memory/topic.md' }, context),
    ).resolves.toMatchObject({ behavior: 'deny' })

    const asked = createCanUseTool({
      autoAllowInternalToolUse,
      mode: 'default',
      requestApproval,
      rules: { ask: ['Write'] },
    })
    await expect(
      asked(internalWrite, { file_path: '/memory/topic.md' }, context),
    ).resolves.toMatchObject({
      behavior: 'allow',
    })
    expect(requestApproval).toHaveBeenCalledOnce()
  })
})
