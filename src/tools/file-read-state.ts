import { resolve } from 'node:path'

export type FileReadSnapshot = {
  content: string
  isPartialView: boolean
  limit?: number
  offset?: number
  timestamp: number
}

export class FileReadState {
  readonly #entries = new Map<string, FileReadSnapshot>()

  get(filePath: string): FileReadSnapshot | undefined {
    return this.#entries.get(resolve(filePath))
  }

  set(filePath: string, snapshot: FileReadSnapshot): void {
    this.#entries.set(resolve(filePath), snapshot)
  }
}
