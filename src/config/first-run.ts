import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'
import {
  readSettingsFile,
  type DockSettings,
  type ProviderProtocol,
  type ProviderSettings,
} from './load-settings.js'

export type OnboardingChoice = {
  description: string
  label: string
  value: string
}

export type OnboardingPrompter = {
  input: (message: string, options?: { defaultValue?: string }) => Promise<string>
  select: (message: string, choices: readonly OnboardingChoice[]) => Promise<string>
  showMessage?: (message: string) => void
}

export type FirstRunResult = {
  apiKeyEnvironmentVariable: string
  modelReference: string
}

const PROTOCOL_CHOICES: readonly OnboardingChoice[] = [
  {
    description: 'Direct Anthropic Messages API',
    label: 'Anthropic Messages',
    value: 'anthropic-messages',
  },
  {
    description: 'OpenAI Responses API or a compatible endpoint',
    label: 'OpenAI Responses',
    value: 'openai-responses',
  },
  {
    description: 'OpenAI-compatible Chat Completions endpoint',
    label: 'OpenAI Chat Completions',
    value: 'openai-chat-completions',
  },
]

const PROTOCOL_DEFAULTS: Record<
  ProviderProtocol,
  { apiKeyEnvironmentVariable: string; providerName: string }
> = {
  'anthropic-messages': {
    apiKeyEnvironmentVariable: 'ANTHROPIC_API_KEY',
    providerName: 'anthropic',
  },
  'openai-chat-completions': {
    apiKeyEnvironmentVariable: 'OPENAI_API_KEY',
    providerName: 'openai-compatible',
  },
  'openai-responses': {
    apiKeyEnvironmentVariable: 'OPENAI_API_KEY',
    providerName: 'openai',
  },
}

export async function runFirstRunOnboarding(options: {
  homeDir: string
  prompter: OnboardingPrompter
}): Promise<FirstRunResult> {
  const selectedProtocol = await options.prompter.select(
    'Choose the model API protocol',
    PROTOCOL_CHOICES,
  )
  if (!isProviderProtocol(selectedProtocol)) {
    throw new Error(`Unsupported provider protocol ${selectedProtocol}`)
  }
  const defaults = PROTOCOL_DEFAULTS[selectedProtocol]
  const providerName = await promptUntilValid(
    options.prompter,
    'Provider name',
    (value) => validateProviderName(withDefault(value, defaults.providerName)),
    { defaultValue: defaults.providerName },
  )
  const modelId = await promptUntilValid(options.prompter, 'Model ID', (value) =>
    requireValue(value, 'Model ID'),
  )
  const baseUrl = await promptUntilValid(
    options.prompter,
    'Base URL (optional)',
    validateOptionalUrl,
  )
  const apiKeyEnvironmentVariable = await promptUntilValid(
    options.prompter,
    'API key environment variable',
    (value) => validateEnvironmentVariable(withDefault(value, defaults.apiKeyEnvironmentVariable)),
    { defaultValue: defaults.apiKeyEnvironmentVariable },
  )
  const modelReference = `${providerName}:${modelId}`
  const provider: ProviderSettings & { protocol: ProviderProtocol } = {
    apiKeyEnv: apiKeyEnvironmentVariable,
    ...(baseUrl ? { baseUrl } : {}),
    protocol: selectedProtocol,
  }
  await updateUserSettings(options.homeDir, {
    model: modelReference,
    provider,
    providerName,
  })
  return { apiKeyEnvironmentVariable, modelReference }
}

export async function runInteractiveFirstRunOnboarding(options: {
  homeDir: string
  input?: Readable
  output?: Writable
}): Promise<FirstRunResult> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const readline = createInterface({ input, output })
  const prompter: OnboardingPrompter = {
    async input(message, promptOptions) {
      const suffix = promptOptions?.defaultValue ? ` [${promptOptions.defaultValue}]` : ''
      return readline.question(`${message}${suffix}: `)
    },
    async select(message, choices) {
      output.write(`\n${message}:\n`)
      choices.forEach((choice, index) => {
        output.write(`  ${index + 1}. ${choice.label} — ${choice.description}\n`)
      })
      while (true) {
        const answer = (await readline.question(`Select [1-${choices.length}]: `)).trim()
        const index = Number.parseInt(answer, 10) - 1
        const choice = choices[index]
        if (choice) return choice.value
        output.write('Enter one of the listed numbers.\n')
      }
    },
    showMessage(message) {
      output.write(`${message}\n`)
    },
  }

  output.write('\nWelcome to Dock. Let’s configure your model provider.\n')
  try {
    const result = await runFirstRunOnboarding({ homeDir: options.homeDir, prompter })
    output.write(`\nSaved configuration to ${join(options.homeDir, '.dock', 'settings.json')}.\n`)
    return result
  } finally {
    readline.close()
  }
}

async function promptUntilValid<T>(
  prompter: OnboardingPrompter,
  message: string,
  validate: (value: string) => T,
  options?: { defaultValue?: string },
): Promise<T> {
  while (true) {
    try {
      return validate(await prompter.input(message, options))
    } catch (error) {
      prompter.showMessage?.(error instanceof Error ? error.message : String(error))
    }
  }
}

async function updateUserSettings(
  homeDir: string,
  update: {
    model: string
    provider: ProviderSettings & { protocol: ProviderProtocol }
    providerName: string
  },
): Promise<void> {
  const directory = join(homeDir, '.dock')
  const path = join(directory, 'settings.json')
  const existing = (await readSettingsFile(path)) ?? {}
  const settings: DockSettings = {
    ...existing,
    model: update.model,
    providers: {
      ...existing.providers,
      [update.providerName]: update.provider,
    },
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporaryPath = join(directory, `settings.${randomUUID()}.tmp`)
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
  await rename(temporaryPath, path)
}

function withDefault(value: string, defaultValue: string): string {
  return value.trim() || defaultValue
}

function requireValue(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required`)
  return normalized
}

function validateProviderName(value: string): string {
  const normalized = requireValue(value, 'Provider name')
  if (!/^[a-zA-Z0-9._-]+$/.test(normalized)) {
    throw new Error('Provider name may contain only letters, numbers, dot, underscore, and hyphen')
  }
  return normalized
}

function validateEnvironmentVariable(value: string): string {
  const normalized = requireValue(value, 'API key environment variable')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
    throw new Error(`Invalid environment variable name ${normalized}`)
  }
  return normalized
}

function validateOptionalUrl(value: string): string | undefined {
  const normalized = value.trim()
  if (!normalized) return undefined
  const url = new URL(normalized)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Base URL must use http or https')
  }
  return normalized
}

function isProviderProtocol(value: string): value is ProviderProtocol {
  return ['anthropic-messages', 'openai-responses', 'openai-chat-completions'].includes(value)
}
