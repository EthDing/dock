export type SandboxNetworkRequest = {
  host: string
  port: number | undefined
}

export type SandboxNetworkResponse = {
  allow: boolean
  persist: boolean
}

export class SandboxNetworkPermissionBroker {
  #handler: ((request: SandboxNetworkRequest) => Promise<SandboxNetworkResponse>) | undefined
  readonly #pending = new Map<string, Promise<SandboxNetworkResponse>>()

  setHandler(handler: (request: SandboxNetworkRequest) => Promise<SandboxNetworkResponse>): void {
    this.#handler = handler
  }

  request(request: SandboxNetworkRequest): Promise<SandboxNetworkResponse> {
    const existing = this.#pending.get(request.host)
    if (existing) return existing
    const pending = (
      this.#handler?.(request) ?? Promise.resolve({ allow: false, persist: false })
    ).finally(() => {
      this.#pending.delete(request.host)
    })
    this.#pending.set(request.host, pending)
    return pending
  }
}
