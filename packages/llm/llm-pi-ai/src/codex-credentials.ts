/** pi-ai credential storage over the Harness credential-reference service. */

import type { Credential, CredentialInfo as PiCredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const OPENAI_CODEX = 'openai-codex'
const OPENAI_CODEX_REF = credentialRef('PI_AI_OPENAI_CODEX_OAUTH')

/** Optional migration and test locations for the Harness-backed pi-ai store. */
export interface HarnessPiAiCredentialStoreOptions {
  /** Import Pi's existing membership login only when the Harness store has no credential. */
  importPiAuth?: boolean
  /** Test/deployment override for Pi's ordinary `~/.pi/agent/auth.json` location. */
  piAuthFile?: string
}

/** Validate the persisted pi-ai credential without exposing any field value in errors. */
function parseCredential(raw: string): Credential {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('llm-pi-ai: stored OpenAI Codex OAuth credential is not valid JSON; log in again')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('llm-pi-ai: stored OpenAI Codex OAuth credential is invalid; log in again')
  }
  const record = value as Record<string, unknown>
  if (record.type !== 'oauth'
    || typeof record.access !== 'string'
    || typeof record.refresh !== 'string'
    || typeof record.expires !== 'number') {
    throw new Error('llm-pi-ai: stored OpenAI Codex OAuth credential is incomplete; log in again')
  }
  return value as Credential
}

/** Read Pi's native auth document without ever surfacing its contents in diagnostics. */
async function readPiCredential(filename: string): Promise<Credential | undefined> {
  let raw: string
  try {
    raw = await readFile(filename, 'utf8')
  } catch {
    return undefined
  }
  try {
    const document = JSON.parse(raw) as Record<string, unknown>
    const value = document[OPENAI_CODEX]
    return value === undefined ? undefined : parseCredential(JSON.stringify(value))
  } catch {
    // Migration is a convenience fallback. A malformed or incompatible Pi
    // document must not make the Harness account surface unusable.
    return undefined
  }
}

/** CredentialStore used by pi-ai OAuth resolution and refresh. */
export class HarnessPiAiCredentialStore implements CredentialStore {
  private chain: Promise<void> = Promise.resolve()
  private readonly memory = new Map<string, Credential>()
  private credentials: CredentialProvider | undefined
  private readonly importPiAuth: boolean
  private readonly piAuthFile: string

  constructor(credentials?: CredentialProvider, options: HarnessPiAiCredentialStoreOptions = {}) {
    this.credentials = credentials
    this.importPiAuth = options.importPiAuth ?? false
    this.piAuthFile = options.piAuthFile ?? join(homedir(), '.pi', 'agent', 'auth.json')
  }

  /**
   * Follow the live Cordis credential service without forcing it on bare plugin compositions.
   * @param credentials - live Harness credential provider.
   * @returns a disposer that unbinds this exact provider.
   */
  bind(credentials: CredentialProvider): () => void {
    this.credentials = credentials
    return () => {
      if (this.credentials === credentials) this.credentials = undefined
    }
  }

  private ref(providerId: string): CredentialRef | undefined {
    return providerId === OPENAI_CODEX ? OPENAI_CODEX_REF : undefined
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const ref = this.ref(providerId)
    if (ref === undefined) return undefined
    const credentials = this.credentials
    if (credentials !== undefined) {
      const stored = await credentials.resolve(ref)
      if (stored !== undefined) return parseCredential(stored.value)
      const fallback = this.memory.get(providerId)
        ?? (this.importPiAuth ? await readPiCredential(this.piAuthFile) : undefined)
      if (fallback === undefined) return undefined
      await credentials.set(ref, JSON.stringify(fallback))
      this.memory.delete(providerId)
      return fallback
    }
    const existing = this.memory.get(providerId)
    if (existing !== undefined || !this.importPiAuth) return existing
    const imported = await readPiCredential(this.piAuthFile)
    if (imported !== undefined) this.memory.set(providerId, imported)
    return imported
  }

  async list(): Promise<readonly PiCredentialInfo[]> {
    const credential = await this.read(OPENAI_CODEX)
    return credential === undefined ? [] : [{ providerId: OPENAI_CODEX, type: credential.type }]
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const task = this.chain.then(async () => {
      const ref = this.ref(providerId)
      if (ref === undefined) return undefined
      const current = await this.read(providerId)
      const next = await fn(current)
      if (next !== undefined) {
        if (this.credentials === undefined) this.memory.set(providerId, next)
        else await this.credentials.set(ref, JSON.stringify(next))
      }
      return next ?? current
    })
    this.chain = task.then(() => undefined, () => undefined)
    return task
  }

  delete(providerId: string): Promise<void> {
    const task = this.chain.then(async () => {
      const ref = this.ref(providerId)
      if (ref === undefined) return
      if (this.credentials === undefined) this.memory.delete(providerId)
      else await this.credentials.unset(ref)
    })
    this.chain = task.then(() => undefined, () => undefined)
    return task
  }
}
