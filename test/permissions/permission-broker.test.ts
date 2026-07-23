import { describe, expect, it } from 'vitest'
import { PermissionBroker } from '../../src/permissions/permission-broker.js'
import type { AgentTool } from '../../src/tools/types.js'

const tool: AgentTool = {
  description: 'Write',
  execute: async () => ({ content: '' }),
  inputSchema: { type: 'object' },
  isConcurrencySafe: () => false,
  name: 'Write',
}

describe('PermissionBroker', () => {
  it('denies a pending approval when the turn is interrupted', async () => {
    const broker = new PermissionBroker()
    broker.setHandler(() => new Promise<boolean>(() => {}))
    const controller = new AbortController()

    const approval = broker.requestApproval(
      tool,
      {},
      { behavior: 'ask', source: 'mode' },
      controller.signal,
    )
    controller.abort('interrupt')

    await expect(approval).resolves.toBe(false)
  })
})
