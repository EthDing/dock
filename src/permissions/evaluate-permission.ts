export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions'

export type PermissionRules = {
  allow?: readonly string[]
  ask?: readonly string[]
  deny?: readonly string[]
}

export type PermissionSubject = {
  isReadOnly: boolean
  matchesSpecifier: (pattern: string) => boolean
  name: string
  requiresBypassConfirmation: boolean
}

export type PermissionDecision = {
  behavior: 'allow' | 'ask' | 'deny'
  source: 'circuit_breaker' | 'mode' | 'rule'
  rule?: string
}

export function evaluatePermission(options: {
  mode: PermissionMode
  rules: PermissionRules
  subject: PermissionSubject
}): PermissionDecision {
  for (const behavior of ['deny', 'ask', 'allow'] as const) {
    const rule = options.rules[behavior]?.find((candidate) =>
      matchesRule(candidate, options.subject),
    )
    if (rule) return { behavior, rule, source: 'rule' }
  }

  if (options.mode === 'bypassPermissions' && options.subject.requiresBypassConfirmation) {
    return { behavior: 'ask', source: 'circuit_breaker' }
  }

  switch (options.mode) {
    case 'default':
      return { behavior: options.subject.isReadOnly ? 'allow' : 'ask', source: 'mode' }
    case 'acceptEdits':
      return {
        behavior:
          options.subject.isReadOnly ||
          options.subject.name === 'Edit' ||
          options.subject.name === 'Write'
            ? 'allow'
            : 'ask',
        source: 'mode',
      }
    case 'plan':
      return { behavior: options.subject.isReadOnly ? 'allow' : 'deny', source: 'mode' }
    case 'dontAsk':
      return { behavior: 'deny', source: 'mode' }
    case 'bypassPermissions':
      return { behavior: 'allow', source: 'mode' }
  }
}

function matchesRule(rule: string, subject: PermissionSubject): boolean {
  const parsed = rule.match(/^([^()]+?)(?:\((.*)\))?$/)
  if (!parsed) return false
  const namePattern = parsed[1]?.trim()
  if (!namePattern || !matchesWildcard(namePattern, subject.name)) return false
  const specifier = parsed[2]
  return specifier === undefined || subject.matchesSpecifier(specifier)
}

function matchesWildcard(pattern: string, value: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`).test(value)
}
