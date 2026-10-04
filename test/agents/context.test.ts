import { describe, expect, it } from 'vitest'
import { buildChildContext } from '../../src/agents/context.js'
import { createUserMessage, createAssistantMessage } from '../../src/messages/create-message.js'
import type { AgentSnapshot } from '../../src/agents/types.js'
import { createSessionId } from '../../src/sessions/ids.js'
import { classifierTranscript } from '../../src/permissions/auto-classifier.js'

const snapshot: AgentSnapshot = {
  sessionId: createSessionId(),
  depth: 0,
  contextMode: 'main',
  cwd: '/repo',
  modelReference: 'test:model',
  systemPrompt: ['parent system'],
  userContext: { AGENTS: 'rules', AUTO_MEMORY: 'private index' },
  tools: [{ name: 'Agent', description: 'Delegate', inputSchema: {} }],
  messages: [
    createUserMessage({ content: [{ type: 'text', text: 'user request' }] }),
    createAssistantMessage({
      id: 'batch',
      role: 'assistant',
      usage: {},
      stopReason: 'tool_use',
      content: [
        { type: 'tool_use', name: 'Agent', id: 'a', input: { prompt: 'one' } },
        { type: 'tool_use', name: 'Agent', id: 'b', input: { prompt: 'two' } },
      ],
    }),
  ],
}
describe('subagent context', () => {
  it('does not turn delegated directions into user authorization', () => {
    for (const context of ['fresh', 'fork'] as const) {
      const child = buildChildContext(
        snapshot,
        { prompt: 'delete shared data', description: 'task', context },
        '/repo',
      )
      expect(
        classifierTranscript(child.messages)
          .filter((m) => m.type === 'user')
          .some((m) => String(m.text).includes('delete shared data')),
      ).toBe(false)
      const userChild = buildChildContext(
        snapshot,
        { prompt: 'user delegated task', description: 'task', context },
        '/repo',
        true,
      )
      expect(
        classifierTranscript(userChild.messages).some(
          (m) => m.type === 'user' && String(m.text).includes('user delegated task'),
        ),
      ).toBe(true)
    }
  })
  it('starts fresh with project instructions but without parent history or auto memory', () => {
    const context = buildChildContext(
      snapshot,
      { prompt: 'research', description: 'Research', context: 'fresh' },
      '/repo',
    )
    expect(context.messages).toHaveLength(1)
    expect(JSON.stringify(context.messages)).not.toContain('user request')
    expect(context.userContext).toEqual({ AGENTS: 'rules' })
    expect(context.systemPrompt).not.toEqual(snapshot.systemPrompt)
  })
  it('forks identical structured prefixes and pairs every call in the pending batch', () => {
    const one = buildChildContext(
      snapshot,
      { prompt: 'one', description: 'One', context: 'fork' },
      '/repo',
    )
    const two = buildChildContext(
      snapshot,
      { prompt: 'two', description: 'Two', context: 'fork' },
      '/repo',
    )
    expect(one.systemPrompt).toEqual(snapshot.systemPrompt)
    expect(one.userContext).toEqual(snapshot.userContext)
    expect(one.messages.slice(0, -1).map((m) => m.message)).toEqual(
      two.messages.slice(0, -1).map((m) => m.message),
    )
    const content = one.messages.at(-1)?.message.content ?? []
    expect(content.filter((b) => b.type === 'tool_result').map((b) => b.toolUseId)).toEqual([
      'a',
      'b',
    ])
    expect(snapshot.messages).toHaveLength(2)
  })
  it('appends the actual worktree path and warns about the intentionally missing Bash boundary', () => {
    const context = buildChildContext(
      snapshot,
      { prompt: 'edit', description: 'Edit', context: 'fork' },
      '/repo/.dock/worktrees/child',
    )
    const text = JSON.stringify(context.messages.at(-1))
    expect(text).toContain('/repo/.dock/worktrees/child')
    expect(text).toContain('Bash')
    expect(text).toContain('Re-read')
  })
})
