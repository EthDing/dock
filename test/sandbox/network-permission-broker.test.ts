import { describe, expect, it, vi } from 'vitest'
import { SandboxNetworkPermissionBroker } from '../../src/sandbox/network-permission-broker.js'

describe('SandboxNetworkPermissionBroker', () => {
  it('coalesces concurrent requests for the same host', async () => {
    const broker = new SandboxNetworkPermissionBroker()
    const handler = vi.fn(async () => ({ allow: true, persist: false }))
    broker.setHandler(handler)

    const [first, second] = await Promise.all([
      broker.request({ host: 'example.com', port: 443 }),
      broker.request({ host: 'example.com', port: 443 }),
    ])

    expect(first).toEqual({ allow: true, persist: false })
    expect(second).toEqual(first)
    expect(handler).toHaveBeenCalledOnce()
  })
})
