import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileHistory } from '../../src/checkpoint/file-history.js'
import { asMessageUuid, asSessionId } from '../../src/sessions/ids.js'

const SESSION_ID = asSessionId('50000000-0000-4000-8000-000000000001')
const FIRST_PROMPT = asMessageUuid('60000000-0000-4000-8000-000000000001')
const SECOND_PROMPT = asMessageUuid('60000000-0000-4000-8000-000000000002')

describe('FileHistory', () => {
  it('restores modified files and deletes files created after a checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-checkpoint-'))
    const configDir = join(root, 'config')
    const cwd = join(root, 'project')
    const existing = join(cwd, 'existing.txt')
    const created = join(cwd, 'created.txt')
    await mkdir(cwd, { recursive: true })
    await writeFile(existing, 'before')
    const history = new FileHistory({ configDir, cwd, sessionId: SESSION_ID })

    await history.makeSnapshot(FIRST_PROMPT)
    await history.trackEdit(existing, FIRST_PROMPT)
    await history.trackEdit(created, FIRST_PROMPT)
    await writeFile(existing, 'after')
    await writeFile(created, 'new')
    await history.makeSnapshot(SECOND_PROMPT)

    const changed = await history.rewind(FIRST_PROMPT)

    expect(changed.sort()).toEqual([created, existing].sort())
    expect(await readFile(existing, 'utf8')).toBe('before')
    await expect(readFile(created, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps no more than 100 prompt snapshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-checkpoint-limit-'))
    const history = new FileHistory({
      configDir: join(root, 'config'),
      cwd: root,
      sessionId: SESSION_ID,
    })

    for (let index = 0; index < 101; index += 1) {
      const suffix = index.toString(16).padStart(12, '0')
      await history.makeSnapshot(asMessageUuid(`70000000-0000-4000-8000-${suffix}`))
    }

    expect(history.state.snapshots).toHaveLength(100)
    expect(history.state.snapshots[0]?.messageId).not.toBe(
      asMessageUuid('70000000-0000-4000-8000-000000000000'),
    )
  })
})
