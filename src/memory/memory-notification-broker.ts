export type MemoryNotification = {
  paths: readonly string[]
  type: 'saved'
}

export class MemoryNotificationBroker {
  #handler: ((notification: MemoryNotification) => void) | undefined

  setHandler(handler: (notification: MemoryNotification) => void): void {
    this.#handler = handler
  }

  notify(notification: MemoryNotification): void {
    this.#handler?.(notification)
  }
}
