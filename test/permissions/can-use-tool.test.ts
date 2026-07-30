import { describe, expect, it, vi } from 'vitest'
import { createCanUseTool } from '../../src/permissions/can-use-tool.js'
import type { AgentTool } from '../../src/tools/types.js'
import { asMessageUuid } from '../../src/sessions/ids.js'

const tool = (
  name: string,
  readOnly: boolean,
  options: { destructive?: boolean; specifier?: string } = {},
): AgentTool => ({
  description: name,
  execute: async () => ({ content: '' }),
  getPermissionSubject: () => ({
    isInWorkingDirectory: true,
    isReadOnly: readOnly,
    matchesSpecifier: (pattern) => pattern === options.specifier,
    name,
    requiresBypassConfirmation: options.destructive ?? false,
  }),
  inputSchema: { type: 'object' },
  isConcurrencySafe: () => readOnly,
  name,
})

const context = {
  parentMessageUuid: asMessageUuid('b0000000-0000-4000-8000-000000000001'),
  signal: new AbortController().signal,
  toolUseId: 'tool-1',
}

describe('createCanUseTool', () => {
  it('asks only when the policy returns ask', async () => {
    const requestApproval = vi.fn(async () => true)
    const canUseTool = createCanUseTool({ mode: 'default', requestApproval, rules: {} })

    await expect(canUseTool(tool('Read', true), {}, context)).resolves.toEqual({
      behavior: 'allow',
    })
    await expect(canUseTool(tool('Edit', false), {}, context)).resolves.toEqual({
      behavior: 'allow',
    })
    expect(requestApproval).toHaveBeenCalledTimes(1)
  })

  it('denies plan-mode writes without prompting', async () => {
    const requestApproval = vi.fn(async () => true)
    const canUseTool = createCanUseTool({ mode: 'plan', requestApproval, rules: {} })

    await expect(canUseTool(tool('Write', false), {}, context)).resolves.toMatchObject({
      behavior: 'deny',
    })
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it('auto-allows actually sandboxed Bash while preserving deny and circuit breakers', async () => {
    const requestApproval = vi.fn(async () => true)
    const canUseTool = createCanUseTool({
      autoAllowBashIfSandboxed: () => true,
      isBashSandboxed: () => true,
      mode: 'default',
      requestApproval,
      rules: { ask: ['Bash(*)'], deny: ['Bash(blocked)'] },
    })

    await expect(
      canUseTool(tool('Bash', false, { specifier: 'safe' }), { command: 'safe' }, context),
    ).resolves.toEqual({ behavior: 'allow' })
    await expect(
      canUseTool(tool('Bash', false, { specifier: 'blocked' }), { command: 'blocked' }, context),
    ).resolves.toMatchObject({ behavior: 'deny' })
    await expect(
      canUseTool(tool('Bash', false, { destructive: true }), { command: 'rm -rf /' }, context),
    ).resolves.toEqual({ behavior: 'allow' })

    expect(requestApproval).toHaveBeenCalledTimes(1)
  })
})
