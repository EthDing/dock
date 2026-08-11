import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSandboxRuntimeConfig, DockSandbox } from '../../src/sandbox/dock-sandbox.js'
import { createBashTool } from '../../src/tools/bash-tool.js'
import { asMessageUuid } from '../../src/sessions/ids.js'

const describeLinux =
  process.platform === 'linux' && process.env.DOCK_SANDBOX_INTEGRATION === '1'
    ? describe
    : describe.skip

describeLinux('sandbox integration', () => {
  it('allows workspace writes while blocking outside writes and credential reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-sandbox-integration-'))
    const cwd = join(root, 'project')
    const outside = join(root, 'outside')
    const homeDir = join(root, 'home')
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(outside, { recursive: true }),
      mkdir(join(homeDir, '.dock'), { recursive: true }),
    ])
    await writeFile(join(homeDir, '.dock', '.credentials.json'), 'sandbox-secret')
    const settings = { sandbox: { enabled: true } }
    const sandbox = new DockSandbox({
      config: createSandboxRuntimeConfig({ cwd, homeDir, settings }),
      settings: settings.sandbox,
    })
    await sandbox.initialize(async () => false)
    expect(sandbox.isEnabled, sandbox.unavailableReason).toBe(true)
    const bash = createBashTool({ cwd, homeDir, sandbox })
    const execution = {
      parentMessageUuid: asMessageUuid('a0000000-0000-4000-8000-000000000001'),
      signal: new AbortController().signal,
      toolUseId: 'sandbox-tool',
    }

    try {
      const insideResult = await bash.execute(
        { command: `printf inside > ${JSON.stringify(join(cwd, 'inside.txt'))}` },
        execution,
      )
      expect(insideResult.isError).not.toBe(true)
      await expect(readFile(join(cwd, 'inside.txt'), 'utf8')).resolves.toBe('inside')

      const outsideResult = await bash.execute(
        { command: `printf outside > ${JSON.stringify(join(outside, 'blocked.txt'))}` },
        execution,
      )
      expect(outsideResult.isError).toBe(true)
      await expect(access(join(outside, 'blocked.txt'))).rejects.toMatchObject({ code: 'ENOENT' })

      const credentialResult = await bash.execute(
        { command: `cat ${JSON.stringify(join(homeDir, '.dock', '.credentials.json'))}` },
        execution,
      )
      expect(credentialResult.isError).toBe(true)
      expect(credentialResult.content).not.toContain('sandbox-secret')
    } finally {
      await sandbox.reset()
    }
  })

  it('routes network access through the host approval callback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-sandbox-network-'))
    const cwd = join(root, 'project')
    const homeDir = join(root, 'home')
    await mkdir(cwd, { recursive: true })
    let allowNetwork = false
    const requestedHosts: string[] = []
    const settings = { sandbox: { enabled: true } }
    const sandbox = new DockSandbox({
      config: createSandboxRuntimeConfig({ cwd, homeDir, settings }),
      settings: settings.sandbox,
    })
    await sandbox.initialize(async ({ host }) => {
      requestedHosts.push(host)
      return allowNetwork
    })
    expect(sandbox.isEnabled, sandbox.unavailableReason).toBe(true)
    const bash = createBashTool({ cwd, homeDir, sandbox })
    const execution = {
      parentMessageUuid: asMessageUuid('a0000000-0000-4000-8000-000000000002'),
      signal: new AbortController().signal,
      toolUseId: 'network-tool',
    }

    try {
      const denied = await bash.execute(
        { command: 'curl -fsS --max-time 10 https://example.com -o /dev/null' },
        execution,
      )
      expect(denied.isError).toBe(true)
      allowNetwork = true
      const allowed = await bash.execute(
        { command: 'curl -fsS --max-time 10 https://example.com -o /dev/null' },
        execution,
      )
      expect(allowed.isError).not.toBe(true)
      expect(requestedHosts).toContain('example.com')
    } finally {
      await sandbox.reset()
    }
  })
  it('runs simultaneous commands with scoped child cwd configurations on one initialized runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-sandbox-children-')),
      cwd = join(root, 'main'),
      a = join(root, 'a'),
      b = join(root, 'b'),
      homeDir = join(root, 'home')
    await Promise.all([cwd, a, b].map((path) => mkdir(path, { recursive: true })))
    const sandbox = new DockSandbox({
      settings: { enabled: true },
      config: createSandboxRuntimeConfig({ cwd, homeDir, settings: {} }),
    })
    await sandbox.initialize(async () => false)
    expect(sandbox.isEnabled, sandbox.unavailableReason).toBe(true)
    try {
      const execution = {
        parentMessageUuid: asMessageUuid('a0000000-0000-4000-8000-000000000003'),
        signal: new AbortController().signal,
        toolUseId: 'a',
      }
      const results = await Promise.all([
        createBashTool({ cwd: a, homeDir, sandbox: sandbox.forCwd(a) }).execute(
          { command: 'printf child-a > own.txt' },
          execution,
        ),
        createBashTool({ cwd: b, homeDir, sandbox: sandbox.forCwd(b) }).execute(
          { command: 'printf child-b > own.txt' },
          { ...execution, toolUseId: 'b' },
        ),
      ])
      expect(results.every((r) => !r.isError)).toBe(true)
      expect(await readFile(join(a, 'own.txt'), 'utf8')).toBe('child-a')
      expect(await readFile(join(b, 'own.txt'), 'utf8')).toBe('child-b')
    } finally {
      await sandbox.reset()
    }
  })
})
