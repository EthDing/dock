import type { ModelAdapter, ModelRequest, ModelStreamEvent, ModelStreamOptions } from './types.js'

export type FakeModelScript = readonly (readonly ModelStreamEvent[])[]

export class FakeModelAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = []
  readonly #script: FakeModelScript

  constructor(script: FakeModelScript) {
    this.#script = script
  }

  async *stream(
    request: ModelRequest,
    options: ModelStreamOptions,
  ): AsyncGenerator<ModelStreamEvent> {
    if (options.signal.aborted) return

    this.requests.push(request)
    const response = this.#script[this.requests.length - 1]
    if (!response) throw new Error('FakeModelAdapter received an unexpected request')

    for (const event of response) {
      if (options.signal.aborted) return
      yield event
    }
  }
}
