import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ResearchContextAssembler from '@deepseek-ai/dsh-research-context'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { apply, researchAuthorityWorkspaceSpec } from '../src/index.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Workspace research authority migration', () => {
  it('clones one old Workspace Idea into each Session once, then keeps Sessions independent', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend())
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    ctx.provide('sessionPersistence', { list: async () => [], inspect: async () => { throw new Error('unused') } } as never)
    await ctx.plugin(SessionStore)
    await ctx.plugin(WorkspaceRegistry)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(ResearchContextAssembler, {
      kernel: 'new-session placeholder', maxViewChars: 48_000,
      maxViewTokens: 48_000, fallbackAuthorityTokens: 4_096,
      recentTurns: 1, maxEvidenceTurns: 1,
    })

    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-idea-migration-')))
    roots.push(root)
    const workspace = await ctx.workspaceRegistry.create(root)
    const legacyState = {
      revision: 7,
      kernel: { version: 3, text: '旧 Workspace Idea', confirmedAt: 1 },
      frame: { version: 2, text: '旧路线', confirmedAt: 1 },
      updatedAt: 1,
    }
    const seedDomain = await facility.open(researchAuthorityWorkspaceSpec)
    await seedDomain.table('projects').put(String(workspace.id), {
      workspaceId: String(workspace.id), path: root, state: legacyState,
    })
    await seedDomain.close()

    const first = ctx.sessions.create(SessionId('idea-migration-1'), { meta: { cwd: root } })
    const second = ctx.sessions.create(SessionId('idea-migration-2'), { meta: { cwd: root } })
    await apply(ctx)
    const firstMigrated = await ctx.researchContext.stateForRequest(first)
    const secondMigrated = await ctx.researchContext.stateForRequest(second)
    expect(firstMigrated.kernel.text).toBe('旧 Workspace Idea')
    expect(secondMigrated.kernel.text).toBe('旧 Workspace Idea')
    expect(first.events.filter(event => event.type === 'research/state-change')).toMatchObject([
      { data: { operation: 'migrate-session-idea' } },
    ])

    await ctx.researchContext.updateAuthority(first, firstMigrated.revision, 'kernel', '第一个对话自己的 Idea')
    expect((await ctx.researchContext.stateForRequest(first)).kernel.text).toBe('第一个对话自己的 Idea')
    expect((await ctx.researchContext.stateForRequest(second)).kernel.text).toBe('旧 Workspace Idea')

    const later = ctx.sessions.create(SessionId('idea-migration-later'), { meta: { cwd: root } })
    expect((await ctx.researchContext.stateForRequest(later)).kernel.text).toBe('旧 Workspace Idea')
  })
})
