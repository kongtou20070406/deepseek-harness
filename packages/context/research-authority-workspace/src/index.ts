/** Read-only migration bridge from the retired Workspace Idea catalog. */

import { normalize } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {
  ResearchIdeaRecord,
  ResearchLegacyStateProvider,
  ResearchProjectRecord,
  ResearchStateProjection,
} from '@deepseek-ai/dsh-research-context'
import { researchProjectRecordSchema } from '@deepseek-ai/dsh-research-context'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { Workspace } from '@deepseek-ai/dsh-workspace'

export const name = 'research-authority-workspace'
export const inject = ['researchContext', 'storageDomain', 'workspaceRegistry']

/** Legacy storage schema retained so old Workspace Ideas remain recoverable. */
export const researchAuthorityWorkspaceSpec = defineDomain({
  name: 'research_authority_workspace',
  version: 1,
  tables: { projects: domainTable<string, ResearchProjectRecord>(researchProjectRecordSchema) },
})

function pathKey(value: string): string {
  const normalized = normalize(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function workspaceFor(ctx: Context, session: Session): Workspace | undefined {
  const cwd = session.header.cwd
  if (cwd === undefined) return undefined
  const key = pathKey(cwd)
  return ctx.workspaceRegistry.list().find(candidate => pathKey(candidate.path) === key)
}

function selectedIdeaId(session: Session): string | null {
  for (let offset = session.events.length - 1; offset >= 0; offset -= 1) {
    const event = session.events[offset]
    if (event?.type === 'research/idea-selection') return event.data.ideaId
  }
  return null
}

/**
 * Old Workspace state is a seed only. The first read clones it into the
 * Session append-only log; all later reads and writes are Session-owned.
 */
class WorkspaceLegacyStateProvider implements ResearchLegacyStateProvider {
  readonly id = '@deepseek-ai/dsh-research-authority-workspace/legacy'

  constructor(
    private readonly ctx: Context,
    private readonly projects: KvTable<string, ResearchProjectRecord>,
  ) {}

  read(session: Session): ResearchStateProjection | undefined {
    const workspace = workspaceFor(this.ctx, session)
    if (workspace === undefined) return undefined
    const record = this.projects.get(String(workspace.id))
    if (record === undefined) return undefined
    return structuredClone(this.ideaRecord(record, selectedIdeaId(session)).state)
  }

  private ideaRecords(record: ResearchProjectRecord): readonly ResearchIdeaRecord[] {
    if (record.ideas !== undefined && record.ideas.length > 0) return record.ideas
    return [{
      ideaId: 'idea-default',
      title: (record.state.kernel.text.split(/[。.!！？?\n]/u, 1)[0] ?? '').trim() || 'Idea',
      state: record.state,
    }]
  }

  private ideaRecord(record: ResearchProjectRecord, ideaId: string | null): ResearchIdeaRecord {
    const ideas = this.ideaRecords(record)
    const selected = ideas.find(idea => idea.ideaId === ideaId)
    if (selected !== undefined) return selected
    const first = ideas[0]
    if (first === undefined) throw new Error('legacy research project has no ideas')
    return first
  }
}

/** Attach the old store only as a lazy, read-only Session migration source. */
export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(researchAuthorityWorkspaceSpec)
  const provider = new WorkspaceLegacyStateProvider(ctx, domain.table('projects'))
  const unregister = ctx.researchContext.registerLegacyStateProvider(provider)
  ctx.effect(() => async () => {
    unregister()
    await domain.close()
  })
}
