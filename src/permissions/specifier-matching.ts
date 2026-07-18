import { relative, resolve } from 'node:path'

export function matchesWildcard(pattern: string, value: string): boolean {
  const source = pattern.split('*').map(escapeRegExp).join('.*')
  return new RegExp(`^${source}$`).test(value)
}

export function matchesPathSpecifier(pattern: string, filePath: string, cwd: string): boolean {
  const normalizedPattern = normalizePath(pattern.trim())
  const absoluteFile = normalizePath(resolve(filePath))
  const relativeFile = normalizePath(relative(resolve(cwd), resolve(filePath)))

  if (normalizedPattern.startsWith('//')) {
    return matchesWildcard(normalizedPattern.slice(1), absoluteFile)
  }
  if (normalizedPattern.startsWith('/')) {
    return matchesWildcard(normalizePath(resolve(cwd, `.${normalizedPattern}`)), absoluteFile)
  }
  return matchesWildcard(normalizedPattern.replace(/^\.\//, ''), relativeFile)
}

export function matchesCommandSpecifier(pattern: string, command: string): boolean {
  const commands = command.split(/&&|\|\||;|\n|\|(?!\|)/).map((part) => part.trim())
  return commands.some((part) => matchesWildcard(pattern.trim(), part))
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
