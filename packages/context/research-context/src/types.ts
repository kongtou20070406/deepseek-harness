/** Pure research-state and context-assembly projection types. */

/** Reference scope of one assembled request. */
export type FocusMode = 'continue' | 'task' | 'reframe'

/** Task-specific projection of the sparse Inquiry Map. */
export type IdeaLensMode = 'execute' | 'explore' | 'audit' | 'paper'

/** Sparse scientific-rationale node kinds; absent kinds do not need placeholders. */
export type ResearchInquiryNodeKind =
  | 'question'
  | 'hypothesis'
  | 'rival'
  | 'assumption'
  | 'claim'
  | 'evidence-requirement'
  | 'evidence'
  | 'counterevidence'
  | 'decision'
  | 'rejection'

/** Current disposition of one model-external inquiry node. */
export type ResearchInquiryNodeStatus = 'active' | 'supported' | 'challenged' | 'retired' | 'rejected'

/** Practical Idea-support contract carried by an evidence-requirement node. */
export type ResearchEvidenceClass =
  | 'task-effect'
  | 'matched-baseline'
  | 'mechanism'
  | 'ablation'
  | 'generalization'
  | 'resource'
  | 'statistics'
  | 'reproducibility'
  | 'negative-evidence'

/** One sparse, source-addressed element of the model-external Inquiry Map. */
export interface ResearchInquiryNode {
  readonly id: string
  readonly kind: ResearchInquiryNodeKind
  readonly text: string
  readonly status: ResearchInquiryNodeStatus
  /** Human nodes are immutable to model tools; contrary evidence is appended instead. */
  readonly origin: 'model' | 'human'
  /** Only opted-in cards participate in Idea Lens selection. */
  readonly modelVisible: boolean
  readonly sourceSeqs: readonly number[]
  readonly evidenceClass?: ResearchEvidenceClass
  readonly createdAt: number
  readonly updatedAt: number
}

/** Semantic board topology. Canvas positions are intentionally stored elsewhere. */
export interface ResearchInquiryEdge {
  readonly id: string
  readonly fromId: string
  readonly toId: string
  readonly relation: 'supports' | 'challenges' | 'depends-on' | 'alternative-to' | 'informs' | 'supersedes' | 'related'
  readonly label?: string
  readonly origin: 'model' | 'human'
  readonly modelVisible: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

/** The single question whose answer would most change the next research action. */
export interface ResearchDecisionFrontier {
  readonly question: string
  readonly changesActionWhen: string
  readonly evidenceNeeded: string
  readonly nodeIds: readonly string[]
  readonly updatedAt: number
}

/** A meaning-changing choice reserved for the researcher while evidence work continues. */
export interface ResearchLeapProposal {
  readonly id: string
  readonly trigger: 'seed-change' | 'confirmed-boundary-conflict' | 'shared-route-failure' | 'high-lock-in-choice'
  readonly question: string
  readonly whyHuman: string
  readonly candidates: readonly string[]
  readonly blockedAction: string
  readonly evidenceFrontierActions: readonly string[]
  readonly evidenceNodeIds: readonly string[]
  readonly status: 'pending' | 'accepted' | 'rejected' | 'superseded'
  readonly chosenCandidate?: string
  readonly proposedAt: number
  readonly resolvedAt?: number
}

/** Bounded current projection; superseded details remain in append-only events. */
export interface ResearchInquiryState {
  readonly revision: number
  readonly nodes: readonly ResearchInquiryNode[]
  readonly edges: readonly ResearchInquiryEdge[]
  readonly frontier?: ResearchDecisionFrontier
  readonly leap?: ResearchLeapProposal
  readonly updatedAt: number
}

/** Host-computed evidence-navigation state for one explicit requirement. */
export interface ResearchEvidenceRequirementAssessment {
  readonly requirementId: string
  readonly evidenceClass: ResearchEvidenceClass
  readonly status: 'open' | 'candidate' | 'challenged'
  readonly supportingNodeIds: readonly string[]
  readonly challengingNodeIds: readonly string[]
}

/** Deterministic navigation projection; it intentionally does not claim scientific closure. */
export interface ResearchEvidenceSupportProjection {
  readonly status: 'untracked' | 'open' | 'candidate' | 'challenged'
  readonly requirements: readonly ResearchEvidenceRequirementAssessment[]
  readonly candidateCount: number
  readonly challengedCount: number
}

/** How far one confirmed research-pursuit revision moves from its predecessor. */
export type ResearchAuthorityChangeScope = 'clarify' | 'adjust' | 'pivot'

/** Human-readable basis for a slow authority revision; it stays out of the hot prompt. */
export interface ResearchAuthorityEvolution {
  readonly scope: ResearchAuthorityChangeScope
  /** Feedback that motivated the change and the commitments that remain. */
  readonly basis: string
}

/** One immutable version of the currently active, slowly evolving research pursuit. */
export interface ResearchAuthorityValue {
  readonly version: number
  readonly text: string
  readonly confirmedAt: number
  readonly evolution?: ResearchAuthorityEvolution
}

/** Stable target identity and label exposed to a Workspace's sessions. */
export interface ResearchIdeaSummary {
  readonly ideaId: string
  readonly title: string
  readonly revision: number
}

/** Model-maintained execution state; it never changes scientific authority. */
export interface ResearchWorkingState {
  readonly revision: number
  readonly currentTask: string
  readonly unresolved: readonly string[]
  readonly nextAction: string
  readonly evidenceRoots: readonly number[]
  readonly updatedAt: number
}

/** One unconfirmed replacement candidate. */
export interface ResearchAuthorityProposal {
  readonly id: string
  readonly target: 'kernel' | 'frame'
  readonly baseVersion: number | null
  readonly text: string
  readonly proposedAt: number
  readonly evolution?: ResearchAuthorityEvolution
}

/** Current event-sourced research state. */
export interface ResearchStateProjection {
  readonly revision: number
  readonly kernel: ResearchAuthorityValue
  readonly frame?: ResearchAuthorityValue
  readonly working?: ResearchWorkingState
  /** Sparse adaptive record; omitted for legacy projects until first use. */
  readonly inquiry?: ResearchInquiryState
  readonly proposal?: ResearchAuthorityProposal
  readonly updatedAt: number
}

/** Approximate token contribution of one compiled research-context component. */
export interface ResearchContextComponents {
  readonly kernelTokens: number
  readonly frameTokens: number
  readonly workingTokens: number
  readonly goalTokens: number
  readonly historyTokens: number
  readonly locatorTokens: number
  /** Task-projected Inquiry Map contribution; absent in legacy manifests. */
  readonly lensTokens?: number
}

/** Latest durable assembly manifest projected to clients. */
export interface ResearchContextProjection {
  readonly stateRevision: number
  readonly turn: number | null
  readonly selectedTurns: readonly number[]
  /** Message-level locators used when an oversized loop was only partly restored. */
  readonly selectedLocators: readonly string[]
  /** Selected loops whose causal bridge plus relevant rows replaced the complete loop. */
  readonly partialTurns: readonly number[]
  readonly omittedTurnCount: number
  readonly sourceSeqs: readonly number[]
  readonly estimatedTokens: number
  readonly assemblyMicros: number
  readonly components: ResearchContextComponents
  readonly goalId?: string
  readonly focusMode: FocusMode
  /** Narrow task projection selected for this request. */
  readonly ideaLens?: IdeaLensMode
}

/** One bounded UI-history item; the complete timeline remains in the Session log. */
export interface ResearchContextHistoryItem {
  readonly kind: 'assembly' | 'inheritance'
  readonly eventSeq: number
  readonly time: number
  readonly estimatedTokens: number
  readonly assemblyMicros: number
  readonly selectedCount: number
  readonly omittedCount: number
  readonly focusMode: FocusMode
  readonly ideaLens?: IdeaLensMode
}

/** A child report is evidence to review, never an authority mutation. */
export interface ResearchEvidenceCandidate {
  readonly id: string
  readonly sourceSessionId: string
  readonly sourceMessageSeq: number
  readonly sourceKind: 'report' | 'settlement' | 'handoff'
  readonly text: string
  readonly createdAt: number
}

/** One imported cross-harness bridge. It is evidence, never research authority. */
export interface ResearchHandoffCandidate {
  readonly id: string
  readonly sourceHarness: string
  readonly sourceSessionId: string
  readonly projectPath?: string
  readonly anchors: readonly string[]
  readonly text: string
  readonly importedAt: number
  readonly importEventSeq: number
}

/** One child request assembled from a parent research view plus local worker history. */
export interface ResearchContextInheritanceProjection {
  /** Durable source session whose confirmed research state was inherited. */
  readonly parentSessionId: string
  /** Parent research-state revision used for this child request. */
  readonly parentStateRevision: number
  /** Parent raw-event addresses selected by the parent assembler. */
  readonly parentSourceSeqs: readonly number[]
  /** Parent loop ids selected by the parent assembler. */
  readonly parentSelectedTurns: readonly number[]
  /** Child-local raw-event addresses retained after the inherited prefix. */
  readonly workerSourceSeqs: readonly number[]
  /** Child-local loop ids retained after the inherited prefix. */
  readonly workerSelectedTurns: readonly number[]
  /** Child-local loop ids omitted from this request. */
  readonly workerOmittedTurns: readonly number[]
  /** Approximate tokens in the complete model-visible child view. */
  readonly estimatedTokens: number
  /** CPU time used by parent retrieval plus worker assembly. */
  readonly assemblyMicros: number
  /** Hash of the exact inherited model-visible view. */
  readonly viewHash: string
  readonly goalId?: string
  readonly focusMode: FocusMode
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Current confirmed research authority plus model-maintained working state. */
    researchState: ResearchStateProjection | null
    /** Whether this Session includes Idea context in model requests. */
    researchContextEnabled: boolean
    /** Current Workspace Idea catalog visible to this Session. */
    researchIdeas: readonly ResearchIdeaSummary[]
    /** Selected Idea id, or null when the Session is closed to Idea context. */
    researchIdeaId: string | null
    /** Latest logged selective-context assembly manifest. */
    researchContext: ResearchContextProjection | null
    /** Latest parent-to-child research-context inheritance manifest. */
    researchContextInheritance: ResearchContextInheritanceProjection | null
    /** Bounded recent manifests for the ContextMeter; raw events retain full history. */
    researchContextHistory: readonly ResearchContextHistoryItem[]
    /** Bounded recent child-result candidates with exact source provenance. */
    researchEvidenceCandidates: readonly ResearchEvidenceCandidate[]
    /** Bounded imported cross-harness bridges; the raw import events remain authoritative. */
    researchHandoffs: readonly ResearchHandoffCandidate[]
  }
}
