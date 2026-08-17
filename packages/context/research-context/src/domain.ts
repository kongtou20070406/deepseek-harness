/** Durable research-state and context-assembly session events. */

import type {
  ResearchContextInheritanceProjection,
  ResearchContextProjection,
  ResearchHandoffCandidate,
  ResearchIdeaSummary,
  ResearchStateProjection,
} from './types.ts'

/** Operations that create a new whole-value research-state revision. */
export type ResearchStateOperation =
  | 'initialize'
  | 'migrate-session-idea'
  | 'sync-project'
  | 'propose-authority'
  | 'confirm-authority'
  | 'reject-authority'
  | 'update-authority'
  | 'update-working'
  | 'update-inquiry'
  | 'raise-leap'
  | 'resolve-leap'
  | 'edit-board'

/** Durable whole-value research-state mutation. */
export interface ResearchStateChange {
  readonly version: 1
  readonly operation: ResearchStateOperation
  readonly state: ResearchStateProjection
}

/** Durable manifest for one model-visible research-context view. */
export interface ResearchContextAssembly {
  readonly version: 1
  readonly manifest: ResearchContextProjection
}

/** Durable per-session switch controlling whether Idea context is assembled. */
export interface ResearchContextControl {
  readonly version: 1
  readonly enabled: boolean
}

/** Durable per-session selection of a Workspace Idea, or null when closed. */
export interface ResearchIdeaSelection {
  readonly version: 1
  readonly ideaId: string | null
  readonly ideas: readonly ResearchIdeaSummary[]
}

/** Durable cross-session manifest for one model-visible worker request. */
export interface ResearchContextInheritance {
  readonly version: 1
  readonly manifest: ResearchContextInheritanceProjection
}

/** Durable import of one cross-harness continuation bridge. */
export interface ResearchHandoffImport {
  readonly version: 1
  readonly handoff: Omit<ResearchHandoffCandidate, 'importEventSeq'>
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Complete post-mutation research state. */
    'research/state-change': ResearchStateChange
    /** Source-addressed manifest for a compiled model-visible view. */
    'research/context-assembly': ResearchContextAssembly
    /** Per-session switch for including Idea context in requests. */
    'research/context-control': ResearchContextControl
    /** Per-session Workspace Idea catalog and selection. */
    'research/idea-selection': ResearchIdeaSelection
    /** Cross-session provenance for a compiled child-worker view. */
    'research/context-inheritance': ResearchContextInheritance
    /** Cross-harness continuation evidence imported without changing authority. */
    'research/handoff-imported': ResearchHandoffImport
  }
}
