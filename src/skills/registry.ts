import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import fg from 'fast-glob'
import { parse } from 'yaml'

export type SkillSource = 'user-agents' | 'user-dock' | 'project-agents' | 'project-dock'
export type SkillDefinition = {
  baseDir: string
  description: string
  location: string
  name: string
  scope: 'user' | 'project'
  source: SkillSource
  projectRelativeLocation?: string
}

export function isSkillResourcePath(registry: SkillRegistry, path: string): boolean {
  const target = resolve(path)
  return registry.skills.some((skill) => {
    const fromBase = relative(skill.baseDir, target)
    return fromBase === '' || (!fromBase.startsWith('..') && !isAbsolute(fromBase))
  })
}
export type SkillDiagnostic = {
  code: 'invalid' | 'shadowed' | 'warning' | 'catalog-omitted'
  message: string
  path: string
}
export type SkillRegistry = {
  diagnostics: SkillDiagnostic[]
  roots: readonly string[]
  skills: SkillDefinition[]
}

const MAX_SCAN_DEPTH = 6
const MAX_FILES_PER_ROOT = 2_000

export async function discoverSkills(options: {
  homeDir: string
  projectRoot: string
}): Promise<SkillRegistry> {
  const roots: Array<{ path: string; scope: SkillDefinition['scope']; source: SkillSource }> = [
    { path: join(options.homeDir, '.agents', 'skills'), scope: 'user', source: 'user-agents' },
    { path: join(options.homeDir, '.dock', 'skills'), scope: 'user', source: 'user-dock' },
    {
      path: join(options.projectRoot, '.agents', 'skills'),
      scope: 'project',
      source: 'project-agents',
    },
    {
      path: join(options.projectRoot, '.dock', 'skills'),
      scope: 'project',
      source: 'project-dock',
    },
  ]
  const diagnostics: SkillDiagnostic[] = []
  const winners = new Map<string, SkillDefinition>()

  for (const root of roots) {
    const matches = (
      await fg('**/SKILL.md', {
        cwd: root.path,
        deep: MAX_SCAN_DEPTH,
        followSymbolicLinks: false,
        ignore: ['**/.git/**', '**/node_modules/**'],
        onlyFiles: true,
        unique: true,
      })
    )
      .sort()
      .slice(0, MAX_FILES_PER_ROOT)
    for (const relativePath of matches) {
      const location = resolve(root.path, relativePath)
      let parsed: { name: string; description: string }
      try {
        parsed = parseSkillMetadata(await readFile(location, 'utf8'))
      } catch (error) {
        diagnostics.push({
          code: 'invalid',
          message: error instanceof Error ? error.message : String(error),
          path: location,
        })
        continue
      }
      if (parsed.name !== basename(dirname(location))) {
        diagnostics.push({
          code: 'warning',
          message: `Skill name ${parsed.name} does not match directory ${basename(dirname(location))}`,
          path: location,
        })
      }
      if (parsed.name.length > 64) {
        diagnostics.push({
          code: 'warning',
          message: `Skill name exceeds 64 characters: ${parsed.name}`,
          path: location,
        })
      }
      const definition: SkillDefinition = {
        baseDir: dirname(location),
        description: parsed.description,
        location,
        name: parsed.name,
        scope: root.scope,
        source: root.source,
        ...(root.scope === 'project'
          ? { projectRelativeLocation: relative(resolve(options.projectRoot), location) }
          : {}),
      }
      const previous = winners.get(definition.name)
      if (previous) {
        diagnostics.push({
          code: 'shadowed',
          message: `${previous.location} is shadowed by ${definition.location}`,
          path: previous.location,
        })
      }
      winners.set(definition.name, definition)
    }
  }
  return {
    diagnostics,
    roots: roots.map((root) => resolve(root.path)),
    skills: [...winners.values()].sort((a, b) => a.name.localeCompare(b.name)),
  }
}

export function inheritedSkillRegistry(
  skills: readonly SkillDefinition[],
  projectRoot: string,
): SkillRegistry {
  return {
    diagnostics: [],
    roots: [],
    skills: skills.map((skill) => {
      if (skill.scope !== 'project' || !skill.projectRelativeLocation) return { ...skill }
      const location = resolve(projectRoot, skill.projectRelativeLocation)
      return { ...skill, baseDir: dirname(location), location }
    }),
  }
}

export function parseSkillMetadata(contents: string): { name: string; description: string } {
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) throw new Error('Missing YAML frontmatter')
  let value: unknown
  try {
    value = parse(match[1] ?? '') as unknown
  } catch (original) {
    try {
      value = parse(repairScalarColons(match[1] ?? '')) as unknown
    } catch {
      throw original
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Frontmatter must be a YAML mapping')
  const record = value as Record<string, unknown>
  const name = typeof record.name === 'string' ? singleLine(record.name) : ''
  const description = typeof record.description === 'string' ? singleLine(record.description) : ''
  if (!name) throw new Error('Missing required field `name`')
  if (!description) throw new Error('Missing required field `description`')
  return { name, description }
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function repairScalarColons(frontmatter: string): string {
  return frontmatter
    .split('\n')
    .map((line) => {
      const match = line.match(/^(\s*(?:name|description)\s*:\s*)(.+)$/)
      if (!match?.[2]?.includes(':') || /^['"|>]/.test(match[2].trim())) return line
      return `${match[1]}${JSON.stringify(match[2])}`
    })
    .join('\n')
}
