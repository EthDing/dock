import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { UserInteractionBroker } from '../../src/interaction/user-interaction-broker.js'
import { createAssistantMessage } from '../../src/messages/create-message.js'
import { PermissionModeState } from '../../src/permissions/permission-mode-state.js'
import { asSessionId } from '../../src/sessions/ids.js'
import { createInteractionTools } from '../../src/tools/interaction-tools.js'

const execution = (
  message = createAssistantMessage({
    role: 'assistant',
    id: randomUUID(),
    usage: {},
    stopReason: 'tool_use',
    content: [
      { type: 'text', text: 'Plan text' },
      { type: 'tool_use', id: 'exit', name: 'ExitPlanMode', input: {} },
    ],
  }),
) => ({
  parentMessageUuid: message.uuid,
  signal: new AbortController().signal,
  toolUseId: 'tool',
  agent: {
    sessionId: asSessionId(randomUUID()),
    depth: 0,
    contextMode: 'main' as const,
    cwd: '/work',
    modelReference: 'test:model',
    systemPrompt: [],
    tools: [],
    messages: [message],
  },
})

describe('interactive tools', () => {
  it('approves a plan into auto and carries actual consent as a user message', async () => {
    const broker = new UserInteractionBroker()
    broker.setHandler(async () => ({ type: 'plan', decision: 'approve_auto' }))
    const mode = new PermissionModeState('plan')
    const exit = createInteractionTools({ broker, mode, includePlan: true }).find(
      (t) => t.name === 'ExitPlanMode',
    )
    if (!exit) throw new Error('ExitPlanMode missing')
    const result = await exit.execute({}, execution())
    expect(mode.value).toBe('auto')
    expect(result.userMessage).toBe('User approved this plan for implementation:\nPlan text')
  })
  it('returns structured question answers', async () => {
    const broker = new UserInteractionBroker()
    broker.setHandler(async () => ({
      type: 'questions',
      answers: { Framework: ['React', 'Other'] },
    }))
    const ask = createInteractionTools({
      broker,
      mode: new PermissionModeState('default'),
      includePlan: true,
    }).find((tool) => tool.name === 'AskUserQuestion')
    expect(ask).toBeDefined()
    if (!ask) return
    const result = await ask.execute(
      {
        questions: [
          {
            question: 'Framework',
            header: 'Stack',
            multiSelect: true,
            options: [
              { label: 'React', description: 'React' },
              { label: 'Vue', description: 'Vue' },
            ],
          },
        ],
      },
      execution(),
    )
    expect(JSON.parse(result.content)).toEqual({ answers: { Framework: ['React', 'Other'] } })
  })
  it('enters plan mode and approves the preceding assistant plan', async () => {
    const broker = new UserInteractionBroker()
    broker.setHandler(async () => ({ type: 'plan', decision: 'approve_accept_edits' }))
    const mode = new PermissionModeState('default')
    const tools = createInteractionTools({ broker, mode, includePlan: true })
    const enter = tools.find((tool) => tool.name === 'EnterPlanMode')
    const exit = tools.find((tool) => tool.name === 'ExitPlanMode')
    expect(enter).toBeDefined()
    expect(exit).toBeDefined()
    if (!enter || !exit) return
    await enter.execute({}, execution())
    expect(mode.value).toBe('plan')
    const result = await exit.execute({}, execution())
    expect(mode.value).toBe('acceptEdits')
    expect(JSON.parse(result.content)).toMatchObject({ plan: 'Plan text', mode: 'acceptEdits' })
  })
})
