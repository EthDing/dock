import type { JsonObject } from '../model/types.js'
import type { AgentTool, CanUseTool } from '../tools/types.js'
import {
  resolvePermission,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRules,
} from './evaluate-permission.js'
import type { PermissionApproval, PermissionCallIdentity } from './permission-broker.js'
import type { SessionPermissionState } from './session-permission-state.js'

export function createCanUseTool(options: {
  autoAllowInternalToolUse?: (tool: AgentTool, input: JsonObject) => boolean
  autoAllowBashIfSandboxed?: () => boolean
  isBashSandboxed?: (tool: AgentTool, input: JsonObject) => boolean
  mode: PermissionMode | (() => PermissionMode)
  requestApproval: (
    tool: AgentTool,
    input: JsonObject,
    decision: PermissionDecision,
    signal: AbortSignal,
    identity: PermissionCallIdentity,
  ) => Promise<PermissionApproval>
  rules: PermissionRules
  persistApproval?: (rule: string) => Promise<void>
  sessionPermissions?: SessionPermissionState
}): CanUseTool {
  return async (tool, input, execution) => {
    const decision = await resolvePermission(tool, input, {
      ...(options.autoAllowBashIfSandboxed
        ? { autoAllowBashIfSandboxed: options.autoAllowBashIfSandboxed }
        : {}),
      ...(options.autoAllowInternalToolUse
        ? { autoAllowInternalToolUse: options.autoAllowInternalToolUse }
        : {}),
      ...(options.isBashSandboxed ? { isBashSandboxed: options.isBashSandboxed } : {}),
      mode: typeof options.mode === 'function' ? options.mode() : options.mode,
      rules: options.rules,
    })
    const decisionInput = decision.updatedInput ?? input

    if (decision.behavior === 'deny') {
      return {
        behavior: 'deny',
        message: decision.message ?? `Permission denied for ${tool.name}`,
      }
    }

    if (decision.behavior === 'allow') {
      return { behavior: 'allow', updatedInput: decisionInput }
    }

    const forcedAsk =
      decision.source === 'rule' ||
      decision.source === 'circuit_breaker' ||
      decision.source === 'interaction'
    if (!forcedAsk && options.sessionPermissions?.isAllowed(tool, decisionInput)) {
      return { behavior: 'allow', updatedInput: decisionInput }
    }

    const approval = await options.requestApproval(
      tool,
      decisionInput,
      decision,
      execution.signal,
      {
        sessionId: execution.agent?.sessionId,
        toolUseId: execution.toolUseId,
        parentMessageUuid: execution.parentMessageUuid,
      },
    )
    if (approval.behavior === 'allow_session' || approval.behavior === 'allow_always') {
      options.sessionPermissions?.allow(tool, decisionInput)
    }
    if (approval.behavior === 'allow_always') {
      await options.persistApproval?.(approval.rule)
    }
    return approval.behavior === 'deny'
      ? { behavior: 'deny', message: `User denied ${tool.name}` }
      : { behavior: 'allow', updatedInput: decisionInput }
  }
}
