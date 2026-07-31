import type { JsonObject } from '../model/types.js'
import type { AgentTool, CanUseTool } from '../tools/types.js'
import {
  evaluatePermission,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRules,
} from './evaluate-permission.js'
import type { PermissionApproval } from './permission-broker.js'
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
  ) => Promise<PermissionApproval>
  rules: PermissionRules
  persistApproval?: (rule: string) => Promise<void>
  sessionPermissions?: SessionPermissionState
}): CanUseTool {
  return async (tool, input, execution) => {
    const subject = tool.getPermissionSubject?.(input) ?? {
      isInWorkingDirectory: false,
      isReadOnly: false,
      matchesSpecifier: () => false,
      name: tool.name,
      requiresBypassConfirmation: false,
    }
    const decision = evaluatePermission({
      mode: typeof options.mode === 'function' ? options.mode() : options.mode,
      rules: options.rules,
      subject,
    })

    if (decision.behavior === 'deny' && decision.source === 'rule') {
      return {
        behavior: 'deny',
        message: `Permission denied for ${tool.name}`,
      }
    }

    const autoAllowInternalToolUse =
      options.autoAllowInternalToolUse?.(tool, input) === true &&
      !(decision.behavior === 'ask' && decision.source === 'rule')
    if (autoAllowInternalToolUse) return { behavior: 'allow' }

    if (decision.behavior === 'deny') {
      return {
        behavior: 'deny',
        message: `Permission denied for ${tool.name}`,
      }
    }

    if (options.sessionPermissions?.isAllowed(tool, input)) {
      return { behavior: 'allow' }
    }

    const autoAllowSandboxedBash =
      tool.name === 'Bash' &&
      options.autoAllowBashIfSandboxed?.() === true &&
      options.isBashSandboxed?.(tool, input) === true

    if (autoAllowSandboxedBash && !subject.requiresBypassConfirmation) {
      return { behavior: 'allow' }
    }

    if (decision.behavior === 'allow') return { behavior: 'allow' }

    const approval = await options.requestApproval(tool, input, decision, execution.signal)
    if (approval.behavior === 'allow_session' || approval.behavior === 'allow_always') {
      options.sessionPermissions?.allow(tool, input)
    }
    if (approval.behavior === 'allow_always') {
      await options.persistApproval?.(approval.rule)
    }
    return approval.behavior === 'deny'
      ? { behavior: 'deny', message: `User denied ${tool.name}` }
      : { behavior: 'allow' }
  }
}
