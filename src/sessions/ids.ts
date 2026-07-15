import { randomUUID, type UUID } from 'node:crypto'

export type SessionId = UUID & { readonly __brand: 'SessionId' }

export function createSessionId(): SessionId {
  return randomUUID() as SessionId
}

export function asSessionId(value: string): SessionId {
  if (!isUuid(value)) throw new Error(`Invalid session UUID: ${value}`)
  return value as SessionId
}

export function asMessageUuid(value: string): UUID {
  if (!isUuid(value)) throw new Error(`Invalid message UUID: ${value}`)
  return value as UUID
}

export function isUuid(value: string): value is UUID {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
