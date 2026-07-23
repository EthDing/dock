import type { JsonObject } from '../model/types.js'
import type { AgentTool, CanUseTool } from '../tools/types.js'
import {
  evaluatePermission,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRules,
} from './evaluate-permission.js'

export function createCanUseTool(options: {
  mode: PermissionMode | (() => PermissionMode)
  requestApproval: (
    tool: AgentTool,
    input: JsonObject,
    decision: PermissionDecision,
    signal: AbortSignal,
  ) => Promise<boolean>
  rules: PermissionRules
}): CanUseTool {
  return async (tool, input, execution) => {
    const subject = tool.getPermissionSubject?.(input) ?? {
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

    if (decision.behavior === 'allow') return { behavior: 'allow' }
    if (decision.behavior === 'deny') {
      return {
        behavior: 'deny',
        message: `Permission denied for ${tool.name}`,
      }
    }

    return (await options.requestApproval(tool, input, decision, execution.signal))
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: `User denied ${tool.name}` }
  }
}
