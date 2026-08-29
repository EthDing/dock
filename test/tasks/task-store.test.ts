import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TaskStore } from '../../src/tasks/task-store.js'

describe('TaskStore', () => {
  it('persists tasks, relations, and rejects dependency cycles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dock-task-store-'))
    const path = join(directory, 'tasks.json')
    const store = new TaskStore(path)
    const first = await store.create({ subject: 'First', description: 'One' })
    const second = await store.create({ subject: 'Second', description: 'Two' })
    await store.update(second.id, { addBlockedBy: [first.id], status: 'in_progress' })
    const restored = new TaskStore(path)
    expect(await restored.get(second.id)).toMatchObject({
      blockedBy: [first.id],
      status: 'in_progress',
    })
    await expect(restored.update(first.id, { addBlockedBy: [second.id] })).rejects.toThrow('cycle')
  })
  it('copies a branch snapshot and removes deleted dependency references', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dock-task-copy-'))
    const source = new TaskStore(join(directory, 'source.json'))
    const target = new TaskStore(join(directory, 'target.json'))
    const first = await source.create({ subject: 'First', description: 'One' })
    const second = await source.create({ subject: 'Second', description: 'Two' })
    await source.update(second.id, { addBlockedBy: [first.id] })
    await source.copyTo(target)
    await source.update(first.id, { status: 'deleted' })
    expect(await target.get(second.id)).toMatchObject({ blockedBy: [first.id] })
    expect(await source.get(second.id)).toMatchObject({ blockedBy: [] })
  })
})
