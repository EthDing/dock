import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { ToolOutcome } from '../agent/run-agent-loop.js'
import {
  type AssistantTranscriptMessage,
  createAssistantMessage,
  createUserMessage,
  type TranscriptMessage,
} from '../messages/create-message.js'
import type { TextBlock, ThinkingBlock, ToolResultBlock, ToolUseBlock } from '../model/types.js'
import type { SessionId } from '../sessions/ids.js'
import type { UiEvent } from './contracts.js'

export type ToolDisplay = {
  call?: ToolUseBlock
  result?: ToolResultBlock
  status: ToolOutcome | 'queued' | 'running' | 'permission'
  revision: number
}
export type MessageItem = {
  kind: 'message'
  key: string
  message: TranscriptMessage
  revision: number
  pending?: boolean
  partial?: boolean
}
export type NoticeItem = {
  kind: 'notice'
  key: string
  text: string
  error: boolean
  revision: number
}
export type DisplayItem = MessageItem | NoticeItem
type Stream = {
  item: MessageItem
  blocks: Array<TextBlock | ThinkingBlock | ToolUseBlock>
  inputs: Map<number, string>
}
export class TranscriptState {
  readonly items: DisplayItem[] = []
  readonly #byUuid = new Map<string, MessageItem>()
  readonly #tools = new Map<string, ToolDisplay>()
  readonly #streams = new Map<string, Stream>()
  revision = 0
  status: 'ready' | 'working' | 'compacting' | 'failed' | 'interrupted' = 'ready'
  constructor(readonly sessionId?: SessionId) {}
  tool(id: string): ToolDisplay | undefined {
    return this.#tools.get(id)
  }
  setMessages(messages: readonly TranscriptMessage[]): void {
    this.items.length = 0
    this.#byUuid.clear()
    this.#tools.clear()
    this.#streams.clear()
    for (const message of messages) this.addMessage(message)
    this.revision++
  }
  addPrompt(text: string): void {
    const item = this.addMessage(createUserMessage({ content: [{ type: 'text', text }] }))
    item.pending = true
  }
  notice(text: string, error = false, key = randomUUID() as string): void {
    if (this.items.some((item) => item.key === key)) return
    this.items.push({ kind: 'notice', key, text, error, revision: 0 })
    this.revision++
  }
  addMessage(message: TranscriptMessage, streamKey?: string): MessageItem {
    const clone = structuredClone(message)
    let item = this.#byUuid.get(message.uuid)
    const stream = streamKey ? this.#streams.get(streamKey) : undefined
    if (message.type === 'assistant' && stream) {
      if (item && item !== stream.item) this.items.splice(this.items.indexOf(stream.item), 1)
      else item = stream.item
      this.#byUuid.delete(stream.item.message.uuid)
      this.#streams.delete(streamKey as string)
    }
    // Reconcile only a pending echo; property order is not content identity.
    // Committed messages with equal text still remain separate user submissions.
    if (!item && message.type === 'user' && !message.isMeta && !message.isCompactSummary) {
      item = this.items.findLast(
        (entry): entry is MessageItem =>
          entry.kind === 'message' &&
          entry.pending === true &&
          entry.message.type === 'user' &&
          isDeepStrictEqual(entry.message.message.content, message.message.content),
      )
      if (item) this.#byUuid.delete(item.message.uuid)
    }
    if (item) {
      item.message = clone
      item.pending = false
      item.partial = false
      item.revision++
    } else {
      item = { kind: 'message', key: message.uuid, message: clone, revision: 0 }
      this.items.push(item)
    }
    this.#byUuid.set(message.uuid, item)
    for (const block of message.message.content) {
      if (block.type === 'tool_use') {
        const tool = this.#tools.get(block.id) ?? { status: 'queued' as const, revision: 0 }
        tool.call = structuredClone(block)
        tool.revision++
        this.#tools.set(block.id, tool)
      } else if (block.type === 'tool_result') {
        const tool = this.#tools.get(block.toolUseId) ?? {
          status: block.isError ? ('error' as const) : ('success' as const),
          revision: 0,
        }
        tool.result = structuredClone(block)
        if (['queued', 'running', 'permission'].includes(tool.status))
          tool.status = block.isError ? 'error' : 'success'
        tool.revision++
        this.#tools.set(block.toolUseId, tool)
      }
    }
    this.revision++
    return item
  }
  setPermission(id: string | undefined, waiting: boolean): void {
    if (!id) return
    const tool = this.#tools.get(id)
    if (tool) {
      tool.status = waiting ? 'permission' : 'running'
      tool.revision++
      this.revision++
    }
  }
  apply(event: UiEvent): boolean {
    if (this.sessionId && event.sessionId && event.sessionId !== this.sessionId) return false
    const key = event.operationId ?? 'main'
    if (event.type === 'turn_start') this.status = 'working'
    else if (event.type === 'turn_end') {
      this.status =
        event.result.reason === 'completed'
          ? 'ready'
          : event.result.reason === 'aborted'
            ? 'interrupted'
            : 'failed'
      for (const stream of this.#streams.values()) {
        stream.item.partial = event.result.reason !== 'completed'
        stream.item.revision++
      }
      this.#streams.clear()
      if (event.result.reason !== 'completed')
        this.notice(
          event.result.reason === 'aborted'
            ? 'Interrupted'
            : (event.result.error ?? `Turn ended: ${event.result.reason}`),
          event.result.reason !== 'aborted',
        )
    } else if (event.type === 'assistant_message' || event.type === 'user_message')
      this.addMessage(event.message, event.type === 'assistant_message' ? key : undefined)
    else if (event.type === 'model_stream') {
      const data = event.event
      if (data.type === 'message_start') {
        this.#streams.delete(key)
        this.#newStream(key, data.messageId)
      } else if (data.type === 'content_block_start') {
        const stream = this.#streams.get(key) ?? this.#newStream(key, 'stream')
        stream.blocks[data.index] =
          data.block.type === 'text'
            ? { type: 'text', text: '' }
            : data.block.type === 'thinking'
              ? { type: 'thinking', thinking: '' }
              : { type: 'tool_use', id: data.block.id, name: data.block.name, input: {} }
        this.#touch(stream)
      } else if (data.type === 'content_block_delta') {
        const stream = this.#streams.get(key) ?? this.#newStream(key, 'stream')
        let block = stream.blocks[data.index]
        if (!block) {
          block =
            data.delta.type === 'thinking_delta'
              ? { type: 'thinking', thinking: '' }
              : { type: 'text', text: '' }
          stream.blocks[data.index] = block
        }
        if (data.delta.type === 'text_delta' && block.type === 'text') block.text += data.delta.text
        else if (data.delta.type === 'thinking_delta' && block.type === 'thinking')
          block.thinking += data.delta.thinking
        else if (data.delta.type === 'input_json_delta' && block.type === 'tool_use') {
          const input = (stream.inputs.get(data.index) ?? '') + data.delta.partialJson
          stream.inputs.set(data.index, input)
          try {
            block.input = JSON.parse(input)
          } catch {
            /* Tool inputs are provisional until the assistant message commits. */
          }
        }
        this.#touch(stream)
      }
    } else if (event.type === 'tool_execution_start') {
      const tool = this.#tools.get(event.toolUse.id) ?? { status: 'running' as const, revision: 0 }
      tool.call = structuredClone(event.toolUse)
      tool.status = 'running'
      tool.revision++
      this.#tools.set(event.toolUse.id, tool)
      if (
        !this.items.some(
          (item) =>
            item.kind === 'message' &&
            item.message.message.content.some(
              (block) => block.type === 'tool_use' && block.id === event.toolUse.id,
            ),
        )
      )
        this.addMessage(
          createAssistantMessage({
            id: randomUUID(),
            role: 'assistant',
            content: [event.toolUse],
            stopReason: 'tool_use',
            usage: {},
          }),
        )
    } else if (event.type === 'tool_result') {
      const tool = this.#tools.get(event.result.toolUseId) ?? {
        status: 'success' as const,
        revision: 0,
      }
      tool.result = structuredClone(event.result)
      tool.status = event.outcome ?? (event.result.isError ? 'error' : 'success')
      tool.revision++
      this.#tools.set(event.result.toolUseId, tool)
    } else if (event.type === 'compact') {
      for (const message of event.messages) this.addMessage(message)
      this.status = 'working'
    } else if (event.type === 'compaction_status') {
      this.status =
        event.status === 'started'
          ? 'compacting'
          : event.status === 'cancelled'
            ? 'interrupted'
            : 'failed'
      if (event.status !== 'started')
        this.notice(
          event.status === 'cancelled'
            ? 'Compaction cancelled'
            : `Compaction failed: ${event.message ?? 'Unknown error'}`,
          event.status === 'failed',
        )
    }
    this.revision++
    return true
  }
  #newStream(key: string, id: string): Stream {
    const message = createAssistantMessage({
      role: 'assistant',
      id,
      usage: {},
      stopReason: 'end_turn',
      content: [],
    })
    const item: MessageItem = { kind: 'message', key: message.uuid, message, revision: 0 }
    this.items.push(item)
    this.#byUuid.set(message.uuid, item)
    const stream = { item, blocks: [], inputs: new Map<number, string>() }
    this.#streams.set(key, stream)
    return stream
  }
  #touch(stream: Stream): void {
    ;(stream.item.message as AssistantTranscriptMessage).message.content = stream.blocks
    stream.item.revision++
  }
}
