import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReadStream, WriteStream } from 'node:tty'

type CredentialFile = {
  providers: Record<string, { apiKey: string }>
}

export async function loadProviderCredential(options: {
  homeDir: string
  providerName: string
}): Promise<string | undefined> {
  const credentials = await readCredentialFile(options.homeDir)
  return credentials?.providers[options.providerName]?.apiKey
}

export async function saveProviderCredential(options: {
  apiKey: string
  homeDir: string
  providerName: string
}): Promise<void> {
  const apiKey = options.apiKey.trim()
  if (!apiKey) throw new Error('API key must not be empty')
  const directory = join(options.homeDir, '.dock')
  const path = join(directory, '.credentials.json')
  const existing = (await readCredentialFile(options.homeDir)) ?? { providers: {} }
  const credentials: CredentialFile = {
    providers: {
      ...existing.providers,
      [options.providerName]: { apiKey },
    },
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporaryPath = join(directory, `.credentials.${randomUUID()}.tmp`)
  await writeFile(temporaryPath, `${JSON.stringify(credentials, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
  await rename(temporaryPath, path)
  await chmod(path, 0o600)
}

export async function promptForProviderCredential(options: {
  input?: ReadStream
  message: string
  output?: WriteStream
}): Promise<string> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Credential setup requires an interactive terminal')
  }
  const wasRaw = input.isRaw
  output.write(options.message)

  return new Promise<string>((resolve, reject) => {
    let value = ''
    const cleanup = () => {
      input.removeListener('data', onData)
      input.setRawMode(wasRaw)
    }
    const finish = () => {
      if (!value) return
      cleanup()
      output.write('\n')
      resolve(value)
    }
    const onData = (chunk: Buffer | string) => {
      for (const character of String(chunk)) {
        if (character === '\r' || character === '\n') {
          finish()
        } else if (character === '\u0003') {
          cleanup()
          output.write('\n')
          reject(new Error('Credential setup cancelled'))
        } else if (character === '\u007f' || character === '\b') {
          if (value) {
            value = value.slice(0, -1)
            output.write('\b \b')
          }
        } else if (character >= ' ') {
          value += character
          output.write('*')
        }
      }
    }
    input.setRawMode(true)
    input.resume()
    input.on('data', onData)
  })
}

async function readCredentialFile(homeDir: string): Promise<CredentialFile | undefined> {
  const path = join(homeDir, '.dock', '.credentials.json')
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    throw error
  }
  const value = JSON.parse(contents) as unknown
  if (!isCredentialFile(value)) throw new Error(`Invalid credential file ${path}`)
  return value
}

function isCredentialFile(value: unknown): value is CredentialFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const providers = (value as { providers?: unknown }).providers
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return false
  return Object.values(providers).every(
    (entry) =>
      entry !== null &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      typeof (entry as { apiKey?: unknown }).apiKey === 'string' &&
      (entry as { apiKey: string }).apiKey.length > 0,
  )
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
