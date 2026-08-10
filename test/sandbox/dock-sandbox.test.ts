import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { DockSettings } from '../../src/config/load-settings.js'
import {
  createSandboxRuntimeConfig,
  DockSandbox,
  type SandboxManagerApi,
} from '../../src/sandbox/dock-sandbox.js'

function createManager(options: { dependencyErrors?: string[] } = {}): SandboxManagerApi {
  return {
    annotateStderrWithSandboxFailures: (_command, stderr) => stderr,
    checkDependencies: () => ({ errors: options.dependencyErrors ?? [], warnings: [] }),
    cleanupAfterCommand: vi.fn(),
    initialize: vi.fn(async () => {}),
    isSupportedPlatform: () => true,
    reset: vi.fn(async () => {}),
    updateConfig: vi.fn(),
    wrapWithSandbox: vi.fn(async (command) => `sandbox(${command})`),
  }
}

describe('createSandboxRuntimeConfig', () => {
  it('translates Dock settings and protects Dock credentials', () => {
    const cwd = '/work/project'
    const homeDir = '/home/user'
    const settings: DockSettings = {
      providers: {
        deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY', protocol: 'openai-responses' },
      },
      sandbox: {
        filesystem: {
          allowWrite: ['/tmp/build'],
          denyRead: ['secrets'],
          denyWrite: ['generated.lock'],
        },
        network: {
          allowedDomains: ['github.com'],
          deniedDomains: ['blocked.example'],
        },
      },
    }

    const config = createSandboxRuntimeConfig({ cwd, homeDir, settings })

    expect(config.filesystem.allowWrite).toEqual([cwd, '/tmp/build'])
    expect(config.filesystem.denyRead).toContain('secrets')
    expect(config.filesystem.denyRead).toContain(join(homeDir, '.dock', '.credentials.json'))
    expect(config.filesystem.denyWrite).toEqual(
      expect.arrayContaining([
        'generated.lock',
        join(homeDir, '.dock', 'settings.json'),
        join(cwd, '.dock', 'settings.local.json'),
      ]),
    )
    expect(config.network).toMatchObject({
      allowedDomains: ['github.com'],
      deniedDomains: ['blocked.example'],
    })
    expect(config.credentials?.envVars).toContainEqual({
      mode: 'deny',
      name: 'DEEPSEEK_API_KEY',
    })
  })
})

it('shares initialization but keeps per-command cwd config and drains concurrent commands', async () => {
  const manager = createManager()
  const sandbox = new DockSandbox({
    config: createSandboxRuntimeConfig({ cwd: '/main', homeDir: '/home/u', settings: {} }),
    manager,
    settings: { enabled: true },
  })
  await sandbox.initialize()
  const a = sandbox.forCwd('/child-a'),
    b = sandbox.forCwd('/child-b')
  await a.wrapCommand('pwd', new AbortController().signal, 'a')
  await b.wrapCommand('pwd', new AbortController().signal, 'b')
  expect(manager.initialize).toHaveBeenCalledTimes(1)
  expect(manager.updateConfig).not.toHaveBeenCalled()
  const calls = vi.mocked(manager.wrapWithSandbox).mock.calls
  expect(calls[0]?.[2]?.filesystem?.allowWrite).toContain('/child-a')
  expect(calls[0]?.[2]?.filesystem?.allowWrite).not.toContain('/child-b')
  a.cleanupAfterCommand()
  expect(manager.cleanupAfterCommand).not.toHaveBeenCalled()
  await sandbox.setMode('off')
  expect(manager.reset).not.toHaveBeenCalled()
  b.cleanupAfterCommand()
  await Promise.resolve()
  expect(manager.reset).toHaveBeenCalledTimes(1)
})

describe('DockSandbox', () => {
  it('wraps commands only after successful opt-in initialization', async () => {
    const manager = createManager()
    const sandbox = new DockSandbox({
      config: createSandboxRuntimeConfig({ cwd: '/work', homeDir: '/home/user', settings: {} }),
      manager,
      settings: { enabled: true },
    })
    await sandbox.initialize(async () => false)

    expect(sandbox.shouldUseSandbox({ command: 'pnpm test' })).toBe(true)
    await expect(
      sandbox.wrapCommand('pnpm test', new AbortController().signal, 'tool-1'),
    ).resolves.toBe('sandbox(pnpm test)')
    expect(manager.wrapWithSandbox).toHaveBeenCalledWith(
      'pnpm test',
      '/bin/bash',
      undefined,
      expect.any(AbortSignal),
      { commandId: 'tool-1', commandText: 'pnpm test' },
    )
  })

  it('falls back or fails according to failIfUnavailable', async () => {
    const fallback = new DockSandbox({
      config: createSandboxRuntimeConfig({ cwd: '/work', homeDir: '/home/user', settings: {} }),
      manager: createManager({ dependencyErrors: ['bubblewrap missing'] }),
      settings: { enabled: true },
    })
    await fallback.initialize(async () => false)
    expect(fallback.isEnabled).toBe(false)
    expect(fallback.unavailableReason).toContain('bubblewrap missing')

    const required = new DockSandbox({
      config: createSandboxRuntimeConfig({ cwd: '/work', homeDir: '/home/user', settings: {} }),
      manager: createManager({ dependencyErrors: ['bubblewrap missing'] }),
      settings: { enabled: true, failIfUnavailable: true },
    })
    await expect(required.initialize(async () => false)).rejects.toThrow('bubblewrap missing')
  })

  it('honors excluded commands and the configured escape hatch', async () => {
    const sandbox = new DockSandbox({
      config: createSandboxRuntimeConfig({ cwd: '/work', homeDir: '/home/user', settings: {} }),
      manager: createManager(),
      settings: {
        allowUnsandboxedCommands: true,
        enabled: true,
        excludedCommands: ['docker *'],
      },
    })
    await sandbox.initialize(async () => false)

    expect(sandbox.shouldUseSandbox({ command: 'docker ps' })).toBe(false)
    expect(
      sandbox.shouldUseSandbox({ command: 'pnpm test', dangerouslyDisableSandbox: true }),
    ).toBe(false)
  })

  it('can enable regular or auto-allow mode and disable again', async () => {
    const manager = createManager()
    const sandbox = new DockSandbox({
      config: createSandboxRuntimeConfig({ cwd: '/work', homeDir: '/home/user', settings: {} }),
      manager,
      settings: {},
    })
    await sandbox.initialize(async () => false)

    await sandbox.setMode('regular-permissions')
    expect(sandbox.isEnabled).toBe(true)
    expect(sandbox.autoAllowBashIfSandboxed).toBe(false)

    await sandbox.setMode('auto-allow')
    expect(sandbox.autoAllowBashIfSandboxed).toBe(true)

    await sandbox.setMode('off')
    expect(sandbox.isEnabled).toBe(false)
    expect(manager.reset).toHaveBeenCalledOnce()
  })
})
