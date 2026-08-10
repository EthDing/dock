import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createSessionId } from '../../src/sessions/ids.js'
import { SessionWriter, getSessionPath } from '../../src/sessions/session-store.js'
it('recovers dead process locks, but not a live or malformed owner', async () => {
  const location = {
    configDir: await mkdtemp(join(tmpdir(), 'dock-lock-')),
    cwd: '/work',
    sessionId: createSessionId(),
  }
  const writer = await SessionWriter.create(location)
  await writer.close()
  const path = `${getSessionPath(location)}.lock`
  await writeFile(path, JSON.stringify({ pid: 2147483647 }))
  const resumed = await SessionWriter.open(location)
  await resumed.close()
  await writeFile(path, JSON.stringify({ pid: process.pid }))
  await expect(SessionWriter.open(location)).rejects.toThrow('already open')
  await writeFile(path, 'broken')
  await expect(SessionWriter.open(location)).rejects.toThrow()
})
