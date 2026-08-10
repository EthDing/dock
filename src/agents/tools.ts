import { z } from 'zod'
import type { AgentTool, ToolExecutionContext } from '../tools/types.js'
import { isUuid } from '../sessions/ids.js'
import type { SubagentManager } from './manager.js'

const spawnSchema = z
  .strictObject({
    prompt: z.string().min(1),
    description: z.string().min(1),
    name: z
      .string()
      .min(1)
      .refine((name) => name !== 'main' && !isUuid(name), 'Name is reserved')
      .optional(),
    context: z.enum(['fresh', 'fork']).optional(),
    model: z.string().min(1).optional(),
    isolation: z.literal('worktree').optional(),
  })
  .refine(
    (input) => input.context !== 'fork' || !input.model,
    'A fork must inherit its parent model',
  )
const messageSchema = z.strictObject({
  to: z.string().min(1),
  message: z.string().min(1),
  summary: z.string().optional(),
})
const stopSchema = z.strictObject({ task_id: z.string().min(1) })
function snapshot(execution: ToolExecutionContext) {
  if (!execution.agent) throw new Error('Agent runtime context is unavailable')
  return execution.agent
}
export function createAgentTools(manager: SubagentManager): AgentTool[] {
  return [
    {
      name: 'Agent',
      description:
        'Delegate a focused task to a general-purpose subagent. By default it starts fresh in the background. Choose context=fork to inherit your conversation and model. It reports completion automatically; do not claim its work is finished before the report. isolation=worktree gives it a separate Git working tree, but Bash is not a security boundary.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['prompt', 'description'],
        properties: {
          prompt: { type: 'string' },
          description: { type: 'string' },
          name: { type: 'string' },
          context: { type: 'string', enum: ['fresh', 'fork'] },
          model: {
            type: 'string',
            description: 'Configured provider:model for a fresh agent only',
          },
          isolation: { type: 'string', enum: ['worktree'] },
        },
      },
      parseInput: (input) => spawnSchema.parse(input),
      checkPermissions: () => ({ behavior: 'allow', source: 'tool' }),
      isConcurrencySafe: () => true,
      async execute(input, execution) {
        const agent = await manager.spawn(snapshot(execution), spawnSchema.parse(input), {
          signal: execution.signal,
        })
        return {
          content: JSON.stringify(agent),
          ...(['failed', 'stopped'].includes(agent.status) ? { isError: true } : {}),
        }
      },
    },
    {
      name: 'SendMessage',
      description:
        'Send plain-text task direction to an agent in this session by ID or name, or to main. Running agents receive it at their next model-round boundary. Completed agents resume with their history. A user-stopped agent requires the user to continue it. Messages never grant permission or change settings.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['to', 'message'],
        properties: {
          to: { type: 'string' },
          message: { type: 'string' },
          summary: { type: 'string' },
        },
      },
      parseInput: (input) => messageSchema.parse(input),
      checkPermissions: () => ({ behavior: 'allow', source: 'tool' }),
      isConcurrencySafe: () => true,
      async execute(input, execution) {
        const parsed = messageSchema.parse(input),
          parent = snapshot(execution)
        await manager.send(parent.sessionId, parsed.to, parsed.message, {
          fromAgentId: parent.agentId,
        })
        return { content: `Message queued for ${parsed.to}` }
      },
    },
    {
      name: 'TaskStop',
      description:
        'Stop a running subagent by ID or name. Its partial work and transcript are retained. This does not undo file changes.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['task_id'],
        properties: { task_id: { type: 'string' } },
      },
      parseInput: (input) => stopSchema.parse(input),
      checkPermissions: () => ({ behavior: 'allow', source: 'tool' }),
      isConcurrencySafe: () => true,
      async execute(input, execution) {
        const parsed = stopSchema.parse(input),
          parent = snapshot(execution)
        return {
          content: JSON.stringify(await manager.stop(parent.sessionId, parsed.task_id, 'model')),
        }
      },
    },
  ]
}
