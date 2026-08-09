import type {
  AssistantMessage,
  JsonObject,
  ModelAdapter,
  ModelRequest,
  ModelStreamEvent,
  StopReason,
  Usage,
} from './types.js'

type PendingBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'tool_use'; id: string; name: string; partialJson: string }

export async function* streamAssistantResponse(
  model: ModelAdapter,
  request: ModelRequest,
  signal: AbortSignal,
): AsyncGenerator<ModelStreamEvent, AssistantMessage> {
  const blocks = new Map<number, PendingBlock>()
  let messageId: string | undefined
  let stopReason: StopReason | undefined
  let usage: Usage = {}
  signal.throwIfAborted()
  for await (const event of model.stream(request, { signal })) {
    signal.throwIfAborted()
    yield event
    switch (event.type) {
      case 'message_start':
        messageId = event.messageId
        usage = { ...usage, ...event.usage }
        break
      case 'content_block_start':
        blocks.set(
          event.index,
          event.block.type === 'text'
            ? { type: 'text', text: '' }
            : event.block.type === 'thinking'
              ? { type: 'thinking', thinking: '', signature: '' }
              : { type: 'tool_use', id: event.block.id, name: event.block.name, partialJson: '' },
        )
        break
      case 'content_block_delta': {
        const block = blocks.get(event.index)
        if (!block) throw new Error(`Delta for unknown content block ${event.index}`)
        if (block.type === 'text' && event.delta.type === 'text_delta')
          block.text += event.delta.text
        else if (block.type === 'thinking' && event.delta.type === 'thinking_delta')
          block.thinking += event.delta.thinking
        else if (block.type === 'thinking' && event.delta.type === 'signature_delta')
          block.signature += event.delta.signature
        else if (block.type === 'tool_use' && event.delta.type === 'input_json_delta')
          block.partialJson += event.delta.partialJson
        else throw new Error(`Invalid delta ${event.delta.type} for ${block.type} block`)
        break
      }
      case 'content_block_stop':
        if (!blocks.has(event.index))
          throw new Error(`Stop for unknown content block ${event.index}`)
        break
      case 'message_delta':
        stopReason = event.stopReason
        usage = { ...usage, ...event.usage }
        break
      case 'message_stop':
        break
    }
  }
  signal.throwIfAborted()
  if (!messageId || !stopReason) throw new Error('Model stream ended without message metadata')
  const content: AssistantMessage['content'] = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, block]) => {
      if (block.type !== 'tool_use') return block
      let input: unknown
      try {
        input = JSON.parse(block.partialJson || '{}')
      } catch (error) {
        throw new Error(
          `Invalid JSON input for tool ${block.name}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (typeof input !== 'object' || input === null || Array.isArray(input))
        throw new Error(`Tool ${block.name} input must be an object`)
      return {
        type: 'tool_use' as const,
        id: block.id,
        name: block.name,
        input: input as JsonObject,
      }
    })
  return { id: messageId, role: 'assistant', content, stopReason, usage }
}

export async function collectAssistantResponse(
  model: ModelAdapter,
  request: ModelRequest,
  signal: AbortSignal,
): Promise<AssistantMessage> {
  const stream = streamAssistantResponse(model, request, signal)
  let next = await stream.next()
  while (!next.done) next = await stream.next()
  return next.value
}
