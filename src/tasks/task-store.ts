import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { JsonObject } from '../model/types.js'
import type { SessionId } from '../sessions/ids.js'
import { getProjectSessionsDirectory } from '../sessions/session-store.js'

export type WorkTaskStatus = 'pending' | 'in_progress' | 'completed'
export type WorkTask = {
  id: string
  subject: string
  description: string
  status: WorkTaskStatus
  activeForm?: string
  owner?: string
  blocks: string[]
  blockedBy: string[]
  metadata?: JsonObject
}
type TaskFile = { version: 1; tasks: WorkTask[] }

export class TaskStore {
  #loaded = false
  #tasks = new Map<string, WorkTask>()
  #listeners = new Set<(tasks: readonly WorkTask[]) => void>()
  constructor(readonly path: string) {}
  async list(): Promise<WorkTask[]> {
    await this.#load()
    return [...this.#tasks.values()].map(cloneTask)
  }
  async get(id: string): Promise<WorkTask | undefined> {
    await this.#load()
    const task = this.#tasks.get(id)
    return task ? cloneTask(task) : undefined
  }
  async create(input: {
    subject: string
    description: string
    activeForm?: string | undefined
    metadata?: JsonObject | undefined
  }): Promise<WorkTask> {
    await this.#load()
    const task: WorkTask = {
      id: randomUUID(),
      subject: input.subject,
      description: input.description,
      status: 'pending',
      blocks: [],
      blockedBy: [],
      ...(input.activeForm ? { activeForm: input.activeForm } : {}),
      ...(input.metadata ? { metadata: structuredClone(input.metadata) } : {}),
    }
    this.#tasks.set(task.id, task)
    await this.#save()
    return cloneTask(task)
  }
  async update(
    id: string,
    patch: Partial<
      Pick<WorkTask, 'subject' | 'description' | 'activeForm' | 'owner' | 'metadata'>
    > & {
      status?: WorkTaskStatus | 'deleted' | undefined
      addBlocks?: string[] | undefined
      addBlockedBy?: string[] | undefined
    },
  ): Promise<{ task?: WorkTask; deleted?: true; updatedFields: string[] }> {
    await this.#load()
    const task = this.#tasks.get(id)
    if (!task) throw new Error(`Unknown task ${id}`)
    if (patch.status === 'deleted') {
      this.#tasks.delete(id)
      for (const item of this.#tasks.values()) {
        item.blocks = item.blocks.filter((value) => value !== id)
        item.blockedBy = item.blockedBy.filter((value) => value !== id)
      }
      await this.#save()
      return { deleted: true, updatedFields: ['status'] }
    }
    const candidate = new Map([...this.#tasks].map(([key, value]) => [key, cloneTask(value)]))
    const next = candidate.get(id)
    if (!next) throw new Error(`Unknown task ${id}`)
    const updatedFields: string[] = []
    if (patch.subject !== undefined) {
      next.subject = patch.subject
      updatedFields.push('subject')
    }
    if (patch.description !== undefined) {
      next.description = patch.description
      updatedFields.push('description')
    }
    if (patch.activeForm !== undefined) {
      next.activeForm = patch.activeForm
      updatedFields.push('activeForm')
    }
    if (patch.owner !== undefined) {
      next.owner = patch.owner
      updatedFields.push('owner')
    }
    if (patch.metadata !== undefined) {
      next.metadata = structuredClone(patch.metadata)
      updatedFields.push('metadata')
    }
    if (patch.status) {
      next.status = patch.status
      updatedFields.push('status')
    }
    for (const relation of patch.addBlocks ?? []) {
      requireTask(candidate, relation)
      if (!next.blocks.includes(relation)) next.blocks.push(relation)
      const other = candidate.get(relation)
      if (other && !other.blockedBy.includes(id)) other.blockedBy.push(id)
    }
    for (const relation of patch.addBlockedBy ?? []) {
      requireTask(candidate, relation)
      if (!next.blockedBy.includes(relation)) next.blockedBy.push(relation)
      const other = candidate.get(relation)
      if (other && !other.blocks.includes(id)) other.blocks.push(id)
    }
    if ((patch.addBlocks?.length ?? 0) > 0) updatedFields.push('blocks')
    if ((patch.addBlockedBy?.length ?? 0) > 0) updatedFields.push('blockedBy')
    assertAcyclic(candidate)
    this.#tasks = candidate
    await this.#save()
    return { task: cloneTask(next), updatedFields: [...new Set(updatedFields)] }
  }
  subscribe(listener: (tasks: readonly WorkTask[]) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
  async copyTo(target: TaskStore): Promise<void> {
    const tasks = await this.list()
    target.#tasks = new Map(tasks.map((task) => [task.id, cloneTask(task)]))
    target.#loaded = true
    await target.#save()
  }
  async #load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as TaskFile
      if (parsed.version === 1)
        this.#tasks = new Map(parsed.tasks.map((task) => [task.id, cloneTask(task)]))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  async #save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    await writeFile(
      temporary,
      `${JSON.stringify({ version: 1, tasks: [...this.#tasks.values()] }, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    )
    await rename(temporary, this.path)
    const snapshot = [...this.#tasks.values()].map(cloneTask)
    for (const listener of this.#listeners) listener(snapshot)
  }
}

export function getTaskStorePath(options: {
  configDir: string
  cwd: string
  sessionId: SessionId
}): string {
  return join(getProjectSessionsDirectory(options), `${options.sessionId}.tasks.json`)
}

function cloneTask(task: WorkTask): WorkTask {
  return structuredClone(task)
}
function requireTask(tasks: Map<string, WorkTask>, id: string): void {
  if (!tasks.has(id)) throw new Error(`Unknown task ${id}`)
}
function assertAcyclic(tasks: Map<string, WorkTask>): void {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('Task dependencies must not contain a cycle')
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of tasks.get(id)?.blockedBy ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of tasks.keys()) visit(id)
}
