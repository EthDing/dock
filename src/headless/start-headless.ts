import type { AgentLoopResult } from '../agent/run-agent-loop.js'
import { combineHeadlessPrompt, type CliOptions } from '../cli-options.js'
import { createDockRuntime, type CreateDockRuntimeOptions } from '../runtime/create-runtime.js'
import type { UiEvent } from '../ui/contracts.js'
import {
  createInitEvent,
  finalText,
  resultForLoop,
  safeHeadlessText,
  streamEventForAgentEvent,
  type HeadlessResult,
  type HeadlessStreamEvent,
} from './output.js'

export type HeadlessIo = {
  stderr: (chunk: string) => void
  stdout: (chunk: string) => void
}

export async function startHeadless(
  options: CreateDockRuntimeOptions & {
    cli: CliOptions
    stdin?: string
    io: HeadlessIo
    signal?: AbortSignal
  },
): Promise<number> {
  if (!options.cli.print) throw new Error('Headless runner requires --print')
  const prompt = combineHeadlessPrompt(options.cli.prompt, options.stdin ?? '')
  const runtime = await createDockRuntime(options)
  const info = runtime.controller.getViewInfo()
  if (!info.sessionId) {
    await runtime.close()
    throw new Error('Headless runtime did not provide a session ID')
  }
  for (const notice of runtime.startupNotices) options.io.stderr(`${safeHeadlessText(notice)}\n`)
  if (options.cli.outputFormat === 'stream-json') {
    writeJsonLine(
      options.io,
      createInitEvent({
        sessionId: info.sessionId,
        cwd: info.cwd,
        model: info.modelReference,
        permissionMode: info.permissionMode,
      }),
    )
  }
  let end: Pick<AgentLoopResult, 'reason' | 'error'> = {
    reason: 'model_error',
    error: 'Headless execution ended without a result',
  }
  const abort = () => runtime.controller.abort(options.signal?.reason ?? 'interrupt')
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  try {
    if (options.signal?.aborted) {
      end = { reason: 'aborted' }
    } else {
      for await (const event of runtime.controller.submit(prompt, {
        ...(options.cli.maxTurns !== undefined ? { maxTurns: options.cli.maxTurns } : {}),
      })) {
        if (event.type === 'turn_end') {
          end = event.result
          continue
        }
        if (event.type === 'turn_start' || options.cli.outputFormat !== 'stream-json') continue
        const output = streamEventForAgentEvent(
          event as Exclude<UiEvent, { type: 'turn_start' | 'turn_end' }>,
          info.sessionId,
        )
        if (output) writeJsonLine(options.io, output)
      }
    }
    const loopResult: AgentLoopResult = {
      ...end,
      messages: runtime.controller.messages,
    }
    const output = resultForLoop(loopResult, {
      sessionId: info.sessionId,
      result: finalText(runtime.controller.messages),
    })
    writeFinal(options.cli.outputFormat, output, options.io)
    return output.is_error ? (output.subtype === 'error_aborted' ? 130 : 1) : 0
  } finally {
    options.signal?.removeEventListener('abort', abort)
    await runtime.close()
  }
}

function writeFinal(
  format: CliOptions['outputFormat'],
  result: HeadlessResult,
  io: HeadlessIo,
): void {
  if (format === 'text') {
    if (result.is_error) io.stderr(`${safeHeadlessText(result.error)}\n`)
    else io.stdout(`${safeHeadlessText(result.result)}\n`)
    return
  }
  if (format === 'json') io.stdout(`${JSON.stringify(result)}\n`)
  else writeJsonLine(io, result)
}

function writeJsonLine(io: HeadlessIo, event: HeadlessStreamEvent): void {
  io.stdout(`${JSON.stringify(event)}\n`)
}
