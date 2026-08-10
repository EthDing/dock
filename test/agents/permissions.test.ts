import { describe, expect, it } from 'vitest'
import { PermissionBroker } from '../../src/permissions/permission-broker.js'
import type { AgentTool } from '../../src/tools/types.js'
const tool: AgentTool = {
  name: 'Write',
  description: 'Write',
  inputSchema: {},
  isConcurrencySafe: () => false,
  execute: async () => ({ content: '' }),
}
describe('subagent permission routing', () => {
  it('serializes dialogs, carries agent labels, and cancels queued requests promptly', async () => {
    const broker = new PermissionBroker(),
      calls: string[] = []
    let finish!: (value: { behavior: 'allow_once' }) => void
    broker.setHandler((request) => {
      calls.push(request.requester?.label ?? 'main')
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const first = broker.requestApproval(
      tool,
      {},
      { behavior: 'ask', source: 'fallback' },
      new AbortController().signal,
      { agentId: 'a', label: 'Worker A' },
    )
    await Promise.resolve()
    await Promise.resolve()
    const abort = new AbortController()
    const second = broker.requestApproval(
      tool,
      {},
      { behavior: 'ask', source: 'fallback' },
      abort.signal,
      { agentId: 'b', label: 'Worker B' },
    )
    abort.abort()
    await expect(second).resolves.toEqual({ behavior: 'deny' })
    expect(calls).toEqual(['Worker A'])
    finish({ behavior: 'allow_once' })
    await expect(first).resolves.toEqual({ behavior: 'allow_once' })
  })
})
