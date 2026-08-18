import type { UUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ProcessTerminal, type Terminal, TuiAltScreen } from '@dock/tui'
import { SubagentManager } from './agents/manager.js'
import { type AgentPolicy, createSubagentRuntime } from './agents/runtime.js'
import { createAgentTools } from './agents/tools.js'
import { FileHistory } from './checkpoint/file-history.js'
import {
  loadProviderCredential,
  promptForProviderCredential,
  saveProviderCredential,
} from './config/credentials.js'
import {
  type FirstRunResult,
  type OnboardingPrompter,
  runFirstRunOnboarding,
  runInteractiveFirstRunOnboarding,
} from './config/first-run.js'
import { findProjectRoot, loadSettings, type ProviderSettings } from './config/load-settings.js'
import { ensureWorkspaceTrust } from './config/workspace-trust.js'
import { addLocalPermissionRule, updateLocalSandboxMode } from './config/write-settings.js'
import { compactConversation } from './context/compaction.js'
import { ContextManager } from './context/context-manager.js'
import { loadInstructionDocuments } from './context/load-instructions.js'
import { prepareFileRestoration } from './context/restore-context.js'
import { ExtractMemories } from './memory/extract-memories.js'
import { MemoryManager } from './memory/memory-manager.js'
import { MemoryNotificationBroker } from './memory/memory-notification-broker.js'
import { createModelAdapter, getApiKeyEnvironmentName } from './model/create-model-adapter.js'
import type { ModelAdapter } from './model/types.js'
import { createCanUseTool } from './permissions/can-use-tool.js'
import {
  filterDeniedTools,
  type PermissionMode,
  type PermissionRules,
  resolvePermission,
} from './permissions/evaluate-permission.js'
import { PermissionBroker } from './permissions/permission-broker.js'
import { PermissionModeState } from './permissions/permission-mode-state.js'
import { SessionPermissionState } from './permissions/session-permission-state.js'
import {
  createSandboxRuntimeConfig,
  DockSandbox,
  type SandboxManagerApi,
} from './sandbox/dock-sandbox.js'
import { SandboxNetworkPermissionBroker } from './sandbox/network-permission-broker.js'
import { SessionController } from './session-controller.js'
import { asSessionId, createSessionId, type SessionId } from './sessions/ids.js'
import { findMostRecentSession, forkSession, listSessions } from './sessions/session-manager.js'
import { getSessionPath, loadSession, SessionWriter } from './sessions/session-store.js'
import { createBashTool } from './tools/bash-tool.js'
import { FileReadState } from './tools/file-read-state.js'
import { createEditTool, createReadTool, createWriteTool } from './tools/file-tools.js'
import { createGlobTool, createGrepTool } from './tools/search-tools.js'
import type { AgentTool, CanUseTool } from './tools/types.js'
import { type DockSessionCommands, DockTuiApp } from './ui/dock-tui-app.js'
import { RuntimeController } from './ui/runtime-controller.js'

export type StartDockOptions = {
  args: readonly string[]
  cwd?: string
  credentialPrompter?: (message: string) => Promise<string>
  environment?: Record<string, string | undefined>
  homeDir?: string
  onboardingPrompter?: OnboardingPrompter
  sandboxManager?: SandboxManagerApi
  terminal?: Terminal
  workspaceTrustPrompter?: (workspace: string) => Promise<boolean>
}

export async function startDock(options: StartDockOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd()
  const homeDir = options.homeDir ?? homedir()
  const environment = options.environment ?? process.env
  const configDir = join(homeDir, '.dock')
  const cli = parseCliOptions(options.args)
  const projectRoot = await findProjectRoot(cwd)
  await ensureWorkspaceTrust({
    cwd,
    homeDir,
    ...(options.workspaceTrustPrompter ? { prompter: options.workspaceTrustPrompter } : {}),
    workspace: projectRoot,
  })
  let loadedSettings = await loadSettings({ cwd, homeDir })
  let initialModelReference = cli.model ?? loadedSettings.settings.model
  let firstRunResult: FirstRunResult | undefined
  if (!initialModelReference) {
    if (options.onboardingPrompter) {
      firstRunResult = await runFirstRunOnboarding({
        homeDir,
        prompter: options.onboardingPrompter,
      })
    } else if (process.stdin.isTTY && process.stdout.isTTY) {
      firstRunResult = await runInteractiveFirstRunOnboarding({ homeDir })
    } else {
      throw new Error(
        'No model configured and first-run setup requires an interactive terminal. Run dock in a terminal.',
      )
    }
    loadedSettings = await loadSettings({ cwd, homeDir })
    initialModelReference = loadedSettings.settings.model
    if (!initialModelReference) throw new Error('First-run setup did not configure a model')
  }

  const { providerName: initialProviderName } = parseModelReference(initialModelReference)
  const initialProvider = loadedSettings.settings.providers?.[initialProviderName]
  if (!initialProvider?.protocol) {
    throw new Error(`Provider ${initialProviderName} is missing a protocol`)
  }
  const initialConfiguredProvider = initialProvider as ProviderSettings & {
    protocol: NonNullable<ProviderSettings['protocol']>
  }
  const apiKeyEnvironmentVariable = getApiKeyEnvironmentName(initialConfiguredProvider)
  let storedApiKey = await loadProviderCredential({
    homeDir,
    providerName: initialProviderName,
  })
  const environmentApiKey = environment[apiKeyEnvironmentVariable]
  if (!storedApiKey && environmentApiKey && firstRunResult) {
    await saveProviderCredential({
      apiKey: environmentApiKey,
      homeDir,
      providerName: initialProviderName,
    })
    storedApiKey = environmentApiKey
  }
  if (!storedApiKey && !environmentApiKey) {
    if (options.credentialPrompter) {
      storedApiKey = await options.credentialPrompter(`API key for ${initialProviderName}: `)
    } else if (process.stdin.isTTY && process.stdout.isTTY) {
      storedApiKey = await promptForProviderCredential({
        message: `API key for ${initialProviderName}: `,
      })
    } else if (firstRunResult) {
      throw new Error(
        `Configuration saved. Run dock in an interactive terminal to store ${apiKeyEnvironmentVariable}.`,
      )
    } else {
      throw new Error(
        `No credential found for ${initialProviderName}. Run dock in an interactive terminal.`,
      )
    }
    await saveProviderCredential({
      apiKey: storedApiKey,
      homeDir,
      providerName: initialProviderName,
    })
  }

  const sandboxNetworkPermissionBroker = new SandboxNetworkPermissionBroker()
  const memoryNotificationBroker = new MemoryNotificationBroker()
  const memory = await MemoryManager.create({
    configDir,
    homeDir,
    projectRoot: loadedSettings.projectRoot,
    settings: loadedSettings.settings,
  })
  await memory.initialize()
  const sandbox = new DockSandbox({
    config: createSandboxRuntimeConfig({ cwd, homeDir, settings: loadedSettings.settings }),
    ...(options.sandboxManager ? { manager: options.sandboxManager } : {}),
    settings: loadedSettings.settings.sandbox ?? {},
  })
  await sandbox.initialize(async ({ host, port }) => {
    const response = await sandboxNetworkPermissionBroker.request({ host, port })
    if (response.allow && response.persist) {
      await addLocalPermissionRule({
        behavior: 'allow',
        projectRoot: loadedSettings.projectRoot,
        rule: `WebFetch(domain:${host})`,
      })
      loadedSettings = await loadSettings({ cwd, homeDir })
      sandbox.updateConfig(
        createSandboxRuntimeConfig({ cwd, homeDir, settings: loadedSettings.settings }),
      )
    }
    return response.allow
  })

  let sessionId = await resolveSessionId({
    configDir,
    continueSession: cli.continueSession,
    cwd,
    ...(cli.resume ? { resume: cli.resume } : {}),
  })
  if (sessionId && cli.forkSession) {
    const targetSessionId = createSessionId()
    await forkSession({
      configDir,
      cwd,
      sourceSessionId: sessionId,
      targetSessionId,
    })
    sessionId = targetSessionId
  }

  sessionId ??= createSessionId()
  const loadUserContext = async (contextCwd = cwd): Promise<Record<string, string>> => {
    const instructionDocuments = await loadInstructionDocuments({
      cwd: contextCwd,
      homeDir,
      projectRoot:
        contextCwd === cwd ? loadedSettings.projectRoot : await findProjectRoot(contextCwd),
    })
    const instructionContext = instructionDocuments
      .map((document) => `Contents of ${document.path}:\n\n${document.content}`)
      .join('\n\n')
    const memoryIndex = await memory.loadIndex()
    return {
      ...(instructionContext ? { AGENTS: instructionContext } : {}),
      ...(memoryIndex
        ? {
            AUTO_MEMORY: `Contents of ${memory.entrypoint} (auto memory index, persisted across conversations):\n\n${memoryIndex.content}`,
          }
        : {}),
    }
  }
  const permissionBroker = new PermissionBroker()
  const permissionMode =
    cli.permissionMode ?? loadedSettings.settings.permissions?.defaultMode ?? 'default'
  const permissionModeState = new PermissionModeState(permissionMode)
  const policies = new Map<SessionId, AgentPolicy>()
  const policyFor = (id: SessionId): AgentPolicy => {
    let policy = policies.get(id)
    if (!policy) {
      policy = {
        rules: {
          allow: loadedSettings.settings.permissions?.allow ?? [],
          ask: loadedSettings.settings.permissions?.ask ?? [],
          deny: loadedSettings.settings.permissions?.deny ?? [],
        },
        sessionPermissions: new SessionPermissionState(),
      }
      policies.set(id, policy)
    }
    return policy
  }
  const persistApproval = async (rule: string) => {
    await addLocalPermissionRule({
      behavior: 'allow',
      projectRoot: loadedSettings.projectRoot,
      rule,
    })
    loadedSettings = await loadSettings({ cwd, homeDir })
    for (const policy of policies.values()) {
      policy.rules.allow = loadedSettings.settings.permissions?.allow ?? []
      policy.rules.ask = loadedSettings.settings.permissions?.ask ?? []
      policy.rules.deny = loadedSettings.settings.permissions?.deny ?? []
    }
  }
  const resolveModel = async (reference: string) => {
    const { providerName } = parseModelReference(reference)
    const credential = await loadProviderCredential({ homeDir, providerName })
    return createConfiguredModel(
      reference,
      loadedSettings.settings.providers,
      environment,
      credential,
    )
  }
  const agents = new SubagentManager({
    configDir,
    projectCwd: cwd,
    backgroundEnabled: loadedSettings.settings.subagents?.backgroundEnabled,
    maxConcurrent: loadedSettings.settings.subagents?.maxConcurrent,
    maxDepth: loadedSettings.settings.subagents?.maxDepth,
    baseRef: loadedSettings.settings.worktree?.baseRef,
    createRuntime: (metadata, parent) =>
      createSubagentRuntime({
        metadata,
        parent,
        manager: agents,
        resolveModel,
        loadUserContext,
        policyFor,
        permissionMode: permissionModeState,
        permissionBroker,
        sandbox,
        memory,
        homeDir,
        persistApproval,
        transcriptPath: getSessionPath({
          configDir,
          cwd,
          sessionId: metadata.storageSessionId,
          agentId: metadata.id,
        }),
      }),
  })
  let currentCanUseTool: CanUseTool
  let currentAgentTool: AgentTool | undefined
  const createController = async (
    targetSessionId: SessionId,
    modelReference: string,
    name?: string,
  ): Promise<SessionController> => {
    const { model, modelId, provider } = await resolveModel(modelReference)
    await agents.loadSession(targetSessionId)
    const existing = await tryLoadSession({ configDir, cwd, sessionId: targetSessionId })
    const writer = existing
      ? await SessionWriter.open({ configDir, cwd, sessionId: targetSessionId })
      : await SessionWriter.create({ configDir, cwd, sessionId: targetSessionId })
    if (name) await writer.rename(name)

    const fileHistory = new FileHistory({
      configDir,
      cwd,
      onSnapshot: (snapshot, isUpdate) => writer.recordFileHistorySnapshot(snapshot, isUpdate),
      sessionId: targetSessionId,
      snapshots: existing?.fileHistorySnapshots ?? [],
    })
    const userContext = await loadUserContext()
    const memoryPrompt = memory.buildSystemPrompt()
    const readFileState = new FileReadState()
    const fileDependencies = {
      cwd,
      fileHistory,
      readFileState,
      writeLifecycle: {
        afterWrite: (filePath: string, content: string) => memory.inspectWrite(filePath, content),
        prepareWrite: (filePath: string, content: string) => memory.prepareWrite(filePath, content),
      },
    }
    const policy = policyFor(targetSessionId)
    const permissionRules: PermissionRules = policy.rules
    const tools = filterDeniedTools(
      [
        createReadTool(fileDependencies),
        createWriteTool(fileDependencies),
        createEditTool(fileDependencies),
        createGlobTool({ cwd }),
        createGrepTool({ cwd }),
        createBashTool({ cwd, homeDir, sandbox }),
        ...createAgentTools(agents),
      ],
      permissionRules,
    )
    const extractorFileDependencies = {
      cwd,
      // Background extraction must not mutate the foreground checkpoint state
      // or write file-history records concurrently with the session transcript.
      fileHistory: { trackEdit: async () => {} },
      readFileState: new FileReadState(),
      writeLifecycle: fileDependencies.writeLifecycle,
    }
    const extractorTools = filterDeniedTools(
      [
        createReadTool(extractorFileDependencies),
        createWriteTool(extractorFileDependencies),
        createEditTool(extractorFileDependencies),
        createGlobTool({ cwd }),
        createGrepTool({ cwd }),
        createBashTool({ cwd, homeDir, sandbox }),
        ...createAgentTools(agents),
      ],
      permissionRules,
    )
    const canUseTool = createCanUseTool({
      autoAllowInternalToolUse: (tool, input) =>
        typeof input.file_path === 'string' &&
        ((['Read', 'Write', 'Edit'].includes(tool.name) && memory.isMemoryPath(input.file_path)) ||
          (tool.name === 'Read' && agents.isOutputPath(targetSessionId, input.file_path))),
      autoAllowBashIfSandboxed: () => sandbox.autoAllowBashIfSandboxed,
      isBashSandboxed: (_tool, input) =>
        sandbox.shouldUseSandbox({
          ...(typeof input.command === 'string' ? { command: input.command } : {}),
          ...(typeof input.dangerouslyDisableSandbox === 'boolean'
            ? { dangerouslyDisableSandbox: input.dangerouslyDisableSandbox }
            : {}),
        }),
      mode: () => permissionModeState.value,
      persistApproval,
      requestApproval: (tool, input, decision, signal, identity) =>
        permissionBroker.requestApproval(tool, input, decision, signal, undefined, identity),
      rules: permissionRules,
      sessionPermissions: policy.sessionPermissions,
    })
    currentCanUseTool = canUseTool
    currentAgentTool = tools.find((t) => t.name === 'Agent')
    const contextManager = new ContextManager({
      contextWindow: provider.contextWindow ?? 200_000,
      maxOutputTokens: provider.maxOutputTokens ?? 8_192,
      toolResultClearing: loadedSettings.settings.contextManagement?.toolResultClearing,
      summarize: (input) => compactConversation({ ...input, model, transcriptPath: writer.path }),
      prepareRestoration: async (signal) => {
        const nextUserContext = await loadUserContext()
        const restored = await prepareFileRestoration({
          readFileState,
          signal,
          canRead: async (path) => {
            const readTool = tools.find((tool) => tool.name === 'Read')
            if (!readTool) return false
            const decision = await resolvePermission(
              readTool,
              { file_path: path },
              {
                rules: permissionRules,
                mode: permissionModeState.value,
                autoAllowInternalToolUse: (_tool, input) =>
                  typeof input.file_path === 'string' && memory.isMemoryPath(input.file_path),
              },
            )
            return decision.behavior === 'allow'
          },
        })
        return { ...restored, userContext: nextUserContext }
      },
    })
    const systemPrompt = [
      'You are Dock, an interactive coding agent. Read the project, use tools to act, and verify your work.',
      ...(memoryPrompt ? [memoryPrompt] : []),
    ]
    const extractMemories = memory.enabled
      ? new ExtractMemories({
          memory,
          model,
          modelId,
          onSaved: (paths) =>
            memoryNotificationBroker.notify({ paths, type: 'saved', sessionId: targetSessionId }),
          systemPrompt,
          tools: extractorTools,
          ...(Object.keys(userContext).length > 0 ? { userContext } : {}),
          ...(provider.maxOutputTokens ? { maxOutputTokens: provider.maxOutputTokens } : {}),
        })
      : undefined
    return new SessionController({
      getAgentIdentity: () => ({
        sessionId: targetSessionId,
        depth: 0,
        contextMode: 'main',
        cwd,
        modelReference,
        fileReadState: readFileState,
      }),
      inbox: {
        peek: (seen) => agents.pendingNotifications(targetSessionId, seen),
        ack: (ids) => agents.ackNotifications(targetSessionId, ids as readonly UUID[]),
      },
      canUseTool,
      contextManager,
      fileHistory,
      initialMessages: existing?.messages ?? [],
      initialDisplayMessages: existing?.displayMessages ?? [],
      ...(provider.maxOutputTokens ? { maxOutputTokens: provider.maxOutputTokens } : {}),
      model,
      modelId,
      permissionModeState,
      systemPrompt,
      tools,
      ...(extractMemories ? { turnComplete: extractMemories } : {}),
      ...(Object.keys(userContext).length > 0 ? { userContext } : {}),
      writer,
    })
  }

  let currentSessionId = sessionId
  let currentModelReference = initialModelReference
  const runtime = new RuntimeController(
    await createController(currentSessionId, currentModelReference, cli.name),
  )
  const sessionCommands: DockSessionCommands = {
    async branch(name) {
      const targetSessionId = createSessionId()
      await forkSession({
        configDir,
        cwd,
        ...(name ? { name } : {}),
        sourceSessionId: currentSessionId,
        targetSessionId,
      })
      await runtime.replace(() => createController(targetSessionId, currentModelReference))
      currentSessionId = targetSessionId
    },
    async clear() {
      const targetSessionId = createSessionId()
      await runtime.replace(() => createController(targetSessionId, currentModelReference))
      await agents.retargetAfterClear(currentSessionId, targetSessionId)
      currentSessionId = targetSessionId
    },
    async listSessions() {
      return (await listSessions({ configDir, cwd })).map((session) => ({
        label: session.name ?? session.firstPrompt ?? session.sessionId,
        value: session.sessionId,
      }))
    },
    async resume(idOrName) {
      const targetSessionId = await resolveSessionId({
        configDir,
        continueSession: false,
        cwd,
        resume: idOrName,
      })
      if (!targetSessionId || targetSessionId === currentSessionId) return
      await runtime.replace(() => createController(targetSessionId, currentModelReference))
      currentSessionId = targetSessionId
    },
    async setModel(reference) {
      await resolveModel(reference)
      if (reference === currentModelReference) return
      await runtime.replace(() => createController(currentSessionId, reference))
      currentModelReference = reference
    },
  }
  const tui = new TuiAltScreen(options.terminal ?? new ProcessTerminal())
  const sandboxCommands = {
    getMode: () => sandbox.mode,
    async setMode(mode: Parameters<DockSandbox['setMode']>[0]) {
      await sandbox.setMode(mode)
      await updateLocalSandboxMode({
        autoAllowBashIfSandboxed: mode !== 'regular-permissions',
        enabled: mode !== 'off',
        projectRoot: loadedSettings.projectRoot,
      })
      loadedSettings = await loadSettings({ cwd, homeDir })
    },
  }
  const app = new DockTuiApp({
    controller: runtime,
    agentCommands: {
      list: () => agents.list(currentSessionId),
      subscribe: (listener) => agents.subscribeUi(currentSessionId, listener),
      snapshot: (id) => agents.snapshot(currentSessionId, id),
      stop: (id) => agents.stop(currentSessionId, id, 'user'),
      send: (id, text) => agents.send(currentSessionId, id, text, { fromUser: true }),
      background: async () => {
        await agents.backgroundForeground(currentSessionId)
      },
      close: () => agents.close(),
      launch: async (prompt) => {
        if (!currentAgentTool?.parseInput) throw new Error('Agent is denied by permissions')
        const snapshot = runtime.getSnapshot()
        const input = currentAgentTool.parseInput({
          prompt,
          description: prompt.slice(0, 80),
          context: 'fork',
        })
        const controller = new AbortController()
        const permission = await currentCanUseTool(currentAgentTool, input, {
          agent: snapshot,
          signal: controller.signal,
          toolUseId: 'user-subtask',
          parentMessageUuid: snapshot.messages.at(-1)?.uuid ?? crypto.randomUUID(),
        })
        if (permission.behavior === 'deny') throw new Error(permission.message ?? 'Agent denied')
        return agents.spawn(
          snapshot,
          { prompt, description: prompt.slice(0, 80), context: 'fork' },
          { fromUser: true, signal: controller.signal },
        )
      },
    },
    memoryNotificationBroker,
    permissionBroker,
    sandboxNetworkPermissionBroker,
    sandboxCommands,
    sessionCommands,
    startupNotices: sandbox.unavailableReason ? [sandbox.unavailableReason] : [],
    tui,
  })
  agents.setWakeHandler((id) => {
    if (id === currentSessionId) app.notifyTasksChanged()
  })
  try {
    app.start()
    app.notifyTasksChanged()
    await app.waitUntilStopped()
  } finally {
    try {
      await app.stop()
    } finally {
      try {
        await agents.close()
      } finally {
        await sandbox.reset()
      }
    }
  }
}

function createConfiguredModel(
  modelReference: string,
  providers: Record<string, ProviderSettings> | undefined,
  environment: Record<string, string | undefined>,
  storedApiKey?: string,
): { model: ModelAdapter; modelId: string; provider: ProviderSettings } {
  const { modelId, providerName } = parseModelReference(modelReference)
  const provider = providers?.[providerName]
  if (!provider?.protocol) throw new Error(`Provider ${providerName} is missing a protocol`)
  const configuredProvider = provider as ProviderSettings & {
    protocol: NonNullable<ProviderSettings['protocol']>
  }
  return {
    model: createModelAdapter(configuredProvider, environment, storedApiKey),
    modelId,
    provider: configuredProvider,
  }
}

type CliOptions = {
  continueSession: boolean
  forkSession: boolean
  model?: string
  name?: string
  permissionMode?: PermissionMode
  resume?: string
}

function parseCliOptions(args: readonly string[]): CliOptions {
  const result: CliOptions = { continueSession: false, forkSession: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--continue') result.continueSession = true
    else if (arg === '--fork-session') result.forkSession = true
    else if (arg === '--resume') result.resume = requiredValue(args, ++index, arg)
    else if (arg === '--model') result.model = requiredValue(args, ++index, arg)
    else if (arg === '--name') result.name = requiredValue(args, ++index, arg)
    else if (arg === '--permission-mode') {
      const mode = requiredValue(args, ++index, arg)
      if (!isPermissionMode(mode)) throw new Error(`Unknown permission mode ${mode}`)
      result.permissionMode = mode
    } else throw new Error(`Unknown option ${arg}`)
  }
  return result
}

function requiredValue(args: readonly string[], index: number, option: string): string {
  const value = args[index]
  if (!value) throw new Error(`${option} requires a value`)
  return value
}

function parseModelReference(value: string): { modelId: string; providerName: string } {
  const separator = value.indexOf(':')
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Invalid model reference ${value}; expected <provider>:<model-id>`)
  }
  return { providerName: value.slice(0, separator), modelId: value.slice(separator + 1) }
}

async function resolveSessionId(options: {
  configDir: string
  continueSession: boolean
  cwd: string
  resume?: string
}): Promise<SessionId | undefined> {
  if (options.resume) {
    try {
      return asSessionId(options.resume)
    } catch {
      const sessions = await listSessions(options)
      const match = sessions.find((session) => session.name === options.resume)
      if (!match) throw new Error(`No session found with id or name ${options.resume}`)
      return match.sessionId
    }
  }
  return options.continueSession ? (await findMostRecentSession(options))?.sessionId : undefined
}

async function tryLoadSession(options: {
  configDir: string
  cwd: string
  sessionId: SessionId
}): Promise<Awaited<ReturnType<typeof loadSession>> | undefined> {
  try {
    return await loadSession(options)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

function isPermissionMode(value: string): value is PermissionMode {
  return ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'].includes(value)
}
