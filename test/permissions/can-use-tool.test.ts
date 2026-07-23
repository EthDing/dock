import { describe, expect, it, vi } from 'vitest'
import { createCanUseTool } from '../../src/permissions/can-use-tool.js'
import type { AgentTool } from '../../src/tools/types.js'
import { asMessageUuid } from '../../src/sessions/ids.js'

const tool = (name: string, readOnly: boolean): AgentTool => ({
  description: name,
  execute: async () => ({ content: '' }),
  getPermissionSubject: () => ({
    isInWorkingDirectory: true,
    isReadOnly: readOnly,
    matchesSpecifier: () => false,
    name,
    requiresBypassConfirmation: false,
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
})
