import {
  createUserMessage,
  type TranscriptMessage,
  type UserTranscriptMessage,
} from '../messages/create-message.js'

const COMBINED_SKILL_CHARS = 100_000
const PER_SKILL_CHARS = 20_000

export function prepareSkillRestoration(
  messages: readonly TranscriptMessage[],
): UserTranscriptMessage[] {
  const newest = new Map<string, UserTranscriptMessage>()
  for (const message of [...messages].reverse()) {
    if (message.type !== 'user' || !message.skillContext || newest.has(message.skillContext.name))
      continue
    newest.set(message.skillContext.name, message)
  }
  let used = 0
  const restored: UserTranscriptMessage[] = []
  const omitted: string[] = []
  for (const [name, message] of newest) {
    const skillContext = message.skillContext
    if (!skillContext) continue
    let text = message.message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    if (text.length > PER_SKILL_CHARS) {
      const notice = `\n[Skill content truncated after compaction. Use Read to read the full Skill at ${skillContext.location}.]`
      text = text.slice(0, Math.max(0, PER_SKILL_CHARS - notice.length)) + notice
    }
    if (used + text.length > COMBINED_SKILL_CHARS) {
      omitted.push(name)
      continue
    }
    used += text.length
    restored.push(
      createUserMessage({ content: [{ type: 'text', text }] }, { isMeta: true, skillContext }),
    )
  }
  if (omitted.length)
    restored.push(
      createUserMessage(
        {
          content: [
            {
              type: 'text',
              text: `The following older Skills were omitted after compaction due to the Skill context budget: ${omitted.join(', ')}. Re-activate them if needed.`,
            },
          ],
        },
        { isMeta: true },
      ),
    )
  return restored
}
