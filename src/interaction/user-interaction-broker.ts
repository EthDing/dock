import type { UUID } from 'node:crypto'
import type { SessionId } from '../sessions/ids.js'

export type QuestionOption = { label: string; description: string }
export type UserQuestion = {
  question: string
  header: string
  options: readonly QuestionOption[]
  multiSelect: boolean
}
export type InteractionRequester = { agentId?: UUID; label: string; sessionId: SessionId }
export type UserInteractionRequest =
  | {
      type: 'questions'
      questions: readonly UserQuestion[]
      requester: InteractionRequester
      signal: AbortSignal
    }
  | {
      type: 'plan'
      plan: string
      requester: InteractionRequester
      signal: AbortSignal
    }
export type UserInteractionResponse =
  | { type: 'questions'; answers: Record<string, string | string[]> }
  | {
      type: 'plan'
      decision: 'approve_default' | 'approve_accept_edits' | 'feedback' | 'cancel'
      feedback?: string
    }
export type UserInteractionRequestInput =
  | Omit<Extract<UserInteractionRequest, { type: 'questions' }>, 'signal'>
  | Omit<Extract<UserInteractionRequest, { type: 'plan' }>, 'signal'>

export class UserInteractionBroker {
  #handler: ((request: UserInteractionRequest) => Promise<UserInteractionResponse>) | undefined
  #tail: Promise<void> = Promise.resolve()
  setHandler(handler: (request: UserInteractionRequest) => Promise<UserInteractionResponse>): void {
    this.#handler = handler
  }
  async request(
    request: UserInteractionRequestInput,
    signal: AbortSignal,
  ): Promise<UserInteractionResponse> {
    if (signal.aborted) throw new Error('User interaction cancelled')
    let onAbort!: () => void
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('User interaction cancelled'))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    const job = this.#tail.then(async () => {
      if (signal.aborted) throw new Error('User interaction cancelled')
      if (!this.#handler) throw new Error('User interaction is unavailable')
      return Promise.race([
        this.#handler({ ...request, signal } as UserInteractionRequest),
        aborted,
      ])
    })
    this.#tail = job.then(
      () => {},
      () => {},
    )
    try {
      return await Promise.race([job, aborted])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
}
