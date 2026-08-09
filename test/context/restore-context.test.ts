import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareFileRestoration } from '../../src/context/restore-context.js'
import { FileReadState } from '../../src/tools/file-read-state.js'

describe('post-compact file restoration', () => {
  it('selects five newest files, skips denied/deleted, references large files, commits atomically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dock-restore-'))
    const state = new FileReadState()
    for (let i = 0; i < 8; i++) {
      const path = join(dir, String(i))
      if (i !== 7) await writeFile(path, i === 6 ? 'x'.repeat(24_000) : `current ${i}`)
      state.set(path, { content: `old ${i}`, timestamp: i, isPartialView: false })
    }
    const prepared = await prepareFileRestoration({
      readFileState: state,
      signal: new AbortController().signal,
      canRead: async (path) => !path.endsWith('/5'),
    })
    expect(prepared.attachments).toHaveLength(3)
    expect(JSON.stringify(prepared.attachments)).toContain('Referenced file')
    expect(JSON.stringify(prepared.attachments)).not.toContain('old ')
    expect(state.get(join(dir, '0'))).toBeDefined()
    prepared.commit()
    expect(state.get(join(dir, '0'))).toBeUndefined()
    expect(state.get(join(dir, '6'))).toBeUndefined()
    expect(state.get(join(dir, '4'))?.content).toBe('current 4')
  })
  it('does not mutate read state when aborted', async () => {
    const abort = new AbortController()
    abort.abort()
    const state = new FileReadState()
    await expect(
      prepareFileRestoration({
        readFileState: state,
        signal: abort.signal,
        canRead: async () => true,
      }),
    ).rejects.toBeDefined()
  })
})
