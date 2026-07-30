import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadProviderCredential, saveProviderCredential } from '../../src/config/credentials.js'

describe('provider credentials', () => {
  it('persists provider keys in an owner-only credential file', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'dock-credentials-'))

    await saveProviderCredential({ apiKey: 'first-secret', homeDir, providerName: 'deepseek' })
    await saveProviderCredential({ apiKey: 'second-secret', homeDir, providerName: 'gateway' })

    await expect(loadProviderCredential({ homeDir, providerName: 'deepseek' })).resolves.toBe(
      'first-secret',
    )
    await expect(loadProviderCredential({ homeDir, providerName: 'gateway' })).resolves.toBe(
      'second-secret',
    )
    const fileStats = await stat(join(homeDir, '.dock', '.credentials.json'))
    expect(fileStats.mode & 0o777).toBe(0o600)
  })
})
