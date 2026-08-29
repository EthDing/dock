import { z } from 'zod'
import type { JsonObject } from '../model/types.js'
import type { TaskStore } from '../tasks/task-store.js'
import type { AgentTool } from './types.js'

const metadataSchema = z.record(z.string(), z.json())
const createSchema = z.strictObject({
  subject: z.string().min(1),
  description: z.string().min(1),
  activeForm: z.string().min(1).optional(),
  metadata: metadataSchema.optional(),
})
const getSchema = z.strictObject({ taskId: z.string().uuid() })
const listSchema = z.strictObject({})
const updateSchema = z.strictObject({
  taskId: z.string().uuid(),
  status: z.enum(['pending', 'in_progress', 'completed', 'deleted']).optional(),
  subject: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  activeForm: z.string().min(1).optional(),
  addBlocks: z.array(z.string().uuid()).optional(),
  addBlockedBy: z.array(z.string().uuid()).optional(),
  owner: z.string().min(1).optional(),
  metadata: metadataSchema.optional(),
})

export function createTaskTools(store: TaskStore): AgentTool[] {
  return [
    tool(
      'TaskCreate',
      createSchema,
      'Create one work task and return its stable ID.',
      async (input) => {
        const parsed = createSchema.parse(input)
        const task = await store.create({
          subject: parsed.subject,
          description: parsed.description,
          ...(parsed.activeForm ? { activeForm: parsed.activeForm } : {}),
          ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
        })
        return { content: JSON.stringify({ task: { id: task.id, subject: task.subject } }) }
      },
    ),
    tool(
      'TaskGet',
      getSchema,
      'Get the complete current state of one work task.',
      async (input) => ({
        content: JSON.stringify({ task: (await store.get(String(input.taskId))) ?? null }),
      }),
    ),
    tool('TaskList', listSchema, 'List all work tasks and their current status.', async () => ({
      content: JSON.stringify({ tasks: await store.list() }),
    })),
    tool(
      'TaskUpdate',
      updateSchema,
      'Update, relate, complete, or delete one work task.',
      async (input) => {
        const parsed = updateSchema.parse(input)
        const result = await store.update(parsed.taskId, {
          ...(parsed.status ? { status: parsed.status } : {}),
          ...(parsed.subject ? { subject: parsed.subject } : {}),
          ...(parsed.description ? { description: parsed.description } : {}),
          ...(parsed.activeForm ? { activeForm: parsed.activeForm } : {}),
          ...(parsed.addBlocks ? { addBlocks: parsed.addBlocks } : {}),
          ...(parsed.addBlockedBy ? { addBlockedBy: parsed.addBlockedBy } : {}),
          ...(parsed.owner ? { owner: parsed.owner } : {}),
          ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
        })
        return {
          content: JSON.stringify({
            success: true,
            taskId: parsed.taskId,
            updatedFields: result.updatedFields,
            ...(result.task ? { task: result.task } : {}),
          }),
        }
      },
    ),
  ]
}

function tool<T extends z.ZodType<JsonObject>>(
  name: string,
  schema: T,
  description: string,
  execute: AgentTool['execute'],
): AgentTool {
  return {
    name,
    description,
    inputSchema: z.toJSONSchema(schema) as AgentTool['inputSchema'],
    parseInput: (input) => schema.parse(input),
    checkPermissions: () => ({ behavior: 'allow', source: 'tool' }),
    isConcurrencySafe: () => false,
    execute,
  }
}
