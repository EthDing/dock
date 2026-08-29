import { z } from 'zod'
import type { UserInteractionBroker, UserQuestion } from '../interaction/user-interaction-broker.js'
import type { PermissionMode } from '../permissions/evaluate-permission.js'
import type { PermissionModeState } from '../permissions/permission-mode-state.js'
import type { AgentTool, ToolExecutionContext } from './types.js'

const questionSchema = z.strictObject({
  question: z.string().min(1),
  header: z.string().min(1).max(32),
  options: z
    .array(z.strictObject({ label: z.string().min(1), description: z.string().min(1) }))
    .min(2)
    .max(6),
  multiSelect: z.boolean(),
})
const askSchema = z.strictObject({ questions: z.array(questionSchema).min(1).max(4) })
const emptySchema = z.strictObject({})

export function createInteractionTools(options: {
  broker: UserInteractionBroker
  mode: PermissionModeState
  includePlan: boolean
  allowPlan?: boolean
}): AgentTool[] {
  const tools: AgentTool[] = [
    {
      name: 'AskUserQuestion',
      description:
        'Ask the user one to four focused questions when multiple valid approaches require a choice. Each question has options and may allow multiple selections; the UI also accepts a free-text Other answer.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['questions'],
        properties: {
          questions: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['question', 'header', 'options', 'multiSelect'],
              properties: {
                question: { type: 'string' },
                header: { type: 'string' },
                multiSelect: { type: 'boolean' },
                options: {
                  type: 'array',
                  minItems: 2,
                  maxItems: 6,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['label', 'description'],
                    properties: { label: { type: 'string' }, description: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
      parseInput: (input) => askSchema.parse(input),
      checkPermissions: () => ({ behavior: 'allow', source: 'tool' }),
      isConcurrencySafe: () => false,
      async execute(input, execution) {
        const parsed = askSchema.parse(input)
        const response = await options.broker.request(
          {
            type: 'questions',
            questions: parsed.questions as readonly UserQuestion[],
            requester: requester(execution),
          },
          execution.signal,
        )
        if (response.type !== 'questions') throw new Error('Invalid question response')
        return { content: JSON.stringify({ answers: response.answers }) }
      },
    },
  ]
  if (!options.includePlan) return tools
  tools.push(
    {
      name: 'EnterPlanMode',
      description:
        'Enter read-only plan mode before exploring and proposing a substantial implementation. Do not use when the task is already clear and small.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      parseInput: (input) => emptySchema.parse(input),
      checkPermissions: () =>
        options.allowPlan === false
          ? {
              behavior: 'deny',
              source: 'tool',
              message: 'Plan mode is controlled by the main agent',
            }
          : { behavior: 'allow', source: 'tool' },
      isConcurrencySafe: () => false,
      async execute() {
        if (options.allowPlan === false)
          throw new Error('Plan mode is controlled by the main agent')
        options.mode.set('plan')
        return { content: 'Entered plan mode' }
      },
    },
    {
      name: 'ExitPlanMode',
      description:
        'Present the complete plan written in the text before this tool call and ask the user whether to implement it. Call only after the plan is decision-complete.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      parseInput: (input) => emptySchema.parse(input),
      checkPermissions: () =>
        options.allowPlan === false
          ? {
              behavior: 'deny',
              source: 'tool',
              message: 'Plan mode is controlled by the main agent',
            }
          : { behavior: 'allow', source: 'tool' },
      isConcurrencySafe: () => false,
      async execute(_input, execution) {
        if (options.allowPlan === false)
          throw new Error('Plan mode is controlled by the main agent')
        if (options.mode.value !== 'plan') throw new Error('Dock is not in plan mode')
        const plan = currentPlan(execution)
        if (!plan) throw new Error('ExitPlanMode requires plan text before the tool call')
        const response = await options.broker.request(
          { type: 'plan', plan, requester: requester(execution) },
          execution.signal,
        )
        if (response.type !== 'plan') throw new Error('Invalid plan response')
        if (response.decision === 'approve_default') options.mode.set('default')
        else if (response.decision === 'approve_accept_edits') options.mode.set('acceptEdits')
        return {
          content: JSON.stringify({
            plan,
            decision: response.decision,
            ...(response.feedback ? { feedback: response.feedback } : {}),
            mode: options.mode.value,
          }),
          ...(response.decision === 'cancel' ? { isError: true } : {}),
        }
      },
    },
  )
  return tools
}

function requester(execution: ToolExecutionContext) {
  const sessionId = execution.agent?.sessionId
  if (!sessionId) throw new Error('Agent identity is unavailable')
  return {
    sessionId,
    ...(execution.agent?.agentId ? { agentId: execution.agent.agentId } : {}),
    label: execution.agent?.agentId ? `Agent ${execution.agent.agentId.slice(0, 8)}` : 'Main',
  }
}

function currentPlan(execution: ToolExecutionContext): string {
  const message = execution.agent?.messages.find(
    (item) => item.uuid === execution.parentMessageUuid,
  )
  if (message?.type !== 'assistant') return ''
  return message.message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n\n')
}

export function approvedPlanMode(decision: string): PermissionMode | undefined {
  if (decision === 'approve_default') return 'default'
  if (decision === 'approve_accept_edits') return 'acceptEdits'
  return undefined
}
