import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { HarnessPiAiCredentialStore } from '../src/codex-credentials.ts'

let roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
  roots = []
})

async function piAuth(contents: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pi-auth-'))
  roots.push(root)
  const path = join(root, 'auth.json')
  await writeFile(path, JSON.stringify(contents))
  return path
}

function provider() {
  let value: string | undefined
  return {
    face: {
      resolve: vi.fn(() => Promise.resolve(value === undefined ? undefined : { value, source: 'file' })),
      describe: vi.fn(() => Promise.resolve({ configured: value !== undefined, source: 'file', writable: true })),
      set: vi.fn((_ref, next: string) => { value = next; return Promise.resolve() }),
      unset: vi.fn(() => { value = undefined; return Promise.resolve() }),
    } as unknown as CredentialProvider,
    value: () => value,
  }
}

const OAUTH = { type: 'oauth' as const, access: 'access-token', refresh: 'refresh-token', expires: 123 }

describe('HarnessPiAiCredentialStore persistence', () => {
  it('imports Pi auth only when enabled and persists it through a late Cordis credential binding', async () => {
    const path = await piAuth({ 'openai-codex': OAUTH })
    const store = new HarnessPiAiCredentialStore(undefined, { importPiAuth: true, piAuthFile: path })

    expect(await store.read('openai-codex')).toEqual(OAUTH)
    const backing = provider()
    store.bind(backing.face)
    expect(await store.read('openai-codex')).toEqual(OAUTH)
    expect(backing.face.set).toHaveBeenCalledOnce()
    expect(JSON.parse(backing.value()!)).toEqual(OAUTH)
  })

  it('keeps the Pi document untouched when import is disabled', async () => {
    const path = await piAuth({ 'openai-codex': OAUTH })
    const backing = provider()
    const store = new HarnessPiAiCredentialStore(backing.face, { importPiAuth: false, piAuthFile: path })

    expect(await store.read('openai-codex')).toBeUndefined()
    expect(backing.face.set).not.toHaveBeenCalled()
  })

  it('ignores an incompatible Pi document instead of breaking account status', async () => {
    const path = await piAuth({ 'openai-codex': { type: 'oauth', access: 'missing refresh' } })
    const backing = provider()
    const store = new HarnessPiAiCredentialStore(backing.face, { importPiAuth: true, piAuthFile: path })

    expect(await store.read('openai-codex')).toBeUndefined()
    expect(backing.face.set).not.toHaveBeenCalled()
  })
})
