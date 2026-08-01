import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryManager } from '../../src/memory/memory-manager.js'

describe('MemoryManager', () => {
  it('uses the canonical repository identity so worktrees share memory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-memory-path-'))
    const homeDir = join(root, 'home')
    const configDir = join(homeDir, '.dock')
    const canonicalRoot = join(root, 'repo')
    const worktree = join(root, 'repo-worktree')

    const manager = await MemoryManager.create({
      configDir,
      homeDir,
      projectRoot: worktree,
      resolveCanonicalRoot: async () => canonicalRoot,
      settings: {},
    })

    expect(manager.directory).toContain(join(configDir, 'projects'))
    expect(manager.directory).not.toContain('repo-worktree')
    expect(manager.entrypoint).toBe(join(manager.directory, 'MEMORY.md'))
  })

  it('validates custom directories and expands home paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-memory-custom-'))
    const homeDir = join(root, 'home')

    const manager = await MemoryManager.create({
      configDir: join(homeDir, '.dock'),
      homeDir,
      projectRoot: join(root, 'repo'),
      settings: { autoMemoryDirectory: '~/dock-memory' },
    })
    expect(manager.directory).toBe(join(homeDir, 'dock-memory'))

    await expect(
      MemoryManager.create({
        configDir: join(homeDir, '.dock'),
        homeDir,
        projectRoot: join(root, 'repo'),
        settings: { autoMemoryDirectory: '~/' },
      }),
    ).rejects.toThrow('autoMemoryDirectory')
  })

  it('loads only the first 200 lines or 25KB of the index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-memory-index-'))
    const manager = await MemoryManager.create({
      configDir: join(root, '.dock'),
      homeDir: root,
      projectRoot: join(root, 'repo'),
      settings: {},
    })
    await manager.initialize()
    await writeFile(
      manager.entrypoint,
      Array.from({ length: 205 }, (_, index) => `- memory ${index + 1}`).join('\n'),
    )

    const loaded = await manager.loadIndex()
    expect(loaded?.content).toContain('- memory 200')
    expect(loaded?.content).not.toContain('- memory 201')
    expect(loaded?.content).toContain('Only part of it was loaded')
    expect(loaded?.wasTruncated).toBe(true)

    await writeFile(manager.entrypoint, `- ${'你'.repeat(9_000)}`)
    const byteLimited = await manager.loadIndex()
    expect(Buffer.byteLength(byteLimited?.content ?? '', 'utf8')).toBeLessThan(26_000)
    expect(byteLimited?.wasTruncated).toBe(true)
  })

  it('updates modified frontmatter and reports index limits after writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-memory-write-'))
    const manager = await MemoryManager.create({
      configDir: join(root, '.dock'),
      homeDir: root,
      now: () => new Date('2026-08-27T12:00:00.000Z'),
      projectRoot: join(root, 'repo'),
      settings: {},
    })
    await manager.initialize()
    const topic = join(manager.directory, 'feedback-testing.md')
    const prepared = await manager.prepareWrite(
      topic,
      '---\nname: feedback-testing\ndescription: Keep integration tests real\ntype: feedback\n---\n\nUse a real database.',
    )
    expect(prepared).toContain('modified: 2026-08-27T12:00:00.000Z')

    const plain = await manager.prepareWrite(join(manager.directory, 'plain.md'), 'plain text')
    expect(plain).toBe('plain text')

    const overLimit = Array.from({ length: 201 }, (_, index) => `- item ${index}`).join('\n')
    const feedback = manager.inspectWrite(manager.entrypoint, overLimit)
    expect(feedback).toMatchObject({ isError: true })
    expect(feedback?.content).toContain('write succeeded')
  })

  it('scans typed topic files without treating MEMORY.md as a memory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-memory-scan-'))
    const manager = await MemoryManager.create({
      configDir: join(root, '.dock'),
      homeDir: root,
      projectRoot: join(root, 'repo'),
      settings: {},
    })
    await manager.initialize()
    await Promise.all([
      writeFile(manager.entrypoint, '- [Testing](testing.md) — preferences'),
      writeFile(
        join(manager.directory, 'testing.md'),
        '---\nname: testing\ndescription: Do not mock databases # important\ntype: feedback\n---\n\nUse integration tests.',
      ),
    ])

    await expect(manager.scanManifest()).resolves.toEqual([
      {
        description: 'Do not mock databases # important',
        fileName: 'testing.md',
        name: 'testing',
        type: 'feedback',
      },
    ])
  })

  it('does nothing when auto memory is disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-memory-disabled-'))
    const manager = await MemoryManager.create({
      configDir: join(root, '.dock'),
      homeDir: root,
      projectRoot: join(root, 'repo'),
      settings: { autoMemoryEnabled: false },
    })
    await manager.initialize()

    expect(manager.enabled).toBe(false)
    expect(manager.buildSystemPrompt()).toBeNull()
    await expect(manager.loadIndex()).resolves.toBeUndefined()
    await expect(readFile(manager.entrypoint, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('publishes the typed topic-file and concise-index contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-memory-prompt-'))
    const manager = await MemoryManager.create({
      configDir: join(root, '.dock'),
      homeDir: root,
      projectRoot: join(root, 'repo'),
      settings: {},
    })

    const prompt = manager.buildSystemPrompt()
    expect(prompt).toContain('short kebab-case slug')
    expect(prompt).toContain('user`, `feedback`, `project`, or `reference')
    expect(prompt).toContain('MEMORY.md is only an index')
  })
})
