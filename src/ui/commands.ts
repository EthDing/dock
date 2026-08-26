import type { AutocompleteProvider } from '@dock/tui'

type Command = { name: string; description: string; run: (args: string) => Promise<void> }
export class CommandRegistry {
  readonly #commands = new Map<string, Command>()
  register(name: string, description: string, run: Command['run']): void {
    this.#commands.set(name, { name, description, run })
  }
  has(name: string): boolean {
    return this.#commands.has(name)
  }
  remove(name: string): void {
    this.#commands.delete(name)
  }
  async execute(text: string): Promise<void> {
    const match = text.match(/^\/(\S+)\s*([\s\S]*)$/),
      name = match?.[1] ?? '',
      command = this.#commands.get(name)
    if (!command) throw new Error(`Unknown command /${name}. Use /help.`)
    await command.run(match?.[2] ?? '')
  }
  help(): string {
    return [...this.#commands.values()].map((c) => `/${c.name}  ${c.description}`).join('\n')
  }
  readonly autocomplete: AutocompleteProvider = {
    triggerCharacters: [],
    shouldTriggerFileCompletion: () => false,
    getSuggestions: async (lines, line, col) => {
      const prefix = (lines[line] ?? '').slice(0, col)
      if (line !== 0 || !/^\/\S*$/.test(prefix)) return null
      return {
        prefix,
        items: [...this.#commands.values()]
          .filter((c) => c.name.startsWith(prefix.slice(1)))
          .map((c) => ({ value: c.name, label: `/${c.name}`, description: c.description })),
      }
    },
    applyCompletion: (lines, line, col, item, prefix) => {
      const result = [...lines],
        value = `/${item.value} `
      result[line] =
        (lines[line] ?? '').slice(0, col - prefix.length) + value + (lines[line] ?? '').slice(col)
      return { lines: result, cursorLine: line, cursorCol: col - prefix.length + value.length }
    },
  }
}
