import { homedir } from 'node:os'
import { join } from 'node:path'
import { ProcessTerminal, TuiMainScreen } from '@dock/tui'
import { runAgentLoop } from './agent/run-agent-loop.js'
import { FileHistory } from './checkpoint/file-history.js'
import { ContextManager } from './context/context-manager.js'
import { loadInstructionDocuments } from './context/load-instructions.js'
import { loadSettings, type ProviderSettings } from './config/load-settings.js'
import { createUserMessage } from './messages/create-message.js'
import { createModelAdapter } from './model/create-model-adapter.js'
import type { ModelAdapter } from './model/types.js'
import { createCanUseTool } from './permissions/can-use-tool.js'
import { PermissionBroker } from './permissions/permission-broker.js'
import type { PermissionMode } from './permissions/evaluate-permission.js'
import { PermissionModeState } from './permissions/permission-mode-state.js'
import { SessionController } from './session-controller.js'
import { createSessionId, asSessionId, type SessionId } from './sessions/ids.js'
import { findMostRecentSession, forkSession, listSessions } from './sessions/session-manager.js'
import { loadSession, SessionWriter } from './sessions/session-store.js'
import { createBashTool } from './tools/bash-tool.js'
import { FileReadState } from './tools/file-read-state.js'
import { createEditTool, createReadTool, createWriteTool } from './tools/file-tools.js'
import { createGlobTool, createGrepTool } from './tools/search-tools.js'
import { DockTuiApp, type DockSessionCommands } from './ui/dock-tui-app.js'
import { RuntimeController } from './ui/runtime-controller.js'

export type StartDockOptions = {
  args: readonly string[]
  cwd?: string
  environment?: Record<string, string | undefined>
  homeDir?: string
}

export async function startDock(options: StartDockOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd()
  const homeDir = options.homeDir ?? homedir()
  const environment = options.environment ?? process.env
  const configDir = join(homeDir, '.dock')
  const cli = parseCliOptions(options.args)
  const loadedSettings = await loadSettings({ cwd, homeDir })
  const initialModelReference = cli.model ?? loadedSettings.settings.model
  if (!initialModelReference) {
    throw new Error(
      'No model configured. Set "model" to "<provider>:<model-id>" in ~/.dock/settings.json.',
    )
  }

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
  const instructionDocuments = await loadInstructionDocuments({
    cwd,
    homeDir,
    projectRoot: loadedSettings.projectRoot,
  })
  const userContext = {
    AGENTS: instructionDocuments
      .map((document) => `Contents of ${document.path}:\n\n${document.content}`)
      .join('\n\n'),
  }
  const permissionBroker = new PermissionBroker()
  const permissionMode =
    cli.permissionMode ?? loadedSettings.settings.permissions?.defaultMode ?? 'default'
  const permissionModeState = new PermissionModeState(permissionMode)
  const canUseTool = createCanUseTool({
    mode: () => permissionModeState.value,
    requestApproval: (tool, input, decision) =>
      permissionBroker.requestApproval(tool, input, decision),
    rules: {
      allow: loadedSettings.settings.permissions?.allow ?? [],
      ask: loadedSettings.settings.permissions?.ask ?? [],
      deny: loadedSettings.settings.permissions?.deny ?? [],
    },
  })

  const createController = async (
    targetSessionId: SessionId,
    modelReference: string,
    name?: string,
  ): Promise<SessionController> => {
    const { model, modelId, provider } = createConfiguredModel(
      modelReference,
      loadedSettings.settings.providers,
      environment,
    )
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
    const readFileState = new FileReadState()
    const fileDependencies = { cwd, fileHistory, readFileState }
    const tools = [
      createReadTool(fileDependencies),
      createWriteTool(fileDependencies),
      createEditTool(fileDependencies),
      createGlobTool({ cwd }),
      createGrepTool({ cwd }),
      createBashTool({ cwd, homeDir }),
    ]
    const contextManager = new ContextManager({
      contextWindow: provider.contextWindow ?? 200_000,
      maxOutputTokens: provider.maxOutputTokens ?? 8_192,
      summarize: ({ instructions, transcript }) =>
        summarizeWithModel(model, modelId, transcript, instructions),
    })
    return new SessionController({
      canUseTool,
      contextManager,
      fileHistory,
      initialMessages: existing?.messages ?? [],
      model,
      modelId,
      permissionModeState,
      systemPrompt: [
        'You are Dock, an interactive coding agent. Read the project, use tools to act, and verify your work.',
      ],
      tools,
      userContext,
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
      createConfiguredModel(reference, loadedSettings.settings.providers, environment)
      if (reference === currentModelReference) return
      await runtime.replace(() => createController(currentSessionId, reference))
      currentModelReference = reference
    },
  }
  const tui = new TuiMainScreen(new ProcessTerminal())
  const app = new DockTuiApp({
    controller: runtime,
    permissionBroker,
    sessionCommands,
    tui,
  })
  app.start()
  await app.waitUntilStopped()
}

function createConfiguredModel(
  modelReference: string,
  providers: Record<string, ProviderSettings> | undefined,
  environment: Record<string, string | undefined>,
): { model: ModelAdapter; modelId: string; provider: ProviderSettings } {
  const { modelId, providerName } = parseModelReference(modelReference)
  const provider = providers?.[providerName]
  if (!provider?.protocol) throw new Error(`Provider ${providerName} is missing a protocol`)
  const configuredProvider = provider as ProviderSettings & {
    protocol: NonNullable<ProviderSettings['protocol']>
  }
  return {
    model: createModelAdapter(configuredProvider, environment),
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

async function summarizeWithModel(
  model: ModelAdapter,
  modelId: string,
  transcript: string,
  instructions?: string,
): Promise<string> {
  const generator = runAgentLoop({
    messages: [
      createUserMessage({
        content: [
          {
            text: `${instructions ? `${instructions}\n\n` : ''}Summarize this conversation for continuation:\n\n${transcript}`,
            type: 'text',
          },
        ],
      }),
    ],
    model,
    modelId,
    systemPrompt: ['Produce a concise but complete continuation summary.'],
    tools: [],
  })
  let next = await generator.next()
  while (!next.done) next = await generator.next()
  const assistant = [...next.value.messages]
    .reverse()
    .find((message) => message.type === 'assistant')
  return (
    assistant?.message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n') ?? ''
  )
}

function isPermissionMode(value: string): value is PermissionMode {
  return ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'].includes(value)
}
