import type { UUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type CliOptions, parseCliOptions } from '../cli-options.js'
import { SubagentManager } from '../agents/manager.js'
import { type AgentPolicy, createSubagentRuntime } from '../agents/runtime.js'
import { createAgentTools } from '../agents/tools.js'
import { FileHistory } from '../checkpoint/file-history.js'
import {
  loadProviderCredential,
  promptForProviderCredential,
  saveProviderCredential,
} from '../config/credentials.js'
import {
  type FirstRunResult,
  type OnboardingPrompter,
  runFirstRunOnboarding,
  runInteractiveFirstRunOnboarding,
} from '../config/first-run.js'
import { findProjectRoot, loadSettings, type ProviderSettings } from '../config/load-settings.js'
import { ensureWorkspaceTrust, isWorkspaceTrusted } from '../config/workspace-trust.js'
import { addLocalPermissionRule, updateLocalSandboxMode } from '../config/write-settings.js'
import { compactConversation } from '../context/compaction.js'
import { ContextManager } from '../context/context-manager.js'
import { EvalCompaction, parseEvalCompactAfter } from '../context/eval-compaction.js'
import { loadInstructionDocuments } from '../context/load-instructions.js'
import { prepareFileRestoration } from '../context/restore-context.js'
import { ExtractMemories } from '../memory/extract-memories.js'
import { MemoryManager } from '../memory/memory-manager.js'
import { MemoryNotificationBroker } from '../memory/memory-notification-broker.js'
import { UserInteractionBroker } from '../interaction/user-interaction-broker.js'
import { createModelAdapter, getApiKeyEnvironmentName } from '../model/create-model-adapter.js'
import type { ModelAdapter } from '../model/types.js'
import { createUserMessage } from '../messages/create-message.js'
import { DEFAULT_MAX_OUTPUT_TOKENS } from '../model/output-tokens.js'
import { createCanUseTool } from '../permissions/can-use-tool.js'
import { AutoClassifier, AutoPermissionState } from '../permissions/auto-classifier.js'
import {
  filterDeniedTools,
  type PermissionRules,
  resolvePermission,
} from '../permissions/evaluate-permission.js'
import { PermissionBroker } from '../permissions/permission-broker.js'
import { PermissionModeState } from '../permissions/permission-mode-state.js'
import { SessionPermissionState } from '../permissions/session-permission-state.js'
import {
  createSandboxRuntimeConfig,
  DockSandbox,
  type SandboxManagerApi,
} from '../sandbox/dock-sandbox.js'
import { SandboxNetworkPermissionBroker } from '../sandbox/network-permission-broker.js'
import { SessionController } from '../session-controller.js'
import { asSessionId, createSessionId, type SessionId } from '../sessions/ids.js'
import { findMostRecentSession, forkSession, listSessions } from '../sessions/session-manager.js'
import { getSessionPath, loadSession, SessionWriter } from '../sessions/session-store.js'
import { createBashTool } from '../tools/bash-tool.js'
import { FileReadState } from '../tools/file-read-state.js'
import { createEditTool, createReadTool, createWriteTool } from '../tools/file-tools.js'
import { createGlobTool, createGrepTool } from '../tools/search-tools.js'
import { createSkillTool, SkillActivator } from '../skills/activation.js'
import { discoverSkills, isSkillResourcePath } from '../skills/registry.js'
import { parseSkillRestoreMode, prepareSkillRestorationWithMetadata } from '../skills/context.js'
import type { AgentTool, CanUseTool } from '../tools/types.js'
import { createInteractionTools } from '../tools/interaction-tools.js'
import { createTaskTools } from '../tools/task-tools.js'
import { createWebFetchTool } from '../tools/web-fetch-tool.js'
import { getTaskStorePath, TaskStore } from '../tasks/task-store.js'
import type {
  DockAgentCommands,
  DockSandboxCommands,
  DockSessionCommands,
  DockTaskCommands,
} from '../ui/dock-tui-app.js'
import { RuntimeController } from '../ui/runtime-controller.js'

export type CreateDockRuntimeOptions = {
  args: readonly string[]
  cli?: CliOptions
  cwd?: string
  credentialPrompter?: (message: string) => Promise<string>
  environment?: Record<string, string | undefined>
  homeDir?: string
  onboardingPrompter?: OnboardingPrompter
  modelFactory?: typeof createModelAdapter
  sandboxManager?: SandboxManagerApi
  workspaceTrustPrompter?: (workspace: string) => Promise<boolean>
}

export type DockRuntime = {
  controller: RuntimeController
  agentCommands: DockAgentCommands
  taskCommands: DockTaskCommands
  sandboxCommands: DockSandboxCommands
  sessionCommands: DockSessionCommands
  memoryNotificationBroker: MemoryNotificationBroker
  permissionBroker: PermissionBroker
  sandboxNetworkPermissionBroker: SandboxNetworkPermissionBroker
  userInteractionBroker: UserInteractionBroker
  startupNotices: readonly string[]
  setAgentWakeHandler: (handler: (sessionId: SessionId) => void) => void
  close: () => Promise<void>
}

export async function createDockRuntime(options: CreateDockRuntimeOptions): Promise<DockRuntime> {
  const cwd = options.cwd ?? process.cwd()
  const homeDir = options.homeDir ?? homedir()
  const environment = options.environment ?? process.env
  const skillRestoreMode = parseSkillRestoreMode(environment.DOCK_EVAL_SKILL_RESTORE)
  const evalCompactAfter = parseEvalCompactAfter(environment.DOCK_EVAL_COMPACT_AFTER)
  const configDir = join(homeDir, '.dock')
  const cli = options.cli ?? parseCliOptions(options.args)
  const projectRoot = await findProjectRoot(cwd)
  const gitRepository = await stat(join(projectRoot, '.git'))
    .then(() => projectRoot)
    .catch(() => undefined)
  if (cli.print) {
    if (!(await isWorkspaceTrusted({ homeDir, workspace: projectRoot })))
      throw new Error('Workspace trust is required before running in print mode')
  } else {
    await ensureWorkspaceTrust({
      cwd,
      homeDir,
      ...(options.workspaceTrustPrompter ? { prompter: options.workspaceTrustPrompter } : {}),
      workspace: projectRoot,
    })
  }
  const loadEffectiveSettings = async () => {
    const loaded = await loadSettings({ cwd, homeDir })
    return cli.noMemory
      ? { ...loaded, settings: { ...loaded.settings, autoMemoryEnabled: false } }
      : loaded
  }
  let loadedSettings = await loadEffectiveSettings()
  let initialModelReference = cli.model ?? loadedSettings.settings.model
  let firstRunResult: FirstRunResult | undefined
  if (!initialModelReference) {
    if (cli.print) {
      throw new Error('No model configured; run dock interactively before using print mode')
    } else if (options.onboardingPrompter) {
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
    loadedSettings = await loadEffectiveSettings()
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
    if (cli.print) {
      throw new Error(
        `No credential found for ${initialProviderName}; run dock interactively before using print mode`,
      )
    } else if (options.credentialPrompter) {
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
  let agents!: SubagentManager
  let runtime!: RuntimeController
  let agentsCreated = false
  let runtimeCreated = false
  try {
    await sandbox.initialize(async ({ host, port }) => {
      const response = await sandboxNetworkPermissionBroker.request({ host, port })
      if (response.allow && response.persist) {
        await addLocalPermissionRule({
          behavior: 'allow',
          projectRoot: loadedSettings.projectRoot,
          rule: `WebFetch(domain:${host})`,
        })
        loadedSettings = await loadEffectiveSettings()
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
    const userInteractionBroker = new UserInteractionBroker()
    const permissionMode =
      cli.permissionMode ?? loadedSettings.settings.permissions?.defaultMode ?? 'default'
    const permissionModeState = new PermissionModeState(permissionMode)
    const policies = new Map<SessionId, AgentPolicy>()
    const taskStores = new Map<SessionId, TaskStore>()
    const taskStoreFor = (id: SessionId): TaskStore => {
      let store = taskStores.get(id)
      if (!store) {
        store = new TaskStore(getTaskStorePath({ configDir, cwd, sessionId: id }))
        taskStores.set(id, store)
      }
      return store
    }
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
          auto: {
            interactive: !cli.print,
            state: new AutoPermissionState(),
            classifier: new AutoClassifier({
              repository: gitRepository,
              settings: loadedSettings.settings.permissions?.auto ?? {},
              resolveModel: (execution) =>
                resolveModel(
                  loadedSettings.settings.permissions?.auto?.model ??
                    execution.agent?.modelReference ??
                    initialModelReference,
                ),
              getMessages: async (execution) => {
                const main = await loadSession({ configDir, cwd, sessionId: id })
                const child = execution.agent?.agentId
                  ? (await agents.snapshot(id, execution.agent.agentId)).messages
                  : []
                const mainIds = new Set(main.displayMessages.map((message) => message.uuid))
                const additions = [...child, ...(execution.agent?.messages ?? [])].map((message) =>
                  execution.agent?.agentId &&
                  message.type === 'user' &&
                  !mainIds.has(message.uuid) &&
                  !message.isUserSubmission
                    ? { ...message, isMeta: true as const }
                    : message,
                )
                // Read original history, not model-generated compact summaries.
                // Preserve source messages across compaction and deduplicate forks.
                return [
                  ...new Map(
                    [...main.displayMessages, ...additions].map((message) => [
                      message.uuid,
                      message,
                    ]),
                  ).values(),
                ].sort((left, right) => left.timestamp.localeCompare(right.timestamp))
              },
            }),
          },
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
      loadedSettings = await loadEffectiveSettings()
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
        options.modelFactory,
      )
    }
    agents = new SubagentManager({
      configDir,
      projectCwd: cwd,
      backgroundEnabled: cli.print ? false : loadedSettings.settings.subagents?.backgroundEnabled,
      maxConcurrent: loadedSettings.settings.subagents?.maxConcurrent,
      maxDepth: loadedSettings.settings.subagents?.maxDepth,
      baseRef: loadedSettings.settings.worktree?.baseRef,
      createRuntime: (metadata, parent, initialMessages) =>
        createSubagentRuntime({
          skillRestoreMode,
          metadata,
          ...(parent ? { parent } : {}),
          ...(initialMessages ? { initialMessages } : {}),
          manager: agents,
          resolveModel,
          loadUserContext,
          policyFor,
          permissionMode: permissionModeState,
          permissionBroker,
          userInteractionBroker,
          taskStore: taskStoreFor(metadata.storageSessionId),
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
    agentsCreated = true
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
          prepareWrite: (filePath: string, content: string) =>
            memory.prepareWrite(filePath, content),
        },
      }
      const policy = policyFor(targetSessionId)
      const permissionRules: PermissionRules = policy.rules
      const skillRegistry = await discoverSkills({
        homeDir,
        projectRoot: loadedSettings.projectRoot,
      })
      const skillActivator = new SkillActivator(skillRegistry, existing?.messages ?? [])
      const skillTools = skillRegistry.skills.length
        ? [createSkillTool(skillActivator, skillRegistry)]
        : []
      const additionalTools = [
        ...createInteractionTools({
          broker: userInteractionBroker,
          mode: permissionModeState,
          includePlan: true,
          allowPlan: true,
        }),
        ...createTaskTools(taskStoreFor(targetSessionId)),
        createWebFetchTool({
          model,
          modelId,
          ...(provider.maxOutputTokens ? { maxOutputTokens: provider.maxOutputTokens } : {}),
        }),
      ]
      const tools = filterDeniedTools(
        [
          createReadTool(fileDependencies),
          createWriteTool(fileDependencies),
          createEditTool(fileDependencies),
          createGlobTool({ cwd }),
          createGrepTool({ cwd }),
          createBashTool({ cwd, homeDir, sandbox }),
          ...createAgentTools(agents),
          ...skillTools,
          ...additionalTools,
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
          ...skillTools,
          ...additionalTools,
        ],
        permissionRules,
      )
      const canUseTool = createCanUseTool({
        ...(policy.auto ? { auto: policy.auto } : {}),
        autoAllowInternalToolUse: (tool, input) =>
          typeof input.file_path === 'string' &&
          ((['Read', 'Write', 'Edit'].includes(tool.name) &&
            memory.isMemoryPath(input.file_path)) ||
            (tool.name === 'Read' &&
              (agents.isOutputPath(targetSessionId, input.file_path) ||
                isSkillResourcePath(skillRegistry, input.file_path)))),
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
        maxOutputTokens: provider.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        toolResultClearing: loadedSettings.settings.contextManagement?.toolResultClearing,
        summarize: (input) => compactConversation({ ...input, model, transcriptPath: writer.path }),
        prepareRestoration: async (messages, signal) => {
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
          const skills = prepareSkillRestorationWithMetadata(messages, skillRestoreMode)
          return {
            ...restored,
            skillRestoration: skills.skillRestoration,
            attachments: [...restored.attachments, ...skills.attachments],
            userContext: nextUserContext,
          }
        },
      })
      const systemPrompt = [
        'You are Dock, an interactive coding agent. Read the project, use tools to act, and verify your work.',
        ...(memoryPrompt ? [memoryPrompt] : []),
      ]
      const extractMemories = memory.enabled
        ? new ExtractMemories({
            canUseTool: (tool, input, execution) =>
              permissionModeState.value === 'auto'
                ? canUseTool(tool, input, execution)
                : Promise.resolve({ behavior: 'allow' }),
            getAgentIdentity: () => ({
              sessionId: targetSessionId,
              depth: 0,
              contextMode: 'main',
              cwd,
              modelReference,
            }),
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
          skills: skillRegistry.skills,
        }),
        inbox: {
          peek: (seen) => agents.pendingNotifications(targetSessionId, seen),
          ack: (ids) => agents.ackNotifications(targetSessionId, ids as readonly UUID[]),
        },
        canUseTool,
        contextManager,
        ...(evalCompactAfter !== undefined
          ? {
              evalCompaction: new EvalCompaction(evalCompactAfter, existing?.records ?? [], () =>
                writer.recordEvalCompactionTrigger(evalCompactAfter),
              ),
            }
          : {}),
        fileHistory,
        initialMessages: existing?.messages ?? [],
        initialDisplayMessages: existing?.displayMessages ?? [],
        maxOutputTokens: provider.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        model,
        modelId,
        permissionModeState,
        skillActivator,
        skills: skillRegistry.skills,
        skillDiagnostics: skillRegistry.diagnostics,
        systemPrompt,
        tools,
        ...(extractMemories ? { turnComplete: extractMemories } : {}),
        ...(Object.keys(userContext).length > 0 ? { userContext } : {}),
        writer,
      })
    }

    let currentSessionId = sessionId
    let currentModelReference = initialModelReference
    runtime = new RuntimeController(
      await createController(currentSessionId, currentModelReference, cli.name),
    )
    runtimeCreated = true
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
        await taskStoreFor(currentSessionId).copyTo(taskStoreFor(targetSessionId))
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
    const sandboxCommands: DockSandboxCommands = {
      getMode: () => sandbox.mode,
      async setMode(mode: Parameters<DockSandbox['setMode']>[0]) {
        await sandbox.setMode(mode)
        await updateLocalSandboxMode({
          autoAllowBashIfSandboxed: mode !== 'regular-permissions',
          enabled: mode !== 'off',
          projectRoot: loadedSettings.projectRoot,
        })
        loadedSettings = await loadEffectiveSettings()
      },
    }
    const agentCommands: DockAgentCommands = {
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
          agent: {
            ...snapshot,
            messages: [
              ...snapshot.messages,
              createUserMessage({ content: [{ type: 'text', text: prompt }] }),
            ],
          },
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
    }
    const taskCommands: DockTaskCommands = {
      list: () => taskStoreFor(currentSessionId).list(),
      get: (id) => taskStoreFor(currentSessionId).get(id),
    }
    let closed = false
    return {
      controller: runtime,
      agentCommands,
      taskCommands,
      sandboxCommands,
      sessionCommands,
      memoryNotificationBroker,
      permissionBroker,
      sandboxNetworkPermissionBroker,
      userInteractionBroker,
      startupNotices: sandbox.unavailableReason ? [sandbox.unavailableReason] : [],
      setAgentWakeHandler: (handler) => agents.setWakeHandler(handler),
      async close() {
        if (closed) return
        closed = true
        try {
          await runtime.close()
        } finally {
          try {
            await agents.close()
          } finally {
            await sandbox.reset()
          }
        }
      },
    }
  } catch (error) {
    if (runtimeCreated) await runtime.close().catch(() => {})
    if (agentsCreated) await agents.close().catch(() => {})
    await sandbox.reset().catch(() => {})
    throw error
  }
}

function createConfiguredModel(
  modelReference: string,
  providers: Record<string, ProviderSettings> | undefined,
  environment: Record<string, string | undefined>,
  storedApiKey?: string,
  modelFactory: typeof createModelAdapter = createModelAdapter,
): { model: ModelAdapter; modelId: string; provider: ProviderSettings } {
  const { modelId, providerName } = parseModelReference(modelReference)
  const provider = providers?.[providerName]
  if (!provider?.protocol) throw new Error(`Provider ${providerName} is missing a protocol`)
  const configuredProvider = provider as ProviderSettings & {
    protocol: NonNullable<ProviderSettings['protocol']>
  }
  return {
    model: modelFactory(configuredProvider, environment, storedApiKey),
    modelId,
    provider: configuredProvider,
  }
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
