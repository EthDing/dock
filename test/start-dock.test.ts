import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Terminal } from '@dock/tui'
import { describe, expect, it } from 'vitest'
import type { OnboardingPrompter } from '../src/config/first-run.js'
import { startDock } from '../src/start-dock.js'

class ExitTerminal implements Terminal {
  columns = 80
  rows = 24
  kittyProtocolActive = false
  start(onInput: (data: string) => void): void {
    queueMicrotask(() => onInput('\u0003'))
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

describe('startDock', () => {
  it('fails before terminal startup when no model is configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-start-'))

    await expect(
      startDock({ args: [], cwd: root, environment: {}, homeDir: join(root, 'home') }),
    ).rejects.toThrow('No model configured')
  })

  it('runs first-use onboarding before entering the TUI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-start-'))
    const homeDir = join(root, 'home')
    const inputs = ['', 'claude-test-model', '', '']
    const onboardingPrompter: OnboardingPrompter = {
      input: async () => inputs.shift() ?? '',
      select: async () => 'anthropic-messages',
    }

    await startDock({
      args: [],
      cwd: root,
      environment: { ANTHROPIC_API_KEY: 'test-key' },
      homeDir,
      onboardingPrompter,
      terminal: new ExitTerminal(),
    })

    await expect(readFile(join(homeDir, '.dock', 'settings.json'), 'utf8')).resolves.toContain(
      'anthropic:claude-test-model',
    )
  })

  it('keeps the generated configuration and explains a missing credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-start-'))
    const homeDir = join(root, 'home')
    const inputs = ['', 'claude-test-model', '', '']

    await expect(
      startDock({
        args: [],
        cwd: root,
        environment: {},
        homeDir,
        onboardingPrompter: {
          input: async () => inputs.shift() ?? '',
          select: async () => 'anthropic-messages',
        },
      }),
    ).rejects.toThrow('Configuration saved. Set ANTHROPIC_API_KEY')
    await expect(readFile(join(homeDir, '.dock', 'settings.json'), 'utf8')).resolves.toContain(
      'anthropic:claude-test-model',
    )
  })
})
