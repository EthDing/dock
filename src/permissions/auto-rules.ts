import type { PermissionRules } from './evaluate-permission.js'
import { matchesWildcard } from './specifier-matching.js'

// An effective view, never a mutation: switching out of auto restores the user's
// rules, including rules added while auto was active.
export function autoPermissionRules(rules: PermissionRules): PermissionRules {
  return { ...rules, allow: rules.allow?.filter((rule) => !isBroadExecutionRule(rule)) ?? [] }
}

export function isBroadExecutionRule(rule: string): boolean {
  const match = rule.match(/^([^()]+?)(?:\((.*)\))?$/)
  const tool = match?.[1]?.trim()
  if (!tool) return false
  if (matchesWildcard(tool, 'Agent') || matchesWildcard(tool, 'SendMessage')) return true
  if (!matchesWildcard(tool, 'Bash')) return false
  const command = match?.[2]?.trim().replace(/["'\\]/g, '')
  if (!command || command === '*') return true
  if (!command.includes('*')) return false
  // Unknown executable prefixes can stand for any interpreter or exec wrapper.
  if (command.split(/\s/)[0]?.includes('*')) return true
  return (
    /(?:^|[\s/])(?:bash|sh|zsh|dash|fish|ksh|python[\d.]*|node|nodejs|ruby|perl|php|lua|deno|bun|pwsh|julia|Rscript|eval|exec|env|xargs|sudo|npx|pnpx|uvx)(?:\s|:|\*|$)/.test(
      command,
    ) ||
    /(?:^|[\s/])(?:npm|pnpm|yarn|uv|pipenv|poetry|bundle|cargo|go|dotnet)\s+(?:run|run-script|exec|dlx|x)\b.*\*/.test(
      command,
    ) ||
    /(?:^|[\s/])(?:npm|pnpm|yarn|git|make|just)(?:\s*|:)\*/.test(command)
  )
}
