import type { JsonObject } from '../model/types.js'
import type { AgentTool } from '../tools/types.js'

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions'

export type PermissionRules = {
  allow?: readonly string[]
  ask?: readonly string[]
  deny?: readonly string[]
}

export type PermissionSource =
  | 'circuit_breaker'
  | 'fallback'
  | 'interaction'
  | 'internal'
  | 'mode'
  | 'rule'
  | 'tool'

type PermissionMetadata = {
  message?: string
  rule?: string
  source: PermissionSource
  updatedInput?: JsonObject
}

export type PermissionResult = PermissionMetadata &
  ({ behavior: 'allow' } | { behavior: 'ask' } | { behavior: 'deny' } | { behavior: 'passthrough' })

export type PermissionDecision = Exclude<PermissionResult, { behavior: 'passthrough' }>

export type ToolPermissionContext = {
  autoAllowBashIfSandboxed?: () => boolean
  autoAllowInternalToolUse?: (tool: AgentTool, input: JsonObject) => boolean
  isBashSandboxed?: (tool: AgentTool, input: JsonObject) => boolean
  mode: PermissionMode
  rules: PermissionRules
}

export async function resolvePermission(
  tool: AgentTool,
  input: JsonObject,
  context: ToolPermissionContext,
): Promise<PermissionDecision> {
  // The order mirrors Claude Code's permission spine. Moving whole-tool allow
  // or bypass earlier would let them override tool-specific safety decisions.
  const wholeDeny = findWholeToolRule(context.rules, 'deny', tool.name)
  if (wholeDeny) return ruleDecision('deny', wholeDeny, tool.name)

  const wholeAsk = findWholeToolRule(context.rules, 'ask', tool.name)
  if (wholeAsk && !canSandboxReplaceWholeAsk(tool, input, context)) {
    return finalizeAsk(ruleDecision('ask', wholeAsk, tool.name), context.mode)
  }

  const toolResult = (await tool.checkPermissions?.(input, context)) ?? {
    behavior: 'passthrough' as const,
    source: 'tool' as const,
  }
  if (toolResult.behavior === 'deny') return toolResult
  if (
    toolResult.behavior === 'ask' &&
    (toolResult.source === 'rule' ||
      toolResult.source === 'circuit_breaker' ||
      toolResult.source === 'interaction')
  ) {
    return finalizeAsk(toolResult, context.mode)
  }

  if (context.mode === 'bypassPermissions') {
    return {
      behavior: 'allow',
      source: 'mode',
      updatedInput: toolResult.updatedInput ?? input,
    }
  }

  const wholeAllow = findWholeToolRule(context.rules, 'allow', tool.name)
  if (wholeAllow) {
    return {
      behavior: 'allow',
      rule: wholeAllow,
      source: 'rule',
      updatedInput: toolResult.updatedInput ?? input,
    }
  }

  if (toolResult.behavior === 'allow') return toolResult
  const decision: PermissionDecision =
    toolResult.behavior === 'passthrough'
      ? context.mode === 'plan'
        ? {
            behavior: 'deny',
            message: `Permission denied for ${tool.name} in plan mode`,
            source: 'mode',
            updatedInput: toolResult.updatedInput ?? input,
          }
        : {
            behavior: 'ask',
            message: `Permission required for ${tool.name}`,
            source: 'fallback',
            updatedInput: toolResult.updatedInput ?? input,
          }
      : toolResult
  return finalizeAsk(decision, context.mode)
}

export function filterDeniedTools(
  tools: readonly AgentTool[],
  rules: PermissionRules,
): AgentTool[] {
  // A bare deny changes the model's capability surface; content-scoped denies
  // stay visible so the model can still use the permitted forms of the tool.
  return tools.filter((tool) => !findWholeToolRule(rules, 'deny', tool.name))
}

export function findContentRule(
  rules: PermissionRules,
  behavior: keyof PermissionRules,
  toolName: string,
  matchesSpecifier: (specifier: string) => boolean,
): string | undefined {
  return rules[behavior]?.find((rule) => {
    const parsed = parseRule(rule)
    return (
      parsed !== undefined &&
      matchesWildcard(parsed.toolPattern, toolName) &&
      parsed.specifier !== undefined &&
      parsed.specifier !== '*' &&
      matchesSpecifier(parsed.specifier)
    )
  })
}

function finalizeAsk(decision: PermissionDecision, mode: PermissionMode): PermissionDecision {
  if (decision.behavior !== 'ask' || mode !== 'dontAsk') return decision
  return {
    behavior: 'deny',
    message: decision.message ?? 'Permission denied because dontAsk mode cannot prompt',
    ...(decision.rule ? { rule: decision.rule } : {}),
    source: 'mode',
    ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
  }
}

function ruleDecision(
  behavior: 'ask' | 'deny',
  rule: string,
  toolName: string,
): PermissionDecision {
  return {
    behavior,
    message:
      behavior === 'deny'
        ? `Permission denied for ${toolName}`
        : `Permission required for ${toolName}`,
    rule,
    source: 'rule',
  }
}

function canSandboxReplaceWholeAsk(
  tool: AgentTool,
  input: JsonObject,
  context: ToolPermissionContext,
): boolean {
  return (
    tool.name === 'Bash' &&
    context.mode !== 'plan' &&
    context.autoAllowBashIfSandboxed?.() === true &&
    context.isBashSandboxed?.(tool, input) === true
  )
}

function findWholeToolRule(
  rules: PermissionRules,
  behavior: keyof PermissionRules,
  toolName: string,
): string | undefined {
  return rules[behavior]?.find((rule) => {
    const parsed = parseRule(rule)
    return (
      parsed !== undefined &&
      matchesWildcard(parsed.toolPattern, toolName) &&
      (parsed.specifier === undefined || parsed.specifier === '*')
    )
  })
}

function parseRule(rule: string): { specifier?: string; toolPattern: string } | undefined {
  const parsed = rule.match(/^([^()]+?)(?:\((.*)\))?$/)
  const toolPattern = parsed?.[1]?.trim()
  if (!toolPattern) return undefined
  return {
    toolPattern,
    ...(parsed?.[2] === undefined ? {} : { specifier: parsed[2] }),
  }
}

function matchesWildcard(pattern: string, value: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`).test(value)
}
