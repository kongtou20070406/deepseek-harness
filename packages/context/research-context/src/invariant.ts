/** Package-owned durable research-stream invariants. @module @deepseek-ai/dsh-research-context/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ResearchContextAssembly, ResearchStateChange } from './domain.ts'
import type { ResearchStateProjection } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-research-context'

/** Cordis companion plugin name. */
export const name = 'research-context-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

interface Fold {
  revision: number
  state: ResearchStateProjection | undefined
}

function validateState(change: ResearchStateChange, prior: Fold, fail: InvariantFailure): Fold {
  if (change.version !== 1) fail('research/state-change must use version 1')
  const state = change.state
  if (change.operation !== 'sync-project' && state.revision !== prior.revision + 1) {
    fail(`research state revision ${state.revision} must follow ${prior.revision}`)
  }
  if (change.operation === 'sync-project' && prior.state === undefined) {
    fail('project research state must initialize before it can synchronize')
  }
  if (prior.state === undefined && change.operation !== 'initialize') {
    fail('the first research state operation must be initialize')
  }
  if (prior.state !== undefined && change.operation === 'initialize') {
    fail('research authority may only be initialized once')
  }
  if (state.proposal !== undefined) {
    const base = state.proposal.target === 'kernel' ? state.kernel : state.frame
    const baseVersion = (state.proposal as ResearchStateProjection['proposal'] & { baseVersion?: number | null }).baseVersion
    if (baseVersion !== undefined && (base?.version ?? null) !== baseVersion) {
      fail('research proposal base version is stale')
    }
  }
  return { revision: state.revision, state }
}

function validateEvent(event: SessionEvent, prior: Fold, fail: InvariantFailure): Fold {
  if (event.type === 'research/state-change') {
    return validateState(event.data as ResearchStateChange, prior, fail)
  }
  if (event.type === 'research/context-assembly') {
    const { manifest } = event.data as ResearchContextAssembly
    if (manifest.stateRevision !== prior.revision) {
      fail(`research assembly revision ${manifest.stateRevision} does not match current ${prior.revision}`)
    }
    if (manifest.sourceSeqs.some(seq => !Number.isSafeInteger(seq) || seq < 0 || seq >= event.seq)) {
      fail('research assembly source seqs must reference earlier durable events')
    }
  }
  return prior
}

/** Independently replay and validate research state revisions and manifest provenance. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const states = new WeakMap<Session, Fold>()
  const staged = new WeakMap<SessionEvent, { session: Session; state: Fold }>()
  const seed = (session: Session): Fold => {
    let state: Fold = { revision: 0, state: undefined }
    for (const event of session.events) state = validateEvent(event, state, fail)
    states.set(session, state)
    return state
  }
  const stateFor = (session: Session): Fold => states.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const state = validateEvent(event, stateFor(session), fail)
    staged.set(event, { session, state })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    const candidate = staged.get(event)
    if (candidate === undefined || candidate.session !== session) {
      return fail('session/event reached publication without research-stream validation')
    }
    staged.delete(event)
    states.set(session, candidate.state)
  }, { global: true })
}, { inject: ['sessions'] })

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
