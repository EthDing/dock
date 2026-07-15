import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadInstructionDocuments } from '../../src/context/load-instructions.js'

describe('loadInstructionDocuments', () => {
  it('loads user and project AGENTS.md files from broadest to most specific', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-instructions-'))
    const homeDir = join(root, 'home')
    const projectDir = join(root, 'project')
    const cwd = join(projectDir, 'packages', 'app')
    await Promise.all([
      mkdir(join(homeDir, '.dock'), { recursive: true }),
      mkdir(join(projectDir, '.git'), { recursive: true }),
      mkdir(cwd, { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(homeDir, '.dock', 'AGENTS.md'), 'user instructions'),
      writeFile(join(projectDir, 'AGENTS.md'), 'project instructions'),
      writeFile(join(cwd, 'AGENTS.md'), 'package instructions'),
    ])

    const documents = await loadInstructionDocuments({ cwd, homeDir, projectRoot: projectDir })

    expect(documents.map(({ content }) => content)).toEqual([
      'user instructions',
      'project instructions',
      'package instructions',
    ])
  })

  it('expands relative file imports without treating directory references as imports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-instruction-import-'))
    const homeDir = join(root, 'home')
    const projectDir = join(root, 'project')
    await Promise.all([
      mkdir(join(homeDir, '.dock'), { recursive: true }),
      mkdir(join(projectDir, '.git'), { recursive: true }),
      mkdir(join(projectDir, 'docs'), { recursive: true }),
    ])
    await writeFile(join(projectDir, 'docs', 'extra.md'), 'imported instructions')
    await writeFile(
      join(projectDir, 'AGENTS.md'),
      ['before', '@docs/extra.md', '@docs', 'after'].join('\n'),
    )

    const documents = await loadInstructionDocuments({
      cwd: projectDir,
      homeDir,
      projectRoot: projectDir,
    })

    expect(documents[0]?.content).toBe('before\nimported instructions\n@docs\nafter')
  })
})
