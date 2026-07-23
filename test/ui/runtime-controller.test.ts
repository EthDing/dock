import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeController, type RuntimeSession } from '../../src/ui/runtime-controller.js'

function createSession(label: string): RuntimeSession & { closed: boolean } {
  let permissionMode = 'default'
  return {
    abort: vi.fn(),
    close: vi.fn(async function (this: { closed: boolean }) {
      this.closed = true
    }),
    closed: false,
    compact: vi.fn(async () => {}),
    contextSummary: () => label,
    messages: [],
    get permissionMode() {
      return permissionMode
    },
    rename: vi.fn(async () => {}),
    rewind: vi.fn(async () => {}),
    rewindPoints: () => [{ label, uuid: randomUUID() }],
    setPermissionMode(mode) {
      permissionMode = mode
    },
    async *submit() {},
  }
}

describe('RuntimeController', () => {
  it('closes the previous session and delegates to the replacement', async () => {
    const first = createSession('first')
    const second = createSession('second')
    const runtime = new RuntimeController(first)

    await runtime.replace(async () => second)
    runtime.setPermissionMode('plan')

    expect(first.closed).toBe(true)
    expect(runtime.contextSummary()).toBe('second')
    expect(runtime.permissionMode).toBe('plan')
  })
})
