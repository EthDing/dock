import type { BashSandboxRuntime } from '../tools/bash-tool.js'
import { join, resolve } from 'node:path'
import {
  SandboxManager,
  type SandboxAskCallback,
  type SandboxRuntimeConfig,
  type WrapWithSandboxOptions,
} from '@anthropic-ai/sandbox-runtime'
import type { DockSettings } from '../config/load-settings.js'
import { getApiKeyEnvironmentName } from '../model/create-model-adapter.js'
import { matchesCommandSpecifier } from '../permissions/specifier-matching.js'

export type BashSandboxInput = {
  command?: string
  dangerouslyDisableSandbox?: boolean
}

export type DockSandboxMode = 'off' | 'auto-allow' | 'regular-permissions'

export type SandboxManagerApi = {
  annotateStderrWithSandboxFailures: (command: string, stderr: string) => string
  checkDependencies: () => { errors: string[]; warnings: string[] }
  cleanupAfterCommand: () => void
  initialize: (
    config: SandboxRuntimeConfig,
    callback?: SandboxAskCallback,
    enableLogMonitor?: boolean,
  ) => Promise<void>
  isSupportedPlatform: () => boolean
  reset: () => Promise<void>
  updateConfig: (config: SandboxRuntimeConfig) => void
  wrapWithSandbox: (
    command: string,
    shell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    signal?: AbortSignal,
    options?: WrapWithSandboxOptions,
  ) => Promise<string>
}

type SandboxSettings = NonNullable<DockSettings['sandbox']>

export class DockSandbox {
  #config: SandboxRuntimeConfig
  readonly #manager: SandboxManagerApi
  readonly #settings: SandboxSettings
  #askCallback: SandboxAskCallback | undefined
  #enabled = false
  #initialized = false
  #activeCommands = 0
  #pendingReset = false
  #resetting: Promise<void> | undefined
  #unavailableReason: string | undefined

  constructor(options: {
    config: SandboxRuntimeConfig
    manager?: SandboxManagerApi
    settings: SandboxSettings
  }) {
    this.#config = options.config
    this.#manager = options.manager ?? SandboxManager
    this.#settings = options.settings
  }

  get isEnabled(): boolean {
    return this.#enabled
  }

  get unavailableReason(): string | undefined {
    return this.#unavailableReason
  }

  get autoAllowBashIfSandboxed(): boolean {
    return this.#enabled && (this.#settings.autoAllowBashIfSandboxed ?? true)
  }

  get mode(): DockSandboxMode {
    if (!this.#enabled) return 'off'
    return (this.#settings.autoAllowBashIfSandboxed ?? true) ? 'auto-allow' : 'regular-permissions'
  }

  async initialize(callback?: SandboxAskCallback): Promise<void> {
    if (callback) this.#askCallback = callback
    if (!this.#settings.enabled) return
    await this.#resetting
    if (this.#initialized) {
      this.#pendingReset = false
      this.#enabled = true
      return
    }
    this.#unavailableReason = undefined
    const unavailableReason = this.#getUnavailableReason()
    if (unavailableReason) {
      this.#unavailableReason = unavailableReason
      if (this.#settings.failIfUnavailable) throw new Error(unavailableReason)
      return
    }
    try {
      await this.#manager.initialize(this.#config, this.#askCallback)
      this.#initialized = true
      this.#enabled = true
      this.#unavailableReason = undefined
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.#unavailableReason = `Sandbox failed to initialize: ${detail}`
      if (this.#settings.failIfUnavailable) throw new Error(this.#unavailableReason)
    }
  }

  async setMode(mode: DockSandboxMode): Promise<void> {
    if (mode === 'off') {
      this.#settings.enabled = false
      if (this.#enabled) await this.reset()
      return
    }
    this.#settings.enabled = true
    this.#settings.autoAllowBashIfSandboxed = mode === 'auto-allow'
    if (!this.#enabled) await this.initialize()
    if (!this.#enabled) {
      throw new Error(this.#unavailableReason ?? 'Sandbox is unavailable')
    }
  }

  shouldUseSandbox(input: BashSandboxInput): boolean {
    if (!this.#enabled || !input.command) return false
    if (input.dangerouslyDisableSandbox && (this.#settings.allowUnsandboxedCommands ?? true)) {
      return false
    }
    return !(this.#settings.excludedCommands ?? []).some((pattern) =>
      matchesCommandSpecifier(pattern, input.command ?? ''),
    )
  }

  forCwd(cwd: string): BashSandboxRuntime {
    return {
      shouldUseSandbox: (input) => this.shouldUseSandbox(input),
      wrapCommand: (command, signal, id) => this.wrapCommand(command, signal, id, cwd),
      annotateFailure: (command, stderr) => this.annotateFailure(command, stderr),
      cleanupAfterCommand: () => this.cleanupAfterCommand(),
    }
  }

  async wrapCommand(
    command: string,
    signal: AbortSignal,
    commandId: string,
    cwd?: string,
  ): Promise<string> {
    if (!this.#enabled) return command
    // Tool permissions decide whether Bash may run; sandbox-runtime separately
    // constrains the process after that decision. Neither layer substitutes for
    // explicit deny rules or the other's enforcement boundary.
    this.#activeCommands++
    const customConfig = cwd
      ? {
          filesystem: {
            ...this.#config.filesystem,
            allowWrite: unique([...this.#config.filesystem.allowWrite, resolve(cwd)]),
            denyWrite: unique([
              ...this.#config.filesystem.denyWrite,
              join(cwd, '.dock', 'settings.json'),
              join(cwd, '.dock', 'settings.local.json'),
            ]),
          },
        }
      : undefined
    try {
      return await this.#manager.wrapWithSandbox(command, '/bin/bash', customConfig, signal, {
        commandId,
        commandText: command,
      })
    } catch (error) {
      this.cleanupAfterCommand()
      throw error
    }
  }

  annotateFailure(command: string, stderr: string): string {
    return this.#manager.annotateStderrWithSandboxFailures(command, stderr)
  }

  cleanupAfterCommand(): void {
    this.#activeCommands = Math.max(0, this.#activeCommands - 1)
    if (this.#activeCommands !== 0 || !this.#initialized) return
    // Helpers are process-wide; one child's completion must not tear down another.
    this.#manager.cleanupAfterCommand()
    if (this.#pendingReset)
      void this.reset().catch((error) => {
        this.#unavailableReason = String(error)
      })
  }

  updateConfig(config: SandboxRuntimeConfig): void {
    this.#config = config
    this.#manager.updateConfig(config)
  }

  async reset(): Promise<void> {
    this.#enabled = false
    if (!this.#initialized) return this.#resetting
    if (this.#activeCommands > 0) {
      this.#pendingReset = true
      return
    }
    this.#pendingReset = false
    this.#initialized = false
    this.#resetting = this.#manager.reset()
    await this.#resetting
  }

  #getUnavailableReason(): string | undefined {
    if (!this.#manager.isSupportedPlatform()) return 'Sandbox is not supported on this platform'
    const dependencies = this.#manager.checkDependencies()
    return dependencies.errors.length > 0
      ? `Sandbox dependencies are missing: ${dependencies.errors.join(', ')}`
      : undefined
  }
}

export function createSandboxRuntimeConfig(options: {
  cwd: string
  homeDir: string
  settings: DockSettings
}): SandboxRuntimeConfig {
  const cwd = resolve(options.cwd)
  const credentialPath = join(options.homeDir, '.dock', '.credentials.json')
  const filesystem = options.settings.sandbox?.filesystem
  const network = options.settings.sandbox?.network
  const apiKeyEnvironmentVariables = Object.values(options.settings.providers ?? {}).flatMap(
    (provider) =>
      provider.protocol
        ? [getApiKeyEnvironmentName({ ...provider, protocol: provider.protocol })]
        : [],
  )
  const allowedDomains = permissionDomains(options.settings.permissions?.allow, 'WebFetch')
  const deniedDomains = permissionDomains(options.settings.permissions?.deny, 'WebFetch')

  return {
    credentials: {
      envVars: [...new Set(apiKeyEnvironmentVariables)].map((name) => ({ mode: 'deny', name })),
      files: [{ mode: 'deny', path: credentialPath }],
    },
    filesystem: {
      ...(filesystem?.allowRead ? { allowRead: filesystem.allowRead } : {}),
      allowWrite: unique([cwd, ...(filesystem?.allowWrite ?? [])]),
      denyRead: unique([...(filesystem?.denyRead ?? []), credentialPath]),
      denyWrite: unique([
        ...(filesystem?.denyWrite ?? []),
        join(options.homeDir, '.dock', 'settings.json'),
        credentialPath,
        join(cwd, '.dock', 'settings.json'),
        join(cwd, '.dock', 'settings.local.json'),
      ]),
    },
    network: {
      ...(network?.allowLocalBinding !== undefined
        ? { allowLocalBinding: network.allowLocalBinding }
        : {}),
      ...(network?.allowUnixSockets ? { allowUnixSockets: network.allowUnixSockets } : {}),
      allowedDomains: unique([...(network?.allowedDomains ?? []), ...allowedDomains]),
      deniedDomains: unique([...(network?.deniedDomains ?? []), ...deniedDomains]),
    },
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function permissionDomains(rules: readonly string[] | undefined, toolName: string): string[] {
  return (rules ?? []).flatMap((rule) => {
    const match = rule.match(/^([^()]+)\(domain:([^()]+)\)$/)
    return match?.[1]?.trim() === toolName && match[2] ? [match[2].trim()] : []
  })
}
