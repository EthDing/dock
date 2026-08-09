import { readFile, stat } from 'node:fs/promises'
import { createUserMessage, type UserTranscriptMessage } from '../messages/create-message.js'
import type { FileReadSnapshot, FileReadState } from '../tools/file-read-state.js'

export async function prepareFileRestoration(options: {
  readFileState: FileReadState
  signal: AbortSignal
  canRead: (path: string) => Promise<boolean>
}): Promise<{ attachments: UserTranscriptMessage[]; commit: () => void }> {
  options.signal.throwIfAborted()
  const selected = options.readFileState
    .entries()
    .sort((a, b) => b[1].timestamp - a[1].timestamp)
    .slice(0, 5)
  const restored: Array<[string, FileReadSnapshot]> = []
  const attachments: UserTranscriptMessage[] = []
  let tokens = 0
  for (const [path] of selected) {
    options.signal.throwIfAborted()
    if (!(await options.canRead(path))) continue
    try {
      const [raw, info] = await Promise.all([
        readFile(path, { encoding: 'utf8', signal: options.signal }),
        stat(path),
      ])
      options.signal.throwIfAborted()
      const content = raw.replace(/\r\n/g, '\n')
      const body =
        Math.ceil(content.length / 4) > 5000
          ? `Referenced file: ${path}\nThe file is too large to restore inline; use Read for the needed portion.`
          : `Contents of ${path} (re-read after compaction):\n${content
              .split('\n')
              .map((line, i) => `${i + 1}→${line}`)
              .join('\n')}`
      const size = Math.ceil(body.length / 4)
      if (tokens + size > 50_000) continue
      tokens += size
      attachments.push(
        createUserMessage(
          { content: [{ type: 'text', text: `<system-reminder>\n${body}\n</system-reminder>` }] },
          { isMeta: true },
        ),
      )
      if (Math.ceil(content.length / 4) <= 5000)
        restored.push([path, { content, isPartialView: false, timestamp: info.mtimeMs }])
    } catch (error) {
      options.signal.throwIfAborted()
      if (
        !(
          error instanceof Error &&
          'code' in error &&
          ['ENOENT', 'EACCES', 'EPERM', 'EISDIR'].includes(String(error.code))
        )
      )
        throw error
    }
  }
  return {
    attachments,
    commit: () => {
      options.readFileState.clear()
      for (const [path, snapshot] of restored) options.readFileState.set(path, snapshot)
    },
  }
}
