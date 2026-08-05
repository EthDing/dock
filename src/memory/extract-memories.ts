import { resolve } from 'node:path'
import { runAgentLoop } from '../agent/run-agent-loop.js'
import { createUserMessage, type TranscriptMessage } from '../messages/create-message.js'
import type { ModelAdapter } from '../model/types.js'
import { isReadOnlyBashCommand } from '../tools/bash-tool.js'
import type { AgentTool, CanUseTool } from '../tools/types.js'
import type { MemoryManager } from './memory-manager.js'

type ExtractMemoriesOptions = {
  maxOutputTokens?: number
  memory: MemoryManager
  model: ModelAdapter
  modelId: string
  onSaved?: (paths: readonly string[]) => Promise<void> | void
  systemPrompt: readonly string[]
  tools: readonly AgentTool[]
  userContext?: Readonly<Record<string, string>>
}

export class ExtractMemories {
  readonly #memory: MemoryManager
  readonly #model: ModelAdapter
  readonly #modelId: string
  readonly #maxOutputTokens: number | undefined
  readonly #onSaved: ((paths: readonly string[]) => Promise<void> | void) | undefined
  readonly #systemPrompt: readonly string[]
  readonly #tools: readonly AgentTool[]
  readonly #userContext: Readonly<Record<string, string>> | undefined
  #lastMemoryMessageUuid: string | undefined
  #pendingMessages: readonly TranscriptMessage[] | undefined
  #running: Promise<void> | undefined

  constructor(options: ExtractMemoriesOptions) {
    this.#memory = options.memory
    this.#model = options.model
    this.#modelId = options.modelId
    this.#maxOutputTokens = options.maxOutputTokens
    this.#onSaved = options.onSaved
    this.#systemPrompt = options.systemPrompt
    this.#tools = options.tools
    this.#userContext = options.userContext
  }

  schedule(messages: readonly TranscriptMessage[]): void {
    if (!this.#memory.enabled) return
    const snapshot = [...messages]
    if (this.#running) {
      // The newest snapshot contains every earlier unprocessed message, so one
      // trailing run is enough even when several turns finish during extraction.
      this.#pendingMessages = snapshot
      return
    }
    this.#running = this.#runChain(snapshot).finally(() => {
      this.#running = undefined
    })
  }

  async drain(timeoutMs = 60_000): Promise<void> {
    const running = this.#running
    if (!running) return
    let timeout: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        running,
        new Promise<void>((resolveTimeout) => {
          timeout = setTimeout(resolveTimeout, timeoutMs)
          timeout.unref()
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  async #runChain(initialMessages: readonly TranscriptMessage[]): Promise<void> {
    let messages: readonly TranscriptMessage[] | undefined = initialMessages
    while (messages) {
      try {
        await this.#runOnce(messages)
      } catch {
        // Best effort: leave the cursor unchanged so a later turn can retry.
      }
      messages = this.#pendingMessages
      this.#pendingMessages = undefined
    }
  }

  async #runOnce(messages: readonly TranscriptMessage[]): Promise<void> {
    const newMessages = messagesAfter(messages, this.#lastMemoryMessageUuid)
    if (newMessages.length === 0) return
    const lastMessage = messages.at(-1)
    if (hasMemoryWrite(newMessages, this.#memory)) {
      this.#lastMemoryMessageUuid = lastMessage?.uuid
      return
    }

    const manifest = await this.#memory.scanManifest()
    const extractionPrompt = createUserMessage({
      content: [
        {
          text: buildExtractionPrompt({
            manifest,
            memoryDirectory: this.#memory.directory,
            messageCount: newMessages.length,
          }),
          type: 'text',
        },
      ],
    })
    const baseMessages = [...messages, extractionPrompt]
    // Keep the parent's model-visible prompt, history prefix, and tool schemas.
    // Enforcement changes through canUseTool so provider prompt caches can reuse
    // the shared prefix instead of seeing a different tool surface.
    const generator = runAgentLoop({
      canUseTool: createMemoryCanUseTool(this.#memory),
      ...(this.#maxOutputTokens ? { maxOutputTokens: this.#maxOutputTokens } : {}),
      maxTurns: 5,
      messages: baseMessages,
      model: this.#model,
      modelId: this.#modelId,
      systemPrompt: this.#systemPrompt,
      tools: this.#tools,
      ...(this.#userContext ? { userContext: this.#userContext } : {}),
    })
    let next = await generator.next()
    while (!next.done) next = await generator.next()
    if (next.value.reason !== 'completed') return

    this.#lastMemoryMessageUuid = lastMessage?.uuid
    const writtenPaths = extractWrittenPaths(
      next.value.messages.slice(baseMessages.length),
      this.#memory,
    )
    if (writtenPaths.length > 0) await this.#onSaved?.(writtenPaths)
  }
}

export function createMemoryCanUseTool(memory: MemoryManager): CanUseTool {
  return async (tool, input) => {
    if (tool.name === 'Read' || tool.name === 'Glob' || tool.name === 'Grep') {
      return { behavior: 'allow' }
    }
    if (
      tool.name === 'Bash' &&
      typeof input.command === 'string' &&
      isReadOnlyBashCommand(input.command)
    ) {
      return { behavior: 'allow' }
    }
    if (
      (tool.name === 'Write' || tool.name === 'Edit') &&
      typeof input.file_path === 'string' &&
      memory.isMemoryPath(input.file_path)
    ) {
      return { behavior: 'allow' }
    }
    return {
      behavior: 'deny',
      message: `ExtractMemories may only read, run read-only Bash, and write inside ${memory.directory}`,
    }
  }
}

function messagesAfter(
  messages: readonly TranscriptMessage[],
  uuid: string | undefined,
): readonly TranscriptMessage[] {
  if (!uuid) return messages
  const index = messages.findIndex((message) => message.uuid === uuid)
  return index < 0 ? messages : messages.slice(index + 1)
}

function hasMemoryWrite(messages: readonly TranscriptMessage[], memory: MemoryManager): boolean {
  return messages.some(
    (message) =>
      message.type === 'assistant' &&
      message.message.content.some(
        (block) =>
          block.type === 'tool_use' &&
          (block.name === 'Write' || block.name === 'Edit') &&
          typeof block.input.file_path === 'string' &&
          memory.isMemoryPath(block.input.file_path),
      ),
  )
}

function extractWrittenPaths(
  messages: readonly TranscriptMessage[],
  memory: MemoryManager,
): string[] {
  const paths = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    for (const block of message.message.content) {
      if (
        block.type !== 'tool_use' ||
        (block.name !== 'Write' && block.name !== 'Edit') ||
        typeof block.input.file_path !== 'string' ||
        !memory.isMemoryPath(block.input.file_path)
      ) {
        continue
      }
      const filePath = resolve(block.input.file_path)
      if (filePath !== resolve(memory.entrypoint)) paths.add(filePath)
    }
  }
  return [...paths]
}

function buildExtractionPrompt(options: {
  manifest: Awaited<ReturnType<MemoryManager['scanManifest']>>
  memoryDirectory: string
  messageCount: number
}): string {
  return `Review only the most recent ${options.messageCount} messages for durable information worth saving to auto memory.

You have a limited budget. Use the existing auto-memory rules from your system prompt. Read every existing topic you may update in one parallel batch, then perform writes in one batch. Do not investigate the repository or verify the user's statements. Save only durable, non-derivable information. Update an existing topic instead of creating a duplicate. If nothing is worth saving, finish without writing.

Memory directory: ${options.memoryDirectory}
Existing memory manifest:
${JSON.stringify(options.manifest, null, 2)}`
}
