import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { createCanUseTool } from '../../src/permissions/can-use-tool.js'
import { PermissionBroker } from '../../src/permissions/permission-broker.js'
import { createSessionId } from '../../src/sessions/ids.js'
import type { AgentTool } from '../../src/tools/types.js'
it('correlates permission prompts to the originating session and tool call', async () => {
  const broker = new PermissionBroker(),
    sessionId = createSessionId(),
    parentMessageUuid = randomUUID()
  let identity: unknown
  broker.setHandler(async (request) => {
    identity = request
    return { behavior: 'allow_once' }
  })
  const canUse = createCanUseTool({
    rules: { ask: ['Test'] },
    mode: 'default',
    requestApproval: (tool, input, decision, signal, call) =>
      broker.requestApproval(tool, input, decision, signal, undefined, call),
  })
  const tool: AgentTool = {
    name: 'Test',
    description: '',
    inputSchema: {},
    isConcurrencySafe: () => true,
    execute: async () => ({ content: '' }),
  }
  await canUse(
    tool,
    {},
    {
      signal: new AbortController().signal,
      parentMessageUuid,
      toolUseId: 'call-1',
      agent: {
        sessionId,
        depth: 0,
        contextMode: 'main',
        cwd: '/work',
        modelReference: 'test:model',
        tools: [],
        messages: [],
        systemPrompt: [],
      },
    },
  )
  expect(identity).toMatchObject({ sessionId, parentMessageUuid, toolUseId: 'call-1' })
})
