import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileHistory } from '../../src/checkpoint/file-history.js'
import { FileReadState } from '../../src/tools/file-read-state.js'
import { createEditTool, createReadTool, createWriteTool } from '../../src/tools/file-tools.js'
import { asMessageUuid, asSessionId } from '../../src/sessions/ids.js'

const SESSION_ID = asSessionId('80000000-0000-4000-8000-000000000001')
const USER_UUID = asMessageUuid('90000000-0000-4000-8000-000000000001')
const ASSISTANT_UUID = asMessageUuid('90000000-0000-4000-8000-000000000002')

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dock-file-tools-'))
  const cwd = join(root, 'project')
  await mkdir(cwd, { recursive: true })
  const fileHistory = new FileHistory({
    configDir: join(root, 'config'),
    cwd,
    sessionId: SESSION_ID,
  })
  const readFileState = new FileReadState()
  await fileHistory.makeSnapshot(USER_UUID)
  const dependencies = { cwd, fileHistory, readFileState }
  return {
    cwd,
    edit: createEditTool(dependencies),
    fileHistory,
    read: createReadTool(dependencies),
    write: createWriteTool(dependencies),
  }
}

const executionOptions = {
  parentMessageUuid: ASSISTANT_UUID,
  signal: new AbortController().signal,
  toolUseId: 'tool-1',
}

describe('file tools', () => {
  it('publishes the absolute-path contract to the model', async () => {
    const { edit, read, write } = await setup()

    for (const tool of [read, write, edit]) {
      expect(tool.description).toContain('absolute path')
      expect(tool.inputSchema).toMatchObject({
        properties: {
          file_path: { description: expect.stringMatching(/absolute path/i) },
        },
      })
    }
  })

  it('requires a full Read before editing an existing file', async () => {
    const { cwd, edit } = await setup()
    const filePath = join(cwd, 'file.txt')
    await writeFile(filePath, 'before')

    await expect(
      edit.execute(
        { file_path: filePath, old_string: 'before', new_string: 'after' },
        executionOptions,
      ),
    ).rejects.toThrow('File has not been read yet')
  })

  it('edits a fully read file and checkpoint rewind restores it', async () => {
    const { cwd, edit, fileHistory, read } = await setup()
    const filePath = join(cwd, 'file.txt')
    await writeFile(filePath, 'before\nline two')

    const readResult = await read.execute({ file_path: filePath }, executionOptions)
    expect(readResult.content).toContain('1→before')
    await edit.execute(
      { file_path: filePath, old_string: 'before', new_string: 'after' },
      executionOptions,
    )
    expect(await readFile(filePath, 'utf8')).toBe('after\nline two')

    await fileHistory.rewind(USER_UUID)
    expect(await readFile(filePath, 'utf8')).toBe('before\nline two')
  })

  it('rejects writes when the file changed after it was read', async () => {
    const { cwd, read, write } = await setup()
    const filePath = join(cwd, 'file.txt')
    await writeFile(filePath, 'original')
    await read.execute({ file_path: filePath }, executionOptions)
    await writeFile(filePath, 'external change')

    await expect(
      write.execute({ file_path: filePath, content: 'replacement' }, executionOptions),
    ).rejects.toThrow('modified since read')
  })

  it('allows Write to create a new file', async () => {
    const { cwd, write } = await setup()
    const filePath = join(cwd, 'new', 'file.txt')

    await write.execute({ file_path: filePath, content: 'created' }, executionOptions)

    expect(await readFile(filePath, 'utf8')).toBe('created')
  })

  it('runs the write lifecycle for both Write and Edit and returns its feedback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dock-file-lifecycle-'))
    const cwd = join(root, 'project')
    await mkdir(cwd, { recursive: true })
    const fileHistory = new FileHistory({
      configDir: join(root, 'config'),
      cwd,
      sessionId: SESSION_ID,
    })
    await fileHistory.makeSnapshot(USER_UUID)
    const readFileState = new FileReadState()
    const dependencies = {
      cwd,
      fileHistory,
      readFileState,
      writeLifecycle: {
        afterWrite: () => ({ content: 'memory feedback', isError: true }),
        prepareWrite: (_path: string, content: string) => `${content}\nprepared`,
      },
    }
    const write = createWriteTool(dependencies)
    const read = createReadTool(dependencies)
    const edit = createEditTool(dependencies)
    const filePath = join(cwd, 'memory.md')

    const writeResult = await write.execute(
      { file_path: filePath, content: 'created' },
      executionOptions,
    )
    expect(writeResult).toEqual({
      content: `Wrote ${filePath}\nmemory feedback`,
      isError: true,
    })
    expect(await readFile(filePath, 'utf8')).toBe('created\nprepared')

    await read.execute({ file_path: filePath }, executionOptions)
    const editResult = await edit.execute(
      { file_path: filePath, old_string: 'created', new_string: 'updated' },
      executionOptions,
    )
    expect(editResult.isError).toBe(true)
    expect(await readFile(filePath, 'utf8')).toBe('updated\nprepared\nprepared')
  })
})
