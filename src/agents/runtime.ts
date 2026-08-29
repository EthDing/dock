import type { AgentMetadata, AgentSnapshot } from './types.js'
import type { SubagentManager, SubagentRuntime } from './manager.js'
import { createAgentTools } from './tools.js'
import { assertIsolatedWrite } from './worktrees.js'
import { ContextManager } from '../context/context-manager.js'
import { compactConversation } from '../context/compaction.js'
import { prepareFileRestoration } from '../context/restore-context.js'
import type { ModelAdapter } from '../model/types.js'
import type { ProviderSettings } from '../config/load-settings.js'
import { createCanUseTool } from '../permissions/can-use-tool.js'
import {
  filterDeniedTools,
  resolvePermission,
  type PermissionRules,
} from '../permissions/evaluate-permission.js'
import type { PermissionModeState } from '../permissions/permission-mode-state.js'
import type { PermissionBroker } from '../permissions/permission-broker.js'
import type { SessionPermissionState } from '../permissions/session-permission-state.js'
import type { SessionId } from '../sessions/ids.js'
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  type FileWriteLifecycle,
} from '../tools/file-tools.js'
import { createGlobTool, createGrepTool } from '../tools/search-tools.js'
import { createBashTool } from '../tools/bash-tool.js'
import { FileReadState } from '../tools/file-read-state.js'
import type { AgentTool } from '../tools/types.js'
import type { DockSandbox } from '../sandbox/dock-sandbox.js'
import type { MemoryManager } from '../memory/memory-manager.js'
import { findProjectRoot } from '../config/load-settings.js'
import { createSkillTool, SkillActivator } from '../skills/activation.js'
import { discoverSkills, inheritedSkillRegistry, isSkillResourcePath } from '../skills/registry.js'
import { prepareSkillRestoration } from '../skills/context.js'
import type { UserInteractionBroker } from '../interaction/user-interaction-broker.js'
import type { TaskStore } from '../tasks/task-store.js'
import { createInteractionTools } from '../tools/interaction-tools.js'
import { createTaskTools } from '../tools/task-tools.js'
import { createWebFetchTool } from '../tools/web-fetch-tool.js'

export type AgentPolicy = { rules: PermissionRules; sessionPermissions: SessionPermissionState }
export async function createSubagentRuntime(options: {
  metadata: AgentMetadata
  parent?: AgentSnapshot | undefined
  initialMessages?: readonly import('../messages/create-message.js').TranscriptMessage[]
  manager: SubagentManager
  resolveModel: (
    reference: string,
  ) => Promise<{ model: ModelAdapter; modelId: string; provider: ProviderSettings }>
  loadUserContext: (cwd?: string) => Promise<Record<string, string>>
  policyFor: (sessionId: SessionId) => AgentPolicy
  permissionMode: PermissionModeState
  permissionBroker: PermissionBroker
  userInteractionBroker: UserInteractionBroker
  taskStore: TaskStore
  sandbox: DockSandbox
  memory: MemoryManager
  homeDir: string
  persistApproval: (rule: string) => Promise<void>
  transcriptPath: string
}): Promise<SubagentRuntime> {
  const { metadata: meta } = options
  const { model, modelId, provider } = await options.resolveModel(meta.modelReference)
  if (meta.contextMode === 'fresh') {
    const { AUTO_MEMORY: _memory, ...context } = await options.loadUserContext(meta.cwd)
    meta.userContext = context
  }
  const state = new FileReadState()
  if (meta.contextMode === 'fork' && !meta.worktree && options.parent?.fileReadState) {
    for (const [path, snapshot] of options.parent.fileReadState.entries())
      state.set(path, { ...snapshot })
  }
  const lifecycle: FileWriteLifecycle = {
    prepareWrite: (path, content) => options.memory.prepareWrite(path, content),
    afterWrite: (path, content) => options.memory.inspectWrite(path, content),
  }
  const deps = {
    cwd: meta.cwd,
    fileHistory: { trackEdit: async () => {} },
    readFileState: state,
    writeLifecycle: lifecycle,
  }
  const projectRoot = await findProjectRoot(meta.cwd)
  const skillRegistry =
    meta.contextMode === 'fork' && (meta.skills ?? options.parent?.skills)
      ? inheritedSkillRegistry(meta.skills ?? options.parent?.skills ?? [], projectRoot)
      : await discoverSkills({ homeDir: options.homeDir, projectRoot })
  const skillActivator = new SkillActivator(
    skillRegistry,
    options.initialMessages ?? options.parent?.messages ?? [],
  )
  const skillTools = skillRegistry.skills.length
    ? [createSkillTool(skillActivator, skillRegistry)]
    : []
  const internal = (tool: AgentTool, input: Record<string, unknown>) =>
    typeof input.file_path === 'string' &&
    ((['Read', 'Write', 'Edit'].includes(tool.name) &&
      options.memory.isMemoryPath(input.file_path)) ||
      (tool.name === 'Read' &&
        (options.manager.isOutputPath(meta.sessionId, input.file_path) ||
          isSkillResourcePath(skillRegistry, input.file_path))))
  let tools = [
    createReadTool(deps),
    createWriteTool(deps),
    createEditTool(deps),
    createGlobTool({ cwd: meta.cwd }),
    createGrepTool({ cwd: meta.cwd }),
    createBashTool({
      cwd: meta.cwd,
      homeDir: options.homeDir,
      sandbox: options.sandbox.forCwd(meta.cwd),
    }),
    ...createAgentTools(options.manager),
    ...skillTools,
    ...createInteractionTools({
      broker: options.userInteractionBroker,
      mode: options.permissionMode,
      includePlan: meta.contextMode === 'fork',
      allowPlan: false,
    }),
    ...createTaskTools(options.taskStore),
    createWebFetchTool({
      model,
      modelId,
      ...(provider.maxOutputTokens ? { maxOutputTokens: provider.maxOutputTokens } : {}),
    }),
  ]
  if (meta.contextMode !== 'fork')
    tools = filterDeniedTools(tools, options.policyFor(meta.sessionId).rules)
  if (meta.worktree) {
    const worktree = meta.worktree
    tools = tools.map((tool) => {
      if (tool.name !== 'Write' && tool.name !== 'Edit') return tool
      return {
        ...tool,
        async checkPermissions(input, context) {
          try {
            await assertIsolatedWrite(String(input.file_path), worktree)
          } catch (error) {
            return {
              behavior: 'deny' as const,
              source: 'tool' as const,
              message: error instanceof Error ? error.message : String(error),
            }
          }
          return (
            tool.checkPermissions?.(input, context) ?? {
              behavior: 'passthrough' as const,
              source: 'tool' as const,
            }
          )
        },
        async execute(input, execution) {
          await assertIsolatedWrite(String(input.file_path), worktree)
          return tool.execute(input, execution)
        },
      }
    })
  }
  const canUseTool: NonNullable<SubagentRuntime['canUseTool']> = async (tool, input, execution) => {
    const policy = options.policyFor(meta.sessionId)
    return createCanUseTool({
      persistApproval: options.persistApproval,
      rules: policy.rules,
      sessionPermissions: policy.sessionPermissions,
      mode: () => options.permissionMode.value,
      autoAllowInternalToolUse: internal,
      autoAllowBashIfSandboxed: () => options.sandbox.autoAllowBashIfSandboxed,
      isBashSandboxed: (_tool, args) =>
        options.sandbox.shouldUseSandbox({
          ...(typeof args.command === 'string' ? { command: args.command } : {}),
          dangerouslyDisableSandbox: args.dangerouslyDisableSandbox === true,
        }),
      requestApproval: (tool, input, decision, signal, identity) =>
        options.permissionBroker.requestApproval(
          tool,
          input,
          decision,
          signal,
          {
            agentId: meta.id,
            label: meta.name ?? meta.description,
          },
          identity,
        ),
    })(tool, input, execution)
  }
  const contextManager = new ContextManager({
    contextWindow: provider.contextWindow ?? 200_000,
    maxOutputTokens: provider.maxOutputTokens ?? 8192,
    toolResultClearing: { enabled: false },
    summarize: (request) =>
      compactConversation({ ...request, model, transcriptPath: options.transcriptPath }),
    prepareRestoration: async (messages, signal) => {
      const loaded = await options.loadUserContext(meta.cwd)
      const { AUTO_MEMORY: _memory, ...fresh } = loaded
      const restored = await prepareFileRestoration({
        readFileState: state,
        signal,
        canRead: async (path) => {
          const read = tools.find((tool) => tool.name === 'Read')
          if (!read) return false
          return (
            (
              await resolvePermission(
                read,
                { file_path: path },
                {
                  rules: options.policyFor(meta.sessionId).rules,
                  mode: options.permissionMode.value,
                  autoAllowInternalToolUse: internal,
                },
              )
            ).behavior === 'allow'
          )
        },
      })
      return {
        ...restored,
        attachments: [...restored.attachments, ...prepareSkillRestoration(messages)],
        userContext: meta.contextMode === 'fresh' ? fresh : loaded,
      }
    },
  })
  return {
    model,
    modelId,
    tools,
    canUseTool,
    contextManager,
    fileReadState: state,
    maxOutputTokens: provider.maxOutputTokens,
    skills: skillRegistry.skills,
  }
}
