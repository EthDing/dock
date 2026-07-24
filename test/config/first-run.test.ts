import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runFirstRunOnboarding, type OnboardingPrompter } from '../../src/config/first-run.js'

class ScriptedPrompter implements OnboardingPrompter {
  readonly messages: string[] = []
  readonly #inputs: string[]
  readonly #selections: string[]

  constructor(options: { inputs: string[]; selections: string[] }) {
    this.#inputs = [...options.inputs]
    this.#selections = [...options.selections]
  }

  async input(): Promise<string> {
    return this.#inputs.shift() ?? ''
  }

  async select(): Promise<string> {
    const value = this.#selections.shift()
    if (!value) throw new Error('No scripted selection remains')
    return value
  }

  showMessage(message: string): void {
    this.messages.push(message)
  }
}

describe('first-run onboarding', () => {
  it('creates a usable provider configuration without storing the API key', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'dock-onboarding-'))
    const prompter = new ScriptedPrompter({
      inputs: ['', 'claude-sonnet-test', '', ''],
      selections: ['anthropic-messages'],
    })

    const result = await runFirstRunOnboarding({ homeDir, prompter })
    const saved = JSON.parse(
      await readFile(join(homeDir, '.dock', 'settings.json'), 'utf8'),
    ) as Record<string, unknown>

    expect(result).toEqual({
      apiKeyEnvironmentVariable: 'ANTHROPIC_API_KEY',
      modelReference: 'anthropic:claude-sonnet-test',
    })
    expect(saved).toEqual({
      model: 'anthropic:claude-sonnet-test',
      providers: {
        anthropic: {
          apiKeyEnv: 'ANTHROPIC_API_KEY',
          protocol: 'anthropic-messages',
        },
      },
    })
    expect(JSON.stringify(saved)).not.toContain('sk-')
  })

  it('preserves existing user settings while adding a custom provider', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'dock-onboarding-'))
    const configDirectory = join(homeDir, '.dock')
    await mkdir(configDirectory, { recursive: true })
    await writeFile(
      join(configDirectory, 'settings.json'),
      JSON.stringify({ permissions: { defaultMode: 'plan', deny: ['Read(.env)'] } }),
    )
    const prompter = new ScriptedPrompter({
      inputs: ['gateway', 'model-v1', 'https://models.example.test/v1', 'GATEWAY_API_KEY'],
      selections: ['openai-chat-completions'],
    })

    await runFirstRunOnboarding({ homeDir, prompter })
    const saved = JSON.parse(
      await readFile(join(configDirectory, 'settings.json'), 'utf8'),
    ) as Record<string, unknown>

    expect(saved).toMatchObject({
      model: 'gateway:model-v1',
      permissions: { defaultMode: 'plan', deny: ['Read(.env)'] },
      providers: {
        gateway: {
          apiKeyEnv: 'GATEWAY_API_KEY',
          baseUrl: 'https://models.example.test/v1',
          protocol: 'openai-chat-completions',
        },
      },
    })
  })

  it('keeps prompting until required setup values are valid', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'dock-onboarding-'))
    const prompter = new ScriptedPrompter({
      inputs: [
        'bad:name',
        'gateway',
        '',
        'model-v1',
        'ftp://invalid.test',
        'https://models.example.test/v1',
        '1INVALID',
        'GATEWAY_API_KEY',
      ],
      selections: ['openai-responses'],
    })

    const result = await runFirstRunOnboarding({ homeDir, prompter })

    expect(result.modelReference).toBe('gateway:model-v1')
    expect(prompter.messages).toHaveLength(4)
  })
})
