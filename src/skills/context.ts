import {
  createUserMessage,
  type TranscriptMessage,
  type UserTranscriptMessage,
} from '../messages/create-message.js'

const COMBINED_SKILL_CHARS = 100_000
const PER_SKILL_CHARS = 20_000

export type SkillRestoreMode = 'none' | 'full' | 'head5k' | 'pointer'
export type SkillRestorationMetadata = {
  mode: SkillRestoreMode
  skills: Array<{ name: string; location: string; tokens: number }>
}

export function parseSkillRestoreMode(value: string | undefined): SkillRestoreMode {
  if (value === undefined) return 'head5k'
  if (value === 'none' || value === 'full' || value === 'head5k' || value === 'pointer')
    return value
  throw new Error('DOCK_EVAL_SKILL_RESTORE must be none, full, head5k, or pointer')
}

export function prepareSkillRestoration(
  messages: readonly TranscriptMessage[],
  mode: SkillRestoreMode = 'head5k',
): UserTranscriptMessage[] {
  return prepareSkillRestorationWithMetadata(messages, mode).attachments
}

export function prepareSkillRestorationWithMetadata(
  messages: readonly TranscriptMessage[],
  mode: SkillRestoreMode = 'head5k',
): { attachments: UserTranscriptMessage[]; skillRestoration: SkillRestorationMetadata } {
  const newest = new Map<string, UserTranscriptMessage>()
  for (const message of [...messages].reverse()) {
    if (message.type !== 'user' || !message.skillContext || newest.has(message.skillContext.name))
      continue
    newest.set(message.skillContext.name, message)
  }
  let used = 0
  const restored: UserTranscriptMessage[] = []
  const omitted: string[] = []
  const skillRestoration: SkillRestorationMetadata = { mode, skills: [] }
  for (const [name, message] of newest) {
    const skillContext = message.skillContext
    if (!skillContext) continue
    const metric = { name, location: skillContext.location, tokens: 0 }
    skillRestoration.skills.push(metric)
    if (mode === 'none') continue
    let text = message.message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    let isPartial = skillContext.isPartial ?? false
    if (mode === 'pointer') {
      text = `Skill: ${name}\nSKILL.md: ${skillContext.location}\nUse the Skill tool or Read to reload this Skill when needed.`
      isPartial = true
    } else if (mode === 'head5k' && text.length > PER_SKILL_CHARS) {
      const notice = `\n[Skill content truncated after compaction. Use Read to read the full Skill at ${skillContext.location}.]`
      text = text.slice(0, Math.max(0, PER_SKILL_CHARS - notice.length)) + notice
      isPartial = true
    }
    if (used + text.length > COMBINED_SKILL_CHARS) {
      omitted.push(name)
      continue
    }
    used += text.length
    metric.tokens = Math.ceil(text.length / 4)
    restored.push(
      createUserMessage(
        { content: [{ type: 'text', text }] },
        {
          isMeta: true,
          skillContext: { ...skillContext, ...(isPartial ? { isPartial: true } : {}) },
        },
      ),
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
  return { attachments: restored, skillRestoration }
}
