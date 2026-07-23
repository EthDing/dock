import type { PermissionMode } from './evaluate-permission.js'

export class PermissionModeState {
  #value: PermissionMode

  constructor(initial: PermissionMode) {
    this.#value = initial
  }

  get value(): PermissionMode {
    return this.#value
  }

  set(value: PermissionMode): void {
    this.#value = value
  }
}
