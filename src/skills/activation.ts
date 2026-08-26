import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { SkillContext } from '../messages/create-message.js'
import type { TranscriptMessage } from '../messages/create-message.js'
import type { AgentTool, AgentToolResult } from '../tools/types.js'
import { parseSkillMetadata, type SkillRegistry } from './registry.js'

const WARN_CHARS = 20_000
const MAX_CHARS = 40_000
const CATALOG_CHARS = 8_000

export type SkillActivationContext = {
  skillContext: SkillContext
  text: string
}
export type SkillActivationResult = AgentToolResult & {
  context?: SkillActivationContext
}

export class SkillActivator {
  readonly #active = new Map<string, string>()
  constructor(
    readonly registry: SkillRegistry,
    messages: readonly TranscriptMessage[] = [],
  ) {
    for (const message of messages)
      if (message.type === 'user' && message.skillContext)
        this.#active.set(message.skillContext.name, message.skillContext.contentHash)
  }

  async activate(name: string, invocationInput?: string): Promise<SkillActivationResult> {
    const skill = this.registry.skills.find((candidate) => candidate.name === name)
    if (!skill) return { content: `Unknown Skill: ${name}`, isError: true }
    let raw: string
    try {
      raw = await readFile(skill.location, 'utf8')
    } catch (error) {
      return {
        content: `Failed to load Skill ${name}: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      }
    }
    if (raw.length > MAX_CHARS)
      return { content: `Skill ${name} exceeds the 10,000 token safety limit`, isError: true }
    try {
      const current = parseSkillMetadata(raw)
      if (current.name !== name)
        return {
          content: `Skill ${name} changed its declared name; restart Dock to refresh`,
          isError: true,
        }
    } catch (error) {
      return { content: `Skill ${name} is no longer valid: ${String(error)}`, isError: true }
    }
    const hash = createHash('sha256').update(raw).digest('hex')
    if (this.#active.get(name) === hash) {
      return {
        content: `Skill ${name} is already active${invocationInput ? `\nInvocation input: ${invocationInput}` : ''}`,
      }
    }
    this.#active.set(name, hash)
    const text = [
      `<skill_content name=${JSON.stringify(name)} location=${JSON.stringify(skill.location)}>`,
      `Skill directory: ${skill.baseDir}`,
      'Resolve relative paths against this directory.',
      '',
      raw,
      invocationInput ? `\n<invocation_input>${invocationInput}</invocation_input>` : '',
      '</skill_content>',
    ].join('\n')
    return {
      content: `Loaded Skill: ${name}${raw.length > WARN_CHARS ? ' (large Skill)' : ''}`,
      context: {
        skillContext: { contentHash: hash, location: skill.location, name },
        text,
      },
    }
  }
}

export function createSkillTool(activator: SkillActivator, registry: SkillRegistry): AgentTool {
  const visible = visibleCatalog(registry)
  const names = visible.map((skill) => skill.name)
  const input = z.strictObject({ name: z.enum(names as [string, ...string[]]) })
  return {
    name: 'Skill',
    description: [
      'Loads specialized instructions for the current task. Call this before proceeding when a Skill description matches the request.',
      '',
      ...visible.map((skill) => `- ${skill.name}: ${skill.description}`),
    ].join('\n'),
    inputSchema: {
      additionalProperties: false,
      properties: { name: { enum: names, type: 'string' } },
      required: ['name'],
      type: 'object',
    },
    parseInput: (value) => input.parse(value),
    checkPermissions: () => ({ behavior: 'allow', source: 'tool' }),
    getPermissionRule: (value) => `Skill(${String(value.name)})`,
    isConcurrencySafe: () => false,
    execute: async (value) => activator.activate(String(value.name)),
  }
}

function visibleCatalog(registry: SkillRegistry) {
  let used = 0
  const result = []
  for (const skill of registry.skills) {
    const fixed = `- ${skill.name}: `
    const remaining = CATALOG_CHARS - used - fixed.length
    if (remaining <= 0) {
      registry.diagnostics.push({
        code: 'catalog-omitted',
        message: 'Omitted from the model catalog because the context budget is full',
        path: skill.location,
      })
      continue
    }
    const description = skill.description.slice(0, remaining)
    result.push({ ...skill, description })
    used += fixed.length + description.length + 1
  }
  return result
}
