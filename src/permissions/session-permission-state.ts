import type { JsonObject } from '../model/types.js'
import type { AgentTool } from '../tools/types.js'

export class SessionPermissionState {
  readonly #allowedCalls = new Set<string>()

  allow(tool: AgentTool, input: JsonObject): void {
    this.#allowedCalls.add(fingerprint(tool, input))
  }

  isAllowed(tool: AgentTool, input: JsonObject): boolean {
    return this.#allowedCalls.has(fingerprint(tool, input))
  }
}

function fingerprint(tool: AgentTool, input: JsonObject): string {
  return `${tool.name}:${stableStringify(input)}`
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
