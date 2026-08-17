/**
 * Event-sourced research authority and deterministic context assembly.
 * @module @deepseek-ai/dsh-research-context
 */

import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { Context, FiberState, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {
  ResearchContextAssembly,
  ResearchHandoffImport,
  ResearchContextInheritance,
  ResearchIdeaSelection,
  ResearchStateChange,
  ResearchStateOperation,
} from './domain.ts'
import type {
  FocusMode,
  IdeaLensMode,
  ResearchAuthorityProposal,
  ResearchAuthorityEvolution,
  ResearchAuthorityValue,
  ResearchContextComponents,
  ResearchIdeaSummary,
  ResearchContextInheritanceProjection,
  ResearchContextHistoryItem,
  ResearchContextProjection,
  ResearchEvidenceCandidate,
  ResearchHandoffCandidate,
  ResearchInquiryEdge,
  ResearchInquiryNode,
  ResearchInquiryNodeKind,
  ResearchInquiryNodeStatus,
  ResearchInquiryState,
  ResearchLeapProposal,
  ResearchStateProjection,
  ResearchWorkingState,
} from './types.ts'
import { evaluateResearchEvidenceSupport } from './evidence.ts'

export type * from './domain.ts'
export type * from './types.ts'
export { evaluateResearchEvidenceSupport } from './evidence.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    researchContext: ResearchContextAssembler
  }
}

/** Deployment-owned initial authority and bounded-selection policy. */
export interface ResearchContextConfig {
  /** Verbatim confirmed scientific object, success condition, and non-substitution rule. */
  kernel: string
  /** Optional verbatim confirmed initial route. */
  frame?: string
  /** Maximum complete rendered view size in UTF-16 code units. */
  maxViewChars: number
  /** Maximum approximate tokens in the compiled view. */
  maxViewTokens?: number
  /** Maximum approximate tokens allowed in the always-present Idea Kernel. */
  maxKernelTokens?: number
  /** Conservative authority limit before a request has exposed route capacity. */
  fallbackAuthorityTokens?: number
  /** Most recent complete turns retained without a lexical match. */
  recentTurns: number
  /** Maximum older evidence turns selected for one request. */
  maxEvidenceTurns: number
  /** Maximum nodes in the current sparse Inquiry Map projection. Raw events remain append-only. */
  maxInquiryNodes?: number
  /** Optional deployment-owned terminology aliases; no model call is made. */
  retrievalAliases?: Record<string, string[]>
}

/** Optional durable owner for project Ideas selected by each Session. */
export interface ResearchAuthorityProvider {
  readonly id: string
  /** Read the selected project's authority record synchronously. */
  read(session: Session): ResearchStateProjection | undefined
  /** List the Workspace's selectable Idea targets synchronously. */
  list?(session: Session): readonly ResearchIdeaSummary[]
  /** Durably create the project's first authority record, or return the winner of a concurrent create. */
  initialize(session: Session, initial: ResearchStateProjection): Promise<ResearchStateProjection>
  /** Durably create one additional Idea target and return its summary. */
  create?(session: Session, title: string, initial: ResearchStateProjection): Promise<ResearchIdeaSummary>
  /** Durably replace one exact project revision for the Session's selected Idea. */
  commit(
    session: Session,
    expectedRevision: number,
    next: ResearchStateProjection,
  ): Promise<ResearchStateProjection>
}

/** Read-only compatibility seam used once when an old Session has no Idea snapshot yet. */
export interface ResearchLegacyStateProvider {
  readonly id: string
  /** Return the legacy Idea selected by this Session, without mutating legacy storage. */
  read(session: Session): ResearchStateProjection | undefined
}

/** Schemastery validation for {@link ResearchContextConfig}. */
export const Config: z<ResearchContextConfig> = z.object({
  kernel: z.string().required(),
  frame: z.string(),
  maxViewChars: z.number().step(1).min(1).required(),
  maxViewTokens: z.number().step(1).min(1).default(48_000),
  maxKernelTokens: z.number().step(1).min(1).default(512),
  fallbackAuthorityTokens: z.number().step(1).min(1).default(4_096),
  recentTurns: z.number().step(1).min(0).required(),
  maxEvidenceTurns: z.number().step(1).min(0).required(),
  maxInquiryNodes: z.number().step(1).min(8).default(64),
  retrievalAliases: z.dict(z.array(z.string())),
})

type LoopRowKind = 'dialogue' | 'tool-evidence'

interface LoopRow {
  readonly seq: number
  readonly kind: LoopRowKind
  readonly text: string
  readonly terms: ReadonlySet<string>
}

interface TurnBlock {
  readonly turn: number
  readonly seqs: readonly number[]
  readonly text: string
  readonly terms: ReadonlySet<string>
  readonly rows: readonly LoopRow[]
}

interface MutableTurnBlock {
  turn: number
  seqs: number[]
  rows: LoopRow[]
}

/** One synchronous, model-free scoring seam. Plugins may register a ready local index. */
export interface ResearchRetrievalProvider {
  readonly id: string
  score(query: ReadonlySet<string>, candidate: {
    readonly turn: number
    readonly kind: 'loop' | LoopRowKind | 'handoff'
    readonly text: string
    readonly terms: ReadonlySet<string>
  }): number
}

interface SessionIndex {
  indexedSeq: number
  blocks: TurnBlock[]
  handoffs: ResearchHandoffCandidate[]
  active: MutableTurnBlock | undefined
  termPostings: Map<string, Set<number>>
  termGrams: Map<string, ReadonlySet<string>>
  gramTerms: Map<string, Set<string>>
  directUserCount: number
  latestDirectUser: { readonly seq: number; readonly text: string } | undefined
}

/** File/adapter-neutral handoff payload accepted by the assembler. */
export interface ResearchHandoffInput {
  readonly sourceHarness: string
  readonly sourceSessionId: string
  readonly projectPath?: string
  readonly anchors?: readonly string[]
  readonly text: string
  readonly createdAt?: number
}

type ResolvedResearchContextConfig = ResearchContextConfig & {
  maxViewTokens: number
  maxKernelTokens: number
  fallbackAuthorityTokens: number
  maxInquiryNodes: number
}

/** Optional active Goal data supplied by the compaction consumer. */
export interface ResearchContextGoal {
  readonly id: string
  readonly objective: string
  readonly phase: string
  readonly roundsStarted: number
}

/** Auditable output consumed by a model-surface plugin. */
export interface ResearchContextView {
  readonly text: string
  readonly sourceSeqs: readonly number[]
  readonly selectedTurns: readonly number[]
  readonly selectedLocators: readonly string[]
  readonly partialTurns: readonly number[]
  readonly omittedTurns: readonly number[]
  readonly scannedEvents: number
  readonly stateRevision: number
  readonly estimatedTokens: number
  readonly assemblyMicros: number
  readonly components: ResearchContextComponents
  readonly goalId?: string
  readonly focusMode: FocusMode
  readonly ideaLens: IdeaLensMode
}

/** Model-visible child view compiled from parent research state and child-local loops. */
export interface ResearchWorkerContextView {
  readonly text: string
  readonly manifest: ResearchContextInheritanceProjection
}

/** Input accepted by a model-authorized Working State update. */
export interface WorkingStateInput {
  readonly currentTask: string
  readonly unresolved: readonly string[]
  readonly nextAction: string
  readonly evidenceRoots: readonly number[]
}

/** One model-owned upsert into the sparse Inquiry Map. */
export interface InquiryNodeInput {
  readonly id?: string
  readonly kind: ResearchInquiryNodeKind
  readonly text: string
  readonly status?: ResearchInquiryNodeStatus
  readonly modelVisible?: boolean
  readonly sourceSeqs?: readonly number[]
  readonly evidenceClass?: ResearchInquiryNode['evidenceClass']
}

/** One model-owned semantic edge. Pure canvas geometry is never accepted here. */
export interface InquiryEdgeInput {
  readonly id?: string
  readonly fromId: string
  readonly toId: string
  readonly relation: ResearchInquiryEdge['relation']
  readonly label?: string
  readonly modelVisible?: boolean
}

/** Optional replacement of the single current Decision Frontier. */
export interface DecisionFrontierInput {
  readonly question: string
  readonly changesActionWhen: string
  readonly evidenceNeeded: string
  readonly nodeIds?: readonly string[]
}

/** Sparse model-maintained update. Omitted frontier preserves the current one. */
export interface InquiryUpdateInput {
  readonly nodes: readonly InquiryNodeInput[]
  readonly edges?: readonly InquiryEdgeInput[]
  readonly frontier?: DecisionFrontierInput | null
}

/** Meaning-changing choice that only the human may resolve. */
export interface LeapProposalInput {
  readonly trigger: ResearchLeapProposal['trigger']
  readonly question: string
  readonly whyHuman: string
  readonly candidates: readonly string[]
  readonly blockedAction: string
  readonly evidenceFrontierActions: readonly string[]
  readonly evidenceNodeIds?: readonly string[]
}

/** Human-authored detective-board card. Layout remains browser-local. */
export interface HumanBoardNodeInput {
  readonly id?: string
  readonly kind: ResearchInquiryNodeKind
  readonly text: string
  readonly modelVisible?: boolean
}

/** Human-authored semantic connection; moving cards never creates one. */
export interface HumanBoardEdgeInput {
  readonly id?: string
  readonly fromId: string
  readonly toId: string
  readonly relation: ResearchInquiryEdge['relation']
  readonly label?: string
  readonly modelVisible?: boolean
}

const authorityValueSchema = zod.object({
  version: zod.number().int().positive(),
  text: zod.string().min(1),
  confirmedAt: zod.number(),
  evolution: zod.object({
    scope: zod.union([zod.literal('clarify'), zod.literal('adjust'), zod.literal('pivot')]),
    basis: zod.string().min(1),
  }).strict().optional(),
}).strict()

const proposalSchema = zod.object({
  id: zod.string().min(1),
  target: zod.union([zod.literal('kernel'), zod.literal('frame')]),
  baseVersion: zod.number().int().positive().nullable(),
  text: zod.string().min(1),
  proposedAt: zod.number(),
  evolution: zod.object({
    scope: zod.union([zod.literal('clarify'), zod.literal('adjust'), zod.literal('pivot')]),
    basis: zod.string().min(1),
  }).strict().optional(),
}).strict()

const workingSchema = zod.object({
  revision: zod.number().int().positive(),
  currentTask: zod.string().min(1),
  unresolved: zod.array(zod.string()),
  nextAction: zod.string(),
  evidenceRoots: zod.array(zod.number().int().nonnegative()),
  updatedAt: zod.number(),
}).strict()

const inquiryNodeKindSchema = zod.union([
  zod.literal('question'), zod.literal('hypothesis'), zod.literal('rival'),
  zod.literal('assumption'), zod.literal('claim'), zod.literal('evidence-requirement'),
  zod.literal('evidence'), zod.literal('counterevidence'), zod.literal('decision'), zod.literal('rejection'),
])

const inquiryNodeSchema = zod.object({
  id: zod.string().min(1),
  kind: inquiryNodeKindSchema,
  text: zod.string().min(1),
  status: zod.union([
    zod.literal('active'), zod.literal('supported'), zod.literal('challenged'),
    zod.literal('retired'), zod.literal('rejected'),
  ]),
  origin: zod.union([zod.literal('model'), zod.literal('human')]),
  modelVisible: zod.boolean(),
  sourceSeqs: zod.array(zod.number().int().nonnegative()),
  evidenceClass: zod.union([
    zod.literal('task-effect'), zod.literal('matched-baseline'), zod.literal('mechanism'),
    zod.literal('ablation'), zod.literal('generalization'),
    zod.literal('resource'), zod.literal('statistics'), zod.literal('reproducibility'),
    zod.literal('negative-evidence'),
  ]).optional(),
  createdAt: zod.number(),
  updatedAt: zod.number(),
}).strict()

const inquiryEdgeSchema = zod.object({
  id: zod.string().min(1),
  fromId: zod.string().min(1),
  toId: zod.string().min(1),
  relation: zod.union([
    zod.literal('supports'), zod.literal('challenges'), zod.literal('depends-on'),
    zod.literal('alternative-to'), zod.literal('informs'), zod.literal('supersedes'), zod.literal('related'),
  ]),
  label: zod.string().min(1).optional(),
  origin: zod.union([zod.literal('model'), zod.literal('human')]),
  modelVisible: zod.boolean(),
  createdAt: zod.number(),
  updatedAt: zod.number(),
}).strict()

const frontierSchema = zod.object({
  question: zod.string().min(1),
  changesActionWhen: zod.string().min(1),
  evidenceNeeded: zod.string().min(1),
  nodeIds: zod.array(zod.string().min(1)),
  updatedAt: zod.number(),
}).strict()

const leapSchema = zod.object({
  id: zod.string().min(1),
  trigger: zod.union([
    zod.literal('seed-change'), zod.literal('confirmed-boundary-conflict'),
    zod.literal('shared-route-failure'), zod.literal('high-lock-in-choice'),
  ]),
  question: zod.string().min(1),
  whyHuman: zod.string().min(1),
  candidates: zod.array(zod.string().min(1)).min(1),
  blockedAction: zod.string().min(1),
  evidenceFrontierActions: zod.array(zod.string().min(1)),
  evidenceNodeIds: zod.array(zod.string().min(1)),
  status: zod.union([
    zod.literal('pending'), zod.literal('accepted'), zod.literal('rejected'), zod.literal('superseded'),
  ]),
  chosenCandidate: zod.string().min(1).optional(),
  proposedAt: zod.number(),
  resolvedAt: zod.number().optional(),
}).strict()

const inquirySchema = zod.object({
  revision: zod.number().int().positive(),
  nodes: zod.array(inquiryNodeSchema),
  edges: zod.array(inquiryEdgeSchema),
  frontier: frontierSchema.optional(),
  leap: leapSchema.optional(),
  updatedAt: zod.number(),
}).strict()

/** Runtime schema for one selectable Workspace Idea target. */
export const researchIdeaSummarySchema = zod.object({
  ideaId: zod.string().min(1),
  title: zod.string().min(1),
  revision: zod.number().int().positive(),
}).strict() as ZodType<ResearchIdeaSummary>

/** Runtime schema for the complete versioned research state. */
export const researchStateSchema = zod.object({
  revision: zod.number().int().positive(),
  kernel: authorityValueSchema,
  frame: authorityValueSchema.optional(),
  working: workingSchema.optional(),
  inquiry: inquirySchema.optional(),
  proposal: proposalSchema.optional(),
  updatedAt: zod.number(),
}).strict()

/** Durable state for one selectable Idea target inside a Workspace. */
export interface ResearchIdeaRecord {
  readonly ideaId: string
  readonly title: string
  readonly state: ResearchStateProjection
}

/** Durable project record shape shared with pluggable Workspace authority stores. */
export interface ResearchProjectRecord {
  readonly workspaceId: string
  readonly path: string
  readonly state: ResearchStateProjection
  readonly ideas?: readonly ResearchIdeaRecord[]
}

/** Runtime schema for a Workspace-keyed durable research record. */
export const researchProjectRecordSchema = zod.object({
  workspaceId: zod.string(),
  path: zod.string(),
  state: researchStateSchema,
  ideas: zod.array(zod.object({
    ideaId: zod.string().min(1),
    title: zod.string().min(1),
    state: researchStateSchema,
  }).strict()).min(1).optional(),
}).strict() as ZodType<ResearchProjectRecord>

const componentsSchema = zod.object({
  kernelTokens: zod.number().int().nonnegative(),
  frameTokens: zod.number().int().nonnegative(),
  workingTokens: zod.number().int().nonnegative(),
  goalTokens: zod.number().int().nonnegative(),
  historyTokens: zod.number().int().nonnegative(),
  locatorTokens: zod.number().int().nonnegative(),
  lensTokens: zod.number().int().nonnegative().optional(),
}).strict()

const focusModeSchema = zod.union([
  zod.literal('continue'),
  zod.literal('task'),
  zod.literal('reframe'),
])

const ideaLensSchema = zod.union([
  zod.literal('execute'), zod.literal('explore'), zod.literal('audit'), zod.literal('paper'),
])

const researchContextSchema = zod.object({
  stateRevision: zod.number().int().positive(),
  turn: zod.number().int().positive().nullable(),
  selectedTurns: zod.array(zod.number().int().positive()),
  selectedLocators: zod.array(zod.string()),
  partialTurns: zod.array(zod.number().int().positive()),
  omittedTurnCount: zod.number().int().nonnegative(),
  sourceSeqs: zod.array(zod.number().int().nonnegative()),
  estimatedTokens: zod.number().int().nonnegative(),
  assemblyMicros: zod.number().int().nonnegative(),
  components: componentsSchema,
  focusMode: focusModeSchema.default('task'),
  ideaLens: ideaLensSchema.optional(),
  goalId: zod.string().optional(),
}).strict()

const researchContextHistorySchema = zod.array(zod.object({
  kind: zod.union([zod.literal('assembly'), zod.literal('inheritance')]),
  eventSeq: zod.number().int().nonnegative(),
  time: zod.number(),
  estimatedTokens: zod.number().int().nonnegative(),
  assemblyMicros: zod.number().int().nonnegative(),
  selectedCount: zod.number().int().nonnegative(),
  omittedCount: zod.number().int().nonnegative(),
  focusMode: focusModeSchema.default('task'),
  ideaLens: ideaLensSchema.optional(),
}).strict())

const evidenceCandidateSchema = zod.object({
  id: zod.string().min(1),
  sourceSessionId: zod.string().min(1),
  sourceMessageSeq: zod.number().int().nonnegative(),
  sourceKind: zod.union([zod.literal('report'), zod.literal('settlement'), zod.literal('handoff')]),
  text: zod.string().min(1),
  createdAt: zod.number(),
}).strict()

const handoffCandidateSchema = zod.object({
  id: zod.string().min(1),
  sourceHarness: zod.string().min(1),
  sourceSessionId: zod.string().min(1),
  projectPath: zod.string().min(1).optional(),
  anchors: zod.array(zod.string().min(1)),
  text: zod.string().min(1),
  importedAt: zod.number(),
  importEventSeq: zod.number().int().nonnegative(),
}).strict()

const researchContextInheritanceSchema = zod.object({
  parentSessionId: zod.string().min(1),
  parentStateRevision: zod.number().int().positive(),
  parentSourceSeqs: zod.array(zod.number().int().nonnegative()),
  parentSelectedTurns: zod.array(zod.number().int().positive()),
  workerSourceSeqs: zod.array(zod.number().int().nonnegative()),
  workerSelectedTurns: zod.array(zod.number().int().positive()),
  workerOmittedTurns: zod.array(zod.number().int().positive()),
  estimatedTokens: zod.number().int().nonnegative(),
  assemblyMicros: zod.number().int().nonnegative(),
  viewHash: zod.string().min(1),
  focusMode: focusModeSchema.default('task'),
  goalId: zod.string().optional(),
}).strict()

function blockText(block: ContentBlock): string {
  if ('text' in block && typeof block.text === 'string') return block.text
  if (block.type === 'tool-call') return `${block.name} ${JSON.stringify(block.arguments)}`
  if (block.type === 'tool-result') return block.content.map(blockText).filter(Boolean).join('\n')
  return ''
}

function messageText(message: Message): string {
  return message.content.map(blockText).filter(Boolean).join('\n').trim()
}

function estimateMessageTokens(ctx: Context, text: string): number {
  if (text.length === 0) return 0
  return ctx.tokenMeter.estimateMessage(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-research-context', form: 'snapshot', sections: [] },
  }))
}

function latestDirectUser(session: Session): { seq: number; text: string } | undefined {
  for (let offset = session.events.length - 1; offset >= 0; offset -= 1) {
    const event = session.events[offset]
    if (event === undefined) continue
    if (event.type !== 'user/message' || isDerivedPluginMessage(event)) continue
    const text = messageText(event.data)
    if (text.length > 0) return { seq: event.seq, text }
  }
  return undefined
}

function isDerivedPluginMessage(event: SessionEvent<'user/message'>): boolean {
  return event.data.source.kind === 'plugin'
}

const CONTINUE_REQUEST = /^(?:继续(?:做|推进|下去)?|接着(?:做|推进)?|往下(?:做|推进)?|resume|continue|go on)[\s吧呢啊呀。.！!？?，,]*$/iu
const REFRAME_MARKERS = [
  '重新接手',
  '重新梳理',
  '重新确定',
  '从头开始',
  '从最初',
  '我只给你一个目标',
  '之前的路走偏了',
  '不是当前目标',
  '抛开这些',
  '不要依赖旧',
] as const

/** Extract only the latest admitted direct user request, never a prior plugin view. */
function currentRequestText(messages: readonly Message[]): string {
  for (let offset = messages.length - 1; offset >= 0; offset -= 1) {
    const message = messages[offset]
    if (message === undefined) continue
    if (message.role !== 'user' || message.source.kind === 'plugin') continue
    const text = messageText(message)
    if (text.length > 0) return text
  }
  return messages.map(messageText).filter(Boolean).at(-1) ?? ''
}

/** Classify how much prior route state may influence one request. */
function classifyFocus(request: string, firstExplicitRequest: boolean): FocusMode {
  const normalized = request.normalize('NFKC').trim().toLowerCase()
  if (CONTINUE_REQUEST.test(normalized)) return 'continue'
  if (normalized.length > 0 && firstExplicitRequest) return 'reframe'
  if (REFRAME_MARKERS.some(marker => normalized.includes(marker))
    || /不对.{0,16}核心/u.test(normalized)) return 'reframe'
  return 'task'
}

/** Pick a narrow inquiry projection from observable task wording, without a model call. */
function classifyIdeaLens(request: string, working: string, focus: FocusMode): IdeaLensMode {
  const value = `${request}\n${working}`.normalize('NFKC').toLowerCase()
  if (/(?:论文|paper|manuscript|审稿|reviewer|claim|消融|ablation|对比实验|matched baseline|generalization|泛化)/u.test(value)) {
    return 'paper'
  }
  if (/(?:审计|audit|核验|复核|追溯|provenance|reproduc|证据链|是否成立|能否宣称)/u.test(value)) {
    return 'audit'
  }
  if (focus === 'reframe'
    || /(?:探索|explore|为什么|机制|mechanism|假设|hypothesis|竞争解释|rival|创新|idea|方向|有没有更好)/u.test(value)) {
    return 'explore'
  }
  return 'execute'
}

/** Keep a replacement target, not the explicitly rejected route, in reframe retrieval. */
function reframeQuery(request: string): string {
  let replacementAt = -1
  let replacementMarker = ''
  for (const marker of ['核心是', ...REFRAME_MARKERS]) {
    const at = request.lastIndexOf(marker)
    if (at > replacementAt) {
      replacementAt = at
      replacementMarker = marker
    }
  }
  if (replacementAt < 0) return request
  return request.slice(replacementAt + replacementMarker.length).trim().replace(/^[：:，,；;。！!？?\s]+/u, '')
}

function eventRow(event: SessionEvent): Omit<LoopRow, 'terms'> | undefined {
  switch (event.type) {
    case 'user/message': {
      if (isDerivedPluginMessage(event)) return
      const text = messageText(event.data)
      return text.length === 0 ? undefined : { seq: event.seq, kind: 'dialogue', text: `USER:\n${text}` }
    }
    case 'assistant/message': {
      const text = messageText(event.data.message)
      return text.length === 0 ? undefined : { seq: event.seq, kind: 'dialogue', text: `ASSISTANT:\n${text}` }
    }
    case 'tool/result': {
      const text = messageText(event.data.message)
      return text.length === 0 ? undefined : { seq: event.seq, kind: 'tool-evidence', text: `TOOL EVIDENCE:\n${text}` }
    }
    default:
      return
  }
}

function ngrams(value: string): Set<string> {
  const normalized = value.normalize('NFKC').toLowerCase().replace(/\s+/g, '')
  const result = new Set<string>()
  const width = normalized.length < 5 ? 2 : 3
  for (let index = 0; index + width <= normalized.length; index += 1) {
    result.add(normalized.slice(index, index + width))
  }
  return result
}

const MAX_INDEX_TERM_CHARS = 160
const MAX_GRAM_BUCKET_TERMS = 512
const MAX_FUZZY_CANDIDATES_PER_TERM = 64
const FUZZY_BUDGET_MS = 25
const PREWARM_EVENT_BATCH = 32

function termsOf(value: string): Set<string> {
  const terms = new Set<string>()
  const normalized = value.normalize('NFKC').toLowerCase()
  for (const match of normalized.matchAll(/[a-z0-9_./:-]{2,}|\p{Script=Han}{2,}/gu)) {
    const raw = match[0]
    const token = raw.length <= MAX_INDEX_TERM_CHARS
      ? raw
      : `${raw.slice(0, MAX_INDEX_TERM_CHARS / 2)}:${raw.slice(-MAX_INDEX_TERM_CHARS / 2)}`
    terms.add(token)
    if (/^\p{Script=Han}+$/u.test(raw)) {
      for (let index = 0; index + 1 < raw.length; index += 1) terms.add(raw.slice(index, index + 2))
    }
  }
  return terms
}

function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let count = 0
  for (const term of left) if (right.has(term)) count += 1
  return count
}

const LENS_KINDS: Readonly<Record<IdeaLensMode, ReadonlySet<ResearchInquiryNodeKind>>> = {
  execute: new Set(['decision', 'evidence', 'counterevidence', 'assumption', 'evidence-requirement']),
  explore: new Set(['question', 'hypothesis', 'rival', 'assumption', 'evidence', 'counterevidence']),
  audit: new Set(['claim', 'evidence-requirement', 'evidence', 'counterevidence', 'decision', 'rejection']),
  paper: new Set(['claim', 'evidence-requirement', 'evidence', 'counterevidence', 'decision', 'rejection']),
}

/** Select at most five relevant nodes; the complete map never enters a request. */
function selectInquiryNodes(
  inquiry: ResearchInquiryState | undefined,
  lens: IdeaLensMode,
  query: ReadonlySet<string>,
): readonly ResearchInquiryNode[] {
  if (inquiry === undefined || inquiry.nodes.length === 0) return []
  const linked = new Set([
    ...(inquiry.frontier?.nodeIds ?? []),
    ...(inquiry.leap?.status === 'pending' ? inquiry.leap.evidenceNodeIds : []),
  ])
  const eligible = inquiry.nodes.filter(node => node.modelVisible && node.status !== 'retired' && node.status !== 'rejected')
  const ranked = eligible
    .map((node, position) => {
      const lexical = overlap(query, termsOf(node.text))
      const kind = LENS_KINDS[lens].has(node.kind) ? 20 : 0
      const anchor = linked.has(node.id) ? 1_000 : 0
      const paper = lens === 'paper' && node.evidenceClass !== undefined ? 100 : 0
      return { node, score: anchor + paper + kind + lexical * 8 + position / Math.max(1, eligible.length) }
    })
    .filter(candidate => candidate.score >= 20 || linked.has(candidate.node.id))
    .sort((left, right) => right.score - left.score || right.node.updatedAt - left.node.updatedAt)
  const selected = ranked.slice(0, 5).map(candidate => candidate.node)
  const seed = selected.length > 0 ? selected : eligible.filter(node => LENS_KINDS[lens].has(node.kind)).slice(-2)
  if (seed.length >= 5) return seed
  const chosen = new Map(seed.map(node => [node.id, node] as const))
  const byId = new Map(eligible.map(node => [node.id, node] as const))
  for (const edge of inquiry.edges) {
    if (!edge.modelVisible) continue
    const fromChosen = chosen.has(edge.fromId)
    const toChosen = chosen.has(edge.toId)
    if (fromChosen === toChosen) continue
    const neighbor = byId.get(fromChosen ? edge.toId : edge.fromId)
    if (neighbor !== undefined) chosen.set(neighbor.id, neighbor)
    if (chosen.size >= 5) break
  }
  return [...chosen.values()]
}

function renderIdeaLens(
  inquiry: ResearchInquiryState | undefined,
  lens: IdeaLensMode,
  nodes: readonly ResearchInquiryNode[],
): string {
  if (inquiry === undefined || (nodes.length === 0 && inquiry.frontier === undefined && inquiry.leap?.status !== 'pending')) return ''
  const lines = [`<idea-lens mode="${lens}" map-revision="${inquiry.revision}">`]
  if (inquiry.frontier !== undefined) {
    lines.push(
      '<decision-frontier>',
      `question: ${inquiry.frontier.question}`,
      `changes-next-action-when: ${inquiry.frontier.changesActionWhen}`,
      `evidence-needed: ${inquiry.frontier.evidenceNeeded}`,
      '</decision-frontier>',
    )
  }
  for (const node of nodes) {
    const evidenceClass = node.evidenceClass === undefined ? '' : ` evidence-class="${node.evidenceClass}"`
    lines.push(`<inquiry-node id="${xmlAttribute(node.id)}" kind="${node.kind}" status="${node.status}" origin="${node.origin}"${evidenceClass}>${node.text}</inquiry-node>`)
  }
  const selectedIds = new Set(nodes.map(node => node.id))
  for (const edge of inquiry.edges) {
    if (!edge.modelVisible || !selectedIds.has(edge.fromId) || !selectedIds.has(edge.toId)) continue
    const label = edge.label === undefined ? '' : ` label="${xmlAttribute(edge.label)}"`
    lines.push(`<inquiry-edge from="${xmlAttribute(edge.fromId)}" to="${xmlAttribute(edge.toId)}" relation="${edge.relation}"${label} />`)
  }
  const support = evaluateResearchEvidenceSupport(inquiry)
  if (support.status !== 'untracked') {
    lines.push(`<idea-support status="${support.status}" leads="${support.candidateCount}" challenged="${support.challengedCount}" total="${support.requirements.length}" closure="not-assessed" />`)
  }
  const leap = inquiry.leap
  if (leap?.status === 'pending') {
    lines.push(
      `<leap-pending kind="idea-discussion" id="${xmlAttribute(leap.id)}" trigger="${leap.trigger}">`,
      `discussion-question: ${leap.question}`,
      `blocked-action-only: ${leap.blockedAction}`,
      ...leap.evidenceFrontierActions.map(action => `autonomous-evidence-frontier: ${action}`),
      'priority-rule: advance decision-changing scientific evidence; safety is an admission condition, not the objective.',
      'review-rule: after a new result, run one bounded review only if it changes a hypothesis, the Decision Frontier, an Idea-support requirement, or exposes a shared-route failure.',
      'idea-rule: sufficient evidence may create provisional questions, hypotheses, rivals, and experiments without a leap; changing the Seed or a confirmed boundary still requires the human.',
      'continuation-rule: block only the named action. Continue informative reversible work; if none remains, park with the missing evidence instead of manufacturing activity.',
      '</leap-pending>',
    )
  }
  lines.push('</idea-lens>')
  return lines.join('\n')
}

function indexTerm(index: SessionIndex, term: string, turn: number): void {
  const postings = index.termPostings.get(term) ?? new Set<number>()
  postings.add(turn)
  index.termPostings.set(term, postings)
  if (index.termGrams.has(term)) return
  const grams = ngrams(term)
  index.termGrams.set(term, grams)
  for (const gram of grams) {
    const terms = index.gramTerms.get(gram) ?? new Set<string>()
    terms.add(term)
    index.gramTerms.set(gram, terms)
  }
}

/** Resolve bounded fuzzy vocabulary matches without scanning every term pair. */
function fuzzyMatches(index: SessionIndex, query: ReadonlySet<string>): ReadonlyMap<string, number> {
  const started = performance.now()
  const matches = new Map<string, number>()
  for (const queryTerm of query) {
    const queryGrams = ngrams(queryTerm)
    if (queryGrams.size === 0) continue
    const shared = new Map<string, number>()
    for (const gram of queryGrams) {
      const candidates = index.gramTerms.get(gram)
      if (candidates === undefined || candidates.size > MAX_GRAM_BUCKET_TERMS) continue
      for (const candidate of candidates) {
        if (candidate === queryTerm) continue
        shared.set(candidate, (shared.get(candidate) ?? 0) + 1)
      }
    }
    const candidates = [...shared]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, MAX_FUZZY_CANDIDATES_PER_TERM)
    for (const [candidate, count] of candidates) {
      const candidateGrams = index.termGrams.get(candidate)
      if (candidateGrams === undefined) continue
      const score = 2 * count / (queryGrams.size + candidateGrams.size)
      if (score >= 0.58 && score > (matches.get(candidate) ?? 0)) matches.set(candidate, score)
    }
    if (performance.now() - started >= FUZZY_BUDGET_MS) break
  }
  return matches
}

function addPostingTurns(target: Set<number>, index: SessionIndex, terms: Iterable<string>): void {
  for (const term of terms) {
    for (const turn of index.termPostings.get(term) ?? []) target.add(turn)
  }
}

function turnRanges(turns: readonly number[]): string {
  if (turns.length === 0) return ''
  const ranges: string[] = []
  const first = turns[0]
  if (first === undefined) return ''
  let start = first
  let end = start
  for (const turn of turns.slice(1)) {
    if (turn === end + 1) {
      end = turn
      continue
    }
    ranges.push(start === end ? `${start}` : `${start}-${end}`)
    start = turn
    end = turn
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`)
  return ranges.join(',')
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function xmlAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function normalizedText(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must not be blank`)
  return value.trim()
}

function safeInteger(value: number, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${label} must be a safe integer >= ${minimum}`)
  return value
}

function uniqueText(values: readonly string[], label: string, limit = 32): string[] {
  const result = [...new Set(values.map(value => normalizedText(value, label)))]
  if (result.length > limit) throw new TypeError(`${label} accepts at most ${limit} values`)
  return result
}

function boundedInquiryGraph(
  nodes: readonly ResearchInquiryNode[],
  edges: readonly ResearchInquiryEdge[],
  inquiry: {
    readonly frontier: ResearchInquiryState['frontier']
    readonly leap: ResearchInquiryState['leap']
  },
  maximum: number,
): { readonly nodes: ResearchInquiryNode[]; readonly edges: ResearchInquiryEdge[] } {
  const protectedIds = new Set([
    ...nodes.filter(node => node.origin === 'human').map(node => node.id),
    ...edges.filter(edge => edge.origin === 'human').flatMap(edge => [edge.fromId, edge.toId]),
    ...(inquiry.frontier?.nodeIds ?? []),
    ...(inquiry.leap?.status === 'pending' ? inquiry.leap.evidenceNodeIds : []),
  ])
  const removable = nodes.length <= maximum ? [] : nodes
    .filter(node => node.origin === 'model' && !protectedIds.has(node.id))
    .sort((left, right) => {
      const leftRetired = left.status === 'retired' || left.status === 'rejected' ? 0 : 1
      const rightRetired = right.status === 'retired' || right.status === 'rejected' ? 0 : 1
      return leftRetired - rightRetired || left.updatedAt - right.updatedAt
    })
  const remove = new Set(removable.slice(0, Math.max(0, nodes.length - maximum)).map(node => node.id))
  const kept = nodes.filter(node => !remove.has(node.id))
  if (kept.length > maximum) {
    throw new TypeError(`Inquiry Map has ${kept.length} protected nodes, above the ${maximum}-node current-state limit`)
  }
  const keptIds = new Set(kept.map(node => node.id))
  const validEdges = edges.filter(edge => keptIds.has(edge.fromId) && keptIds.has(edge.toId))
  const edgeLimit = maximum * 3
  const humanEdges = validEdges.filter(edge => edge.origin === 'human')
  if (humanEdges.length > edgeLimit) throw new TypeError(`Inquiry Map has more than ${edgeLimit} human edges`)
  const modelEdges = validEdges.filter(edge => edge.origin === 'model')
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, edgeLimit - humanEdges.length)
  return { nodes: kept, edges: [...humanEdges, ...modelEdges] }
}

function resolveConfig(config: ResearchContextConfig): Readonly<ResolvedResearchContextConfig> {
  const kernel = normalizedText(config.kernel, 'research-context: kernel')
  const frame = config.frame?.trim()
  const resolved = {
    ...config,
    kernel,
    maxViewChars: safeInteger(config.maxViewChars, 'maxViewChars', 1),
    maxViewTokens: safeInteger(config.maxViewTokens ?? 48_000, 'maxViewTokens', 1),
    maxKernelTokens: safeInteger(config.maxKernelTokens ?? 512, 'maxKernelTokens', 1),
    fallbackAuthorityTokens: safeInteger(config.fallbackAuthorityTokens ?? 4_096, 'fallbackAuthorityTokens', 1),
    recentTurns: safeInteger(config.recentTurns, 'recentTurns', 0),
    maxEvidenceTurns: safeInteger(config.maxEvidenceTurns, 'maxEvidenceTurns', 0),
    maxInquiryNodes: safeInteger(config.maxInquiryNodes ?? 64, 'maxInquiryNodes', 8),
    retrievalAliases: Object.fromEntries(Object.entries(config.retrievalAliases ?? {}).map(([key, values]) => [
      key.normalize('NFKC').toLowerCase(),
      [...new Set(values.map(value => value.normalize('NFKC').toLowerCase()).filter(Boolean))],
    ])),
    ...(frame === undefined || frame.length === 0 ? {} : { frame }),
  }
  if (kernel.length + (frame?.length ?? 0) >= resolved.maxViewChars) {
    throw new TypeError('research-context: initial kernel and frame must fit below maxViewChars')
  }
  return Object.freeze(resolved)
}

function normalizeResearchState(input: ResearchStateProjection): ResearchStateProjection {
  const authority = (value: ResearchAuthorityValue): ResearchAuthorityValue => ({
    version: value.version,
    text: value.text,
    confirmedAt: value.confirmedAt,
    ...(value.evolution === undefined ? {} : { evolution: { ...value.evolution } }),
  })

  const kernel = authority(input.kernel)
  const frame = input.frame === undefined ? undefined : authority(input.frame)
  const proposal = input.proposal === undefined ? undefined : {
    id: input.proposal.id,
    target: input.proposal.target,
    baseVersion: typeof input.proposal.baseVersion === 'number'
      ? input.proposal.baseVersion
      : (input.proposal.target === 'kernel' ? kernel.version : frame?.version ?? null),
    text: input.proposal.text,
    proposedAt: input.proposal.proposedAt,
    ...(input.proposal.evolution === undefined ? {} : { evolution: { ...input.proposal.evolution } }),
  }
  const inquiry = input.inquiry === undefined ? undefined : structuredClone(input.inquiry)
  return {
    revision: input.revision,
    kernel,
    ...(frame === undefined ? {} : { frame }),
    ...(input.working === undefined ? {} : { working: structuredClone(input.working) }),
    ...(inquiry === undefined ? {} : { inquiry }),
    ...(proposal === undefined ? {} : { proposal }),
    updatedAt: input.updatedAt,
  }
}

function foldState(events: readonly SessionEvent[]): { state: ResearchStateProjection; seq: number } | undefined {
  let current: { state: ResearchStateProjection; seq: number } | undefined
  for (const event of events) {
    if (event.type !== 'research/state-change') continue
    const change = event.data as ResearchStateChange
    current = { state: normalizeResearchState(change.state), seq: event.seq }
  }
  return current
}

function lastContextWindow(session: Session): number | undefined {
  for (let offset = session.events.length - 1; offset >= 0; offset -= 1) {
    const event = session.events[offset]
    if (event === undefined) continue
    if (event.type !== 'request/context') continue
    const value = event.data.contextWindow
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  }
  return undefined
}

function currentTurn(session: Session): number | null {
  for (let offset = session.events.length - 1; offset >= 0; offset -= 1) {
    const event = session.events[offset]
    if (event === undefined) continue
    if (event.type === 'turn/end') return null
    if (event.type === 'turn/start') return event.data.turn
  }
  return null
}

function latestEventSeq(session: Session, type: string): number | undefined {
  for (let offset = session.events.length - 1; offset >= 0; offset -= 1) {
    const event = session.events[offset]
    if (event === undefined) continue
    if (event.type === type) return event.seq
  }
  return undefined
}

function latestIdeaSelection(session: Session): ResearchIdeaSelection | undefined {
  for (let offset = session.events.length - 1; offset >= 0; offset -= 1) {
    const event = session.events[offset]
    if (event === undefined) continue
    if (event.type === 'research/idea-selection') return event.data
  }
  return undefined
}

function sameIdeas(left: readonly ResearchIdeaSummary[], right: readonly ResearchIdeaSummary[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Event-sourced authority plus a disposable incremental retrieval index. */
export class ResearchContextAssembler extends Service {
  static inject = ['tokenMeter']
  static Config = Config

  /** Validated immutable deployment defaults and selection limits. */
  readonly config: Readonly<ResolvedResearchContextConfig>
  private readonly indexes = new WeakMap<Session, SessionIndex>()
  private readonly retrievers = new Map<string, ResearchRetrievalProvider>()
  private readonly failedRetrievers = new Set<string>()
  private readonly prewarming = new WeakSet<Session>()
  private authorityProvider: ResearchAuthorityProvider | undefined
  private legacyStateProvider: ResearchLegacyStateProvider | undefined

  /**
   * Register one configured research-context service.
   * @param ctx - Cordis owner context.
   * @param config - initial authority and selection limits.
   */
  constructor(ctx: Context, config: ResearchContextConfig) {
    super(ctx, 'researchContext')
    this.config = resolveConfig(config)
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register<'researchContextEnabled', boolean>({
        key: 'researchContextEnabled',
        schema: zod.boolean(),
        init: () => true,
        apply: (state, event) => event.type === 'research/context-control' ? event.data.enabled : state,
        view: state => state,
        stateVersion: 1,
      })
      projectionCtx.sessionProjections.register<'researchIdeas', readonly ResearchIdeaSummary[]>({
        key: 'researchIdeas',
        schema: zod.array(researchIdeaSummarySchema) as ZodType<readonly ResearchIdeaSummary[]>,
        init: () => [],
        apply: (state, event) => event.type === 'research/idea-selection' ? event.data.ideas : state,
        view: state => state,
        stateVersion: 1,
      })
      projectionCtx.sessionProjections.register<'researchIdeaId', string | null>({
        key: 'researchIdeaId',
        schema: zod.string().nullable(),
        init: () => null,
        apply: (state, event) => event.type === 'research/idea-selection' ? event.data.ideaId : state,
        view: state => state,
        stateVersion: 1,
      })
      projectionCtx.sessionProjections.register<'researchState', ResearchStateProjection | null>({
        key: 'researchState',
        schema: researchStateSchema.nullable() as ZodType<ResearchStateProjection | null>,
        init: () => null,
        apply: (state, event) => event.type === 'research/state-change'
          ? normalizeResearchState(event.data.state)
          : state,
        view: state => state,
        stateVersion: 2,
      })
      projectionCtx.sessionProjections.register<'researchContext', ResearchContextProjection | null>({
        key: 'researchContext',
        schema: researchContextSchema.nullable() as ZodType<ResearchContextProjection | null>,
        init: () => null,
        apply: (state, event) => event.type === 'research/context-assembly' ? event.data.manifest : state,
        view: state => state,
        stateVersion: 3,
      })
      projectionCtx.sessionProjections.register<'researchContextInheritance', ResearchContextInheritanceProjection | null>({
        key: 'researchContextInheritance',
        schema: researchContextInheritanceSchema.nullable() as ZodType<ResearchContextInheritanceProjection | null>,
        init: () => null,
        apply: (state, event) => event.type === 'research/context-inheritance' ? event.data.manifest : state,
        view: state => state,
        stateVersion: 2,
      })
      projectionCtx.sessionProjections.register<'researchContextHistory', readonly ResearchContextHistoryItem[]>({
        key: 'researchContextHistory',
        schema: researchContextHistorySchema as ZodType<readonly ResearchContextHistoryItem[]>,
        init: () => [],
        apply: (state, event) => {
          let item: ResearchContextHistoryItem | undefined
          if (event.type === 'research/context-assembly') {
            const manifest = event.data.manifest
            item = {
              kind: 'assembly', eventSeq: event.seq, time: event.time,
              estimatedTokens: manifest.estimatedTokens, assemblyMicros: manifest.assemblyMicros,
              selectedCount: manifest.selectedTurns.length, omittedCount: manifest.omittedTurnCount,
              focusMode: manifest.focusMode ?? 'task',
              ...(manifest.ideaLens === undefined ? {} : { ideaLens: manifest.ideaLens }),
            }
          } else if (event.type === 'research/context-inheritance') {
            const manifest = event.data.manifest
            item = {
              kind: 'inheritance', eventSeq: event.seq, time: event.time,
              estimatedTokens: manifest.estimatedTokens, assemblyMicros: manifest.assemblyMicros,
              selectedCount: manifest.parentSelectedTurns.length + manifest.workerSelectedTurns.length,
              omittedCount: manifest.workerOmittedTurns.length,
              focusMode: manifest.focusMode ?? 'task',
            }
          }
          return item === undefined ? state : [...state, item].slice(-32)
        },
        view: state => state,
        stateVersion: 2,
      })
      projectionCtx.sessionProjections.register<'researchEvidenceCandidates', readonly ResearchEvidenceCandidate[]>({
        key: 'researchEvidenceCandidates',
        schema: zod.array(evidenceCandidateSchema) as ZodType<readonly ResearchEvidenceCandidate[]>,
        init: () => [],
        apply: (state, event) => {
          if (event.type === 'research/handoff-imported') {
            const candidate: ResearchEvidenceCandidate = {
              id: event.data.handoff.id,
              sourceSessionId: event.data.handoff.sourceSessionId,
              sourceMessageSeq: event.seq,
              sourceKind: 'handoff',
              text: event.data.handoff.text,
              createdAt: event.data.handoff.importedAt,
            }
            return [...state, candidate].slice(-32)
          }
          if (event.type !== 'user/message') return state
          const source = event.data.source as { readonly kind: string; readonly senderSessionId?: unknown }
          if ((source.kind !== 'subagent-report' && source.kind !== 'subagent-settled')
            || source.senderSessionId === undefined) return state
          const text = messageText(event.data)
          if (text.length === 0) return state
          const candidate: ResearchEvidenceCandidate = {
            id: `research-evidence-seq-${event.seq}`,
            sourceSessionId: String(source.senderSessionId),
            sourceMessageSeq: event.seq,
            sourceKind: source.kind === 'subagent-report' ? 'report' : 'settlement',
            text,
            createdAt: event.time,
          }
          return [...state, candidate].slice(-32)
        },
        view: state => state,
        stateVersion: 1,
      })
      projectionCtx.sessionProjections.register<'researchHandoffs', readonly ResearchHandoffCandidate[]>({
        key: 'researchHandoffs',
        schema: zod.array(handoffCandidateSchema) as ZodType<readonly ResearchHandoffCandidate[]>,
        init: () => [],
        apply: (state, event) => event.type === 'research/handoff-imported'
          ? [...state, { ...event.data.handoff, importEventSeq: event.seq }].slice(-16)
          : state,
        view: state => state,
        stateVersion: 1,
      })
    })

    // Build locator indexes outside the model-request path whenever a Session
    // becomes live or its append-only tail grows. Cold requests can still
    // finish any remainder synchronously, preserving complete recall.
    ctx.inject(['sessions'], (sessionCtx) => {
      const schedule = (session: Session): void => {
        this.schedulePrewarm(session, () => sessionCtx.fiber.state === FiberState.ACTIVE)
      }
      for (const session of sessionCtx.sessions.list()) schedule(session)
      sessionCtx.on('session/created', schedule, { global: true })
      sessionCtx.on('session/event', schedule, { global: true })
    })
  }

  /**
   * Register a hot-path scorer. Providers must be synchronous and return immediately.
   * @param provider - uniquely named retrieval provider.
   * @returns a disposer that unregisters the provider.
   */
  registerRetrievalProvider(provider: ResearchRetrievalProvider): () => void {
    if (provider.id.length === 0 || this.retrievers.has(provider.id)) {
      throw new TypeError(`research retrieval provider already registered: ${provider.id}`)
    }
    this.failedRetrievers.delete(provider.id)
    this.retrievers.set(provider.id, provider)
    return () => {
      this.retrievers.delete(provider.id)
      this.failedRetrievers.delete(provider.id)
    }
  }

  /**
   * Install the single project-scoped authority owner for this composition.
   * @param provider - provider that owns project-state persistence and revision checks.
   * @returns a disposer that releases the provider when it is still current.
   */
  registerAuthorityProvider(provider: ResearchAuthorityProvider): () => void {
    if (provider.id.length === 0 || this.authorityProvider !== undefined) {
      throw new TypeError(`research authority provider already registered: ${provider.id}`)
    }
    this.authorityProvider = provider
    return () => {
      if (this.authorityProvider === provider) this.authorityProvider = undefined
    }
  }

  /**
   * Install one read-only source for cloning old Workspace Ideas into empty Sessions.
   * The provider is never consulted after a Session owns a research/state-change event.
   */
  registerLegacyStateProvider(provider: ResearchLegacyStateProvider): () => void {
    if (provider.id.length === 0 || this.legacyStateProvider !== undefined) {
      throw new TypeError(`research legacy-state provider already registered: ${provider.id}`)
    }
    this.legacyStateProvider = provider
    return () => {
      if (this.legacyStateProvider === provider) this.legacyStateProvider = undefined
    }
  }

  /**
   * Return whether this Session should include Idea context in model requests.
   * @param session - durable source session.
   * @returns whether the Session includes Idea context in model requests.
   */
  isEnabled(session: Session): boolean {
    for (let offset = session.events.length - 1; offset >= 0; offset -= 1) {
      const event = session.events[offset]
      if (event === undefined) continue
      if (event.type === 'research/context-control') return event.data.enabled
    }
    return true
  }

  /**
   * Persist a per-Session Idea switch; repeated writes are no-ops.
   * @param session - durable source session.
   * @param enabled - whether to include Idea context in future model requests.
   * @returns the resulting enabled value.
   */
  setEnabled(session: Session, enabled: boolean): boolean {
    if (this.isEnabled(session) === enabled) return enabled
    session.append('research/context-control', { version: 1, enabled })
    return enabled
  }

  /** Return the selected Idea id, or null when this Session is closed to Idea context. */
  ideaId(session: Session): string | null {
    return latestIdeaSelection(session)?.ideaId ?? null
  }

  /** Return the last non-null Idea id for reopening a closed Session. */
  lastIdeaId(session: Session): string | null {
    for (let offset = session.events.length - 1; offset >= 0; offset -= 1) {
      const event = session.events[offset]
      if (event === undefined) continue
      if (event.type !== 'research/idea-selection' || event.data.ideaId === null) continue
      return event.data.ideaId
    }
    return null
  }

  /** Return the current Workspace Idea catalog visible to this Session. */
  listIdeas(session: Session): readonly ResearchIdeaSummary[] {
    const providerIdeas = this.authorityProvider?.list?.(session)
    return structuredClone(providerIdeas ?? latestIdeaSelection(session)?.ideas ?? [])
  }

  /** Select one Workspace Idea for a Session, or close Idea assembly with null. */
  async selectIdea(session: Session, ideaId: string | null): Promise<readonly ResearchIdeaSummary[]> {
    const ideas = this.listIdeas(session)
    if (ideaId !== null && !ideas.some(idea => idea.ideaId === ideaId)) {
      throw new TypeError('research Idea not found: ' + ideaId)
    }
    const current = latestIdeaSelection(session)
    if (current === undefined || current.ideaId !== ideaId || !sameIdeas(current.ideas, ideas)) {
      this.appendIdeaSelection(session, ideaId, ideas)
    }
    this.setEnabled(session, ideaId !== null)
    return structuredClone(ideas)
  }

  /** Create and select one additional Workspace Idea. */
  async createIdea(session: Session, title: string): Promise<ResearchIdeaSummary> {
    const normalized = title.trim()
    if (normalized.length === 0) throw new TypeError('research Idea title must not be empty')
    const provider = this.authorityProvider
    const create = provider?.create
    if (provider === undefined || create === undefined) throw new Error('multiple research Ideas require a Workspace authority provider')
    const idea = await create.call(provider, session, normalized, this.initialState())
    await this.selectIdea(session, idea.ideaId)
    return structuredClone(idea)
  }

  /**
   * Read or initialize the session's confirmed research state.
   * @param session - Durable source session.
   * @returns A detached copy of the current whole state.
   */
  state(session: Session): ResearchStateProjection {
    const folded = foldState(session.events)
    if (folded !== undefined) return structuredClone(folded.state)
    const legacy = this.legacyStateProvider?.read(session)
    if (legacy !== undefined) {
      this.appendState(session, 'migrate-session-idea', legacy)
      return structuredClone(legacy)
    }
    const project = this.authorityProvider?.read(session)
    if (project !== undefined) {
      this.mirrorProjectState(session, project)
      this.syncIdeaSelection(session)
      return structuredClone(project)
    }
    const state = this.initialState()
    this.appendState(session, 'initialize', state)
    return structuredClone(state)
  }

  /**
   * Ensure a project-owned authority record exists before a request or mutation.
   * @param session - session whose Workspace selects the authority record.
   * @returns a detached copy of the initialized current state.
   */
  async stateForRequest(session: Session): Promise<ResearchStateProjection> {
    const folded = foldState(session.events)
    if (folded !== undefined) return structuredClone(folded.state)
    const legacy = this.legacyStateProvider?.read(session)
    if (legacy !== undefined) {
      this.appendState(session, 'migrate-session-idea', legacy)
      return structuredClone(legacy)
    }
    const provider = this.authorityProvider
    if (provider === undefined) return this.state(session)
    let project = provider.read(session)
    if (project === undefined) {
      const legacy = foldState(session.events)?.state
      project = await provider.initialize(session, legacy ?? this.initialState())
    }
    this.mirrorProjectState(session, project)
    this.syncIdeaSelection(session)
    return structuredClone(project)
  }

  /** Replace the active per-Session Idea layer after clear feedback or a resolved discussion. */
  async updateAuthority(
    session: Session,
    expectedRevision: number,
    target: ResearchAuthorityProposal['target'],
    text: string,
    evolution?: ResearchAuthorityEvolution,
  ): Promise<ResearchStateProjection> {
    const current = await this.expectRevision(session, expectedRevision)
    if (current.inquiry?.leap?.status === 'pending') {
      throw new TypeError(`resolve pending Idea discussion before updating Idea: ${current.inquiry.leap.id}`)
    }
    const candidate = normalizedText(text, `research ${target}`)
    const previous = target === 'kernel' ? current.kernel : current.frame
    if (previous?.text === candidate) return structuredClone(current)
    const value: ResearchAuthorityValue = {
      version: (previous?.version ?? 0) + 1,
      text: candidate,
      confirmedAt: Date.now(),
      ...(evolution === undefined ? {} : {
        evolution: {
          scope: evolution.scope,
          basis: normalizedText(evolution.basis, 'research authority evolution basis'),
        },
      }),
    }
    return await this.commit(
      session,
      current,
      'update-authority',
      target === 'kernel' ? { kernel: value } : { frame: value },
      true,
    )
  }

  private initialState(): ResearchStateProjection {
    const now = Date.now()
    const kernel: ResearchAuthorityValue = {
      version: 1,
      text: this.config.kernel,
      confirmedAt: now,
    }
    const frame = this.config.frame === undefined ? undefined : {
      version: 1,
      text: this.config.frame,
      confirmedAt: now,
    }
    return {
      revision: 1,
      kernel,
      ...(frame === undefined ? {} : { frame }),
      updatedAt: now,
    }
  }

  /**
   * Create one unconfirmed Kernel or Frame replacement.
   * @param session - Durable source session.
   * @param expectedRevision - Exact current state revision.
   * @param target - Authority layer to replace if later confirmed.
   * @param text - Complete candidate value.
   * @returns The new state containing a pending proposal.
   */
  async proposeAuthority(
    session: Session,
    expectedRevision: number,
    target: ResearchAuthorityProposal['target'],
    text: string,
    evolution?: ResearchAuthorityEvolution,
  ): Promise<ResearchStateProjection> {
    const current = await this.expectRevision(session, expectedRevision)
    if (current.proposal !== undefined) {
      throw new TypeError(`research authority proposal already pending: ${current.proposal.id}`)
    }
    const candidate = normalizedText(text, `research ${target} proposal`)
    const base = target === 'kernel' ? current.kernel : current.frame
    const proposal: ResearchAuthorityProposal = {
      id: `research-proposal-${randomUUID()}`,
      target,
      baseVersion: base?.version ?? null,
      text: candidate,
      proposedAt: Date.now(),
      ...(evolution === undefined ? {} : {
        evolution: {
          scope: evolution.scope,
          basis: normalizedText(evolution.basis, 'research authority evolution basis'),
        },
      }),
    }
    return await this.commit(session, current, 'propose-authority', { proposal })
  }

  /**
   * Confirm the exact pending authority proposal.
   * @param session - Durable source session.
   * @param proposalId - Exact current proposal identity.
   * @returns The new state with the authority value committed.
   */
  async confirmAuthority(session: Session, proposalId: string): Promise<ResearchStateProjection> {
    const current = await this.stateForRequest(session)
    const proposal = current.proposal
    if (proposal === undefined || proposal.id !== proposalId) throw new TypeError('research proposal is not current')
    const now = Date.now()
    const previous = proposal.target === 'kernel' ? current.kernel : current.frame
    if ((previous?.version ?? null) !== proposal.baseVersion) throw new TypeError('research proposal base is stale')
    const value: ResearchAuthorityValue = {
      version: (previous?.version ?? 0) + 1,
      text: proposal.text,
      confirmedAt: now,
      ...(proposal.evolution === undefined ? {} : { evolution: { ...proposal.evolution } }),
    }
    return await this.commit(
      session,
      current,
      'confirm-authority',
      proposal.target === 'kernel' ? { kernel: value } : { frame: value },
      true,
    )
  }

  /**
   * Reject the exact pending authority proposal without changing authority.
   * @param session - Durable source session.
   * @param proposalId - Exact current proposal identity.
   * @returns The new state with no pending proposal.
   */
  async rejectAuthority(session: Session, proposalId: string): Promise<ResearchStateProjection> {
    const current = await this.stateForRequest(session)
    if (current.proposal?.id !== proposalId) throw new TypeError('research proposal is not current')
    return await this.commit(session, current, 'reject-authority', {}, true)
  }

  /**
   * Replace model-maintained execution state without changing Kernel or Frame.
   * @param session - Durable source session.
   * @param expectedRevision - Exact current state revision.
   * @param input - Complete replacement Working State.
   * @returns The new state containing the replacement Working State.
   */
  async updateWorking(
    session: Session,
    expectedRevision: number,
    input: WorkingStateInput,
  ): Promise<ResearchStateProjection> {
    const current = await this.expectRevision(session, expectedRevision)
    const currentTask = normalizedText(input.currentTask, 'working currentTask')
    const unresolved = [...new Set(input.unresolved.map(value => value.trim()).filter(Boolean))]
    const evidenceRoots = [...new Set(input.evidenceRoots.map(value => safeInteger(value, 'evidence root', 0)))].sort((a, b) => a - b)
    const nextAction = input.nextAction.trim()
    const previous = current.working
    if (previous !== undefined
      && previous.currentTask === currentTask
      && previous.nextAction === nextAction
      && previous.unresolved.length === unresolved.length
      && previous.unresolved.every((value, index) => value === unresolved[index])
      && previous.evidenceRoots.length === evidenceRoots.length
      && previous.evidenceRoots.every((value, index) => value === evidenceRoots[index])) {
      return structuredClone(current)
    }
    const working: ResearchWorkingState = {
      revision: (current.working?.revision ?? 0) + 1,
      currentTask,
      unresolved,
      nextAction,
      evidenceRoots,
      updatedAt: Date.now(),
    }
    return await this.commit(session, current, 'update-working', { working })
  }

  /**
   * Merge model-owned provisional rationale and optionally replace the single Decision Frontier.
   * Human-origin nodes remain immutable; append contrary evidence instead.
   */
  async updateInquiry(
    session: Session,
    expectedRevision: number,
    input: InquiryUpdateInput,
  ): Promise<ResearchStateProjection> {
    const current = await this.expectRevision(session, expectedRevision)
    if (input.nodes.length > 16) throw new TypeError('one inquiry update accepts at most 16 node upserts')
    const now = Date.now()
    const previous = current.inquiry
    const byId = new Map((previous?.nodes ?? []).map(node => [node.id, node] as const))
    const edgeById = new Map((previous?.edges ?? []).map(edge => [edge.id, edge] as const))
    const pendingInputs = input.nodes.map(node => ({ ...node, id: node.id?.trim() || `inquiry-${randomUUID()}` }))
    const knownIds = new Set([...byId.keys(), ...pendingInputs.map(node => node.id)])
    for (const inputNode of pendingInputs) {
      const existing = byId.get(inputNode.id)
      if (existing?.origin === 'human') throw new TypeError(`human inquiry node is immutable: ${inputNode.id}`)
      const sourceSeqs = [...new Set((inputNode.sourceSeqs ?? existing?.sourceSeqs ?? [])
        .map(value => safeInteger(value, 'inquiry source seq', 0)))].sort((left, right) => left - right)
      const unknownSeq = sourceSeqs.find(seq => !session.events.some(event => event.seq === seq))
      if (unknownSeq !== undefined) throw new TypeError(`unknown inquiry source event seq: ${unknownSeq}`)
      if (inputNode.evidenceClass !== undefined && inputNode.kind !== 'evidence-requirement') {
        throw new TypeError('evidenceClass is only valid for evidence-requirement nodes')
      }
      const evidenceClass = inputNode.evidenceClass ?? existing?.evidenceClass
      const node: ResearchInquiryNode = {
        id: inputNode.id,
        kind: inputNode.kind,
        text: normalizedText(inputNode.text, 'inquiry node text'),
        status: inputNode.status ?? existing?.status ?? 'active',
        origin: 'model',
        modelVisible: inputNode.modelVisible ?? existing?.modelVisible ?? true,
        sourceSeqs,
        ...(evidenceClass === undefined ? {} : { evidenceClass }),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      byId.set(node.id, node)
    }
    const pendingEdges = input.edges ?? []
    if (pendingEdges.length > 24) throw new TypeError('one inquiry update accepts at most 24 edge upserts')
    for (const inputEdge of pendingEdges) {
      const id = inputEdge.id?.trim() || `inquiry-edge-${randomUUID()}`
      const existing = edgeById.get(id)
      if (existing?.origin === 'human') throw new TypeError(`human inquiry edge is immutable: ${id}`)
      const fromId = normalizedText(inputEdge.fromId, 'inquiry edge fromId')
      const toId = normalizedText(inputEdge.toId, 'inquiry edge toId')
      if (!knownIds.has(fromId) || !knownIds.has(toId)) throw new TypeError(`inquiry edge references an unknown node: ${fromId} -> ${toId}`)
      if (fromId === toId) throw new TypeError('inquiry edge endpoints must differ')
      const label = inputEdge.label?.trim()
      const edge: ResearchInquiryEdge = {
        id,
        fromId,
        toId,
        relation: inputEdge.relation,
        ...(label === undefined || label.length === 0 ? {} : { label }),
        origin: 'model',
        modelVisible: inputEdge.modelVisible ?? existing?.modelVisible ?? true,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      edgeById.set(id, edge)
    }
    const frontier = input.frontier === undefined
      ? previous?.frontier
      : input.frontier === null
        ? undefined
        : {
          question: normalizedText(input.frontier.question, 'frontier question'),
          changesActionWhen: normalizedText(input.frontier.changesActionWhen, 'frontier action condition'),
          evidenceNeeded: normalizedText(input.frontier.evidenceNeeded, 'frontier evidence'),
          nodeIds: uniqueText(input.frontier.nodeIds ?? [], 'frontier node id'),
          updatedAt: now,
        }
    const unknownFrontierNode = frontier?.nodeIds.find(id => !byId.has(id))
    if (unknownFrontierNode !== undefined) throw new TypeError(`unknown frontier node id: ${unknownFrontierNode}`)
    const draft = { frontier, leap: previous?.leap }
    const graph = boundedInquiryGraph([...byId.values()], [...edgeById.values()], draft, this.config.maxInquiryNodes)
    const inquiry: ResearchInquiryState = {
      revision: (previous?.revision ?? 0) + 1,
      nodes: graph.nodes,
      edges: graph.edges,
      ...(frontier === undefined ? {} : { frontier }),
      ...(previous?.leap === undefined ? {} : { leap: previous.leap }),
      updatedAt: now,
    }
    return await this.commit(session, current, 'update-inquiry', { inquiry })
  }

  /** Raise one human-owned mechanism leap without blocking safe evidence work. */
  async raiseLeap(
    session: Session,
    expectedRevision: number,
    input: LeapProposalInput,
  ): Promise<ResearchStateProjection> {
    const current = await this.expectRevision(session, expectedRevision)
    const previous = current.inquiry
    if (previous?.leap?.status === 'pending') throw new TypeError(`Idea discussion already pending: ${previous.leap.id}`)
    const candidates = uniqueText(input.candidates, 'leap candidate', 4)
    const evidenceFrontierActions = uniqueText(input.evidenceFrontierActions, 'leap evidence-frontier action', 8)
    const evidenceNodeIds = uniqueText(input.evidenceNodeIds ?? [], 'leap evidence node id')
    const unknown = evidenceNodeIds.find(id => previous?.nodes.some(node => node.id === id) !== true)
    if (unknown !== undefined) throw new TypeError(`unknown leap evidence node id: ${unknown}`)
    const now = Date.now()
    const leap: ResearchLeapProposal = {
      id: `research-leap-${randomUUID()}`,
      trigger: input.trigger,
      question: normalizedText(input.question, 'leap question'),
      whyHuman: normalizedText(input.whyHuman, 'leap human rationale'),
      candidates,
      blockedAction: normalizedText(input.blockedAction, 'leap blocked action'),
      evidenceFrontierActions,
      evidenceNodeIds,
      status: 'pending',
      proposedAt: now,
    }
    const inquiry: ResearchInquiryState = {
      revision: (previous?.revision ?? 0) + 1,
      nodes: [...(previous?.nodes ?? [])],
      edges: [...(previous?.edges ?? [])],
      ...(previous?.frontier === undefined ? {} : { frontier: previous.frontier }),
      leap,
      updatedAt: now,
    }
    return await this.commit(session, current, 'raise-leap', { inquiry })
  }

  /** Resolve the exact pending leap from a human command and record a human decision node. */
  async resolveLeap(
    session: Session,
    leapId: string,
    resolution:
      | { readonly kind: 'accept'; readonly candidateIndex: number }
      | { readonly kind: 'clarify'; readonly text: string }
      | { readonly kind: 'reject' },
  ): Promise<ResearchStateProjection> {
    const current = await this.stateForRequest(session)
    const previous = current.inquiry
    const leap = previous?.leap
    if (leap === undefined || leap.id !== leapId || leap.status !== 'pending') throw new TypeError('research leap is not current')
    const now = Date.now()
    let chosenCandidate: string | undefined
    if (resolution.kind === 'accept') {
      const index = safeInteger(resolution.candidateIndex, 'leap candidate index', 1) - 1
      chosenCandidate = leap.candidates[index]
      if (chosenCandidate === undefined) throw new TypeError('leap candidate index is out of range')
    } else if (resolution.kind === 'clarify') {
      chosenCandidate = normalizedText(resolution.text, 'Idea discussion resolution')
    }
    const decision: ResearchInquiryNode = {
      id: `inquiry-${randomUUID()}`,
      kind: resolution.kind === 'reject' ? 'rejection' : 'decision',
      text: resolution.kind === 'reject'
        ? `Human rejected the proposed leap: ${leap.question}`
        : `User clarification for “${leap.question}”: ${chosenCandidate}`,
      status: 'active',
      origin: 'human',
      modelVisible: true,
      sourceSeqs: [],
      createdAt: now,
      updatedAt: now,
    }
    const resolvedLeap: ResearchLeapProposal = {
      ...leap,
      status: resolution.kind === 'reject' ? 'rejected' : 'accepted',
      ...(chosenCandidate === undefined ? {} : { chosenCandidate }),
      resolvedAt: now,
    }
    const decisionEdges: ResearchInquiryEdge[] = leap.evidenceNodeIds.map(nodeId => ({
      id: `inquiry-edge-${randomUUID()}`,
      fromId: nodeId,
      toId: decision.id,
      relation: 'informs',
      origin: 'human',
      modelVisible: true,
      createdAt: now,
      updatedAt: now,
    }))
    const graph = boundedInquiryGraph([...(previous?.nodes ?? []), decision], [
      ...(previous?.edges ?? []), ...decisionEdges,
    ], {
      frontier: previous?.frontier, leap: resolvedLeap,
    }, this.config.maxInquiryNodes)
    const inquiry: ResearchInquiryState = {
      revision: (previous?.revision ?? 0) + 1,
      nodes: graph.nodes,
      edges: graph.edges,
      ...(previous?.frontier === undefined ? {} : { frontier: previous.frontier }),
      leap: resolvedLeap,
      updatedAt: now,
    }
    return await this.commit(session, current, 'resolve-leap', { inquiry })
  }

  /** Add or edit a human-owned evidence-board card. */
  async upsertHumanBoardNode(session: Session, input: HumanBoardNodeInput): Promise<ResearchStateProjection> {
    const current = await this.stateForRequest(session)
    const previous = current.inquiry
    const now = Date.now()
    const id = input.id?.trim() || `inquiry-${randomUUID()}`
    const existing = previous?.nodes.find(node => node.id === id)
    const node: ResearchInquiryNode = {
      id,
      kind: input.kind,
      text: normalizedText(input.text, 'board card text'),
      status: existing?.status ?? 'active',
      origin: 'human',
      modelVisible: input.modelVisible ?? existing?.modelVisible ?? false,
      sourceSeqs: [...(existing?.sourceSeqs ?? [])],
      ...(existing?.evidenceClass === undefined ? {} : { evidenceClass: existing.evidenceClass }),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    const nodes = [...(previous?.nodes ?? []).filter(value => value.id !== id), node]
    const graph = boundedInquiryGraph(nodes, previous?.edges ?? [], {
      frontier: previous?.frontier, leap: previous?.leap,
    }, this.config.maxInquiryNodes)
    const inquiry: ResearchInquiryState = {
      revision: (previous?.revision ?? 0) + 1,
      nodes: graph.nodes,
      edges: graph.edges,
      ...(previous?.frontier === undefined ? {} : { frontier: previous.frontier }),
      ...(previous?.leap === undefined ? {} : { leap: previous.leap }),
      updatedAt: now,
    }
    return await this.commit(session, current, 'edit-board', { inquiry })
  }

  /** Add or edit a human-owned semantic board connection. */
  async upsertHumanBoardEdge(session: Session, input: HumanBoardEdgeInput): Promise<ResearchStateProjection> {
    const current = await this.stateForRequest(session)
    const previous = current.inquiry
    const now = Date.now()
    const id = input.id?.trim() || `inquiry-edge-${randomUUID()}`
    const existing = previous?.edges.find(edge => edge.id === id)
    const fromId = normalizedText(input.fromId, 'board edge fromId')
    const toId = normalizedText(input.toId, 'board edge toId')
    if (fromId === toId) throw new TypeError('board edge endpoints must differ')
    const nodeIds = new Set((previous?.nodes ?? []).map(node => node.id))
    if (!nodeIds.has(fromId) || !nodeIds.has(toId)) throw new TypeError('board edge endpoints must reference existing cards')
    const label = input.label?.trim()
    const edge: ResearchInquiryEdge = {
      id,
      fromId,
      toId,
      relation: input.relation,
      ...(label === undefined || label.length === 0 ? {} : { label }),
      origin: 'human',
      modelVisible: input.modelVisible ?? existing?.modelVisible ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    const edges = [...(previous?.edges ?? []).filter(value => value.id !== id), edge]
    const graph = boundedInquiryGraph(previous?.nodes ?? [], edges, {
      frontier: previous?.frontier, leap: previous?.leap,
    }, this.config.maxInquiryNodes)
    const inquiry: ResearchInquiryState = {
      revision: (previous?.revision ?? 0) + 1,
      nodes: graph.nodes,
      edges: graph.edges,
      ...(previous?.frontier === undefined ? {} : { frontier: previous.frontier }),
      ...(previous?.leap === undefined ? {} : { leap: previous.leap }),
      updatedAt: now,
    }
    return await this.commit(session, current, 'edit-board', { inquiry })
  }

  /** Toggle whether one card or semantic edge may enter future Idea Lenses. */
  async setBoardVisibility(session: Session, id: string, modelVisible: boolean): Promise<ResearchStateProjection> {
    const current = await this.stateForRequest(session)
    const previous = current.inquiry
    if (previous === undefined) throw new TypeError('Inquiry Map is not initialized')
    const now = Date.now()
    let found = false
    const nodes = previous.nodes.map((node) => {
      if (node.id !== id) return node
      found = true
      return { ...node, modelVisible, updatedAt: now }
    })
    const edges = previous.edges.map((edge) => {
      if (edge.id !== id) return edge
      found = true
      return { ...edge, modelVisible, updatedAt: now }
    })
    if (!found) throw new TypeError(`unknown board item: ${id}`)
    const inquiry: ResearchInquiryState = {
      ...previous,
      revision: previous.revision + 1,
      nodes,
      edges,
      updatedAt: now,
    }
    return await this.commit(session, current, 'edit-board', { inquiry })
  }

  /**
   * Import one bounded cross-harness continuation bridge as non-authoritative evidence.
   * @param session - target session that records the evidence event.
   * @param input - bounded provenance and handoff text.
   * @returns the imported candidate with its durable event sequence.
   */
  importHandoff(session: Session, input: ResearchHandoffInput): ResearchHandoffCandidate {
    const sourceHarness = normalizedText(input.sourceHarness, 'handoff source harness')
    const sourceSessionId = normalizedText(input.sourceSessionId, 'handoff source session')
    const text = normalizedText(input.text, 'handoff text')
    if (text.length > 32_000) throw new TypeError('handoff text must not exceed 32000 characters')
    const anchors = [...new Set((input.anchors ?? []).map(value => normalizedText(value, 'handoff anchor')))]
    if (anchors.length > 16 || anchors.some(value => value.length > 512)) {
      throw new TypeError('handoff accepts at most 16 anchors of at most 512 characters each')
    }
    const projectPath = input.projectPath?.trim()
    const importedAt = input.createdAt ?? Date.now()
    if (!Number.isFinite(importedAt)) throw new TypeError('handoff createdAt must be finite')
    const handoff: Omit<ResearchHandoffCandidate, 'importEventSeq'> = {
      id: `research-handoff-${randomUUID()}`,
      sourceHarness,
      sourceSessionId,
      ...(projectPath === undefined || projectPath.length === 0 ? {} : { projectPath }),
      anchors,
      text,
      importedAt,
    }
    const event: ResearchHandoffImport = { version: 1, handoff }
    const appended = session.append('research/handoff-imported', event)
    return structuredClone({ ...handoff, importEventSeq: appended.seq })
  }

  /**
   * Append the latest assembly manifest for replay and UI projections.
   * @param session - Durable source session.
   * @param view - Completed model-visible assembly decision.
   * @returns The append-ready manifest value.
   */
  recordAssembly(session: Session, view: ResearchContextView): ResearchContextProjection {
    const manifest: ResearchContextProjection = {
      stateRevision: view.stateRevision,
      turn: currentTurn(session),
      selectedTurns: [...view.selectedTurns],
      selectedLocators: [...view.selectedLocators],
      partialTurns: [...view.partialTurns],
      omittedTurnCount: view.omittedTurns.length,
      sourceSeqs: [...view.sourceSeqs],
      estimatedTokens: view.estimatedTokens,
      assemblyMicros: view.assemblyMicros,
      components: { ...view.components },
      focusMode: view.focusMode,
      ideaLens: view.ideaLens,
      ...(view.goalId === undefined ? {} : { goalId: view.goalId }),
    }
    const event: ResearchContextAssembly = { version: 1, manifest }
    session.append('research/context-assembly', event)
    return manifest
  }

  /**
   * Persist the exact cross-session provenance of one child-worker request.
   * @param session - child session that records the inheritance event.
   * @param view - compiled worker view and its parent provenance.
   * @returns a detached copy of the persisted inheritance manifest.
   */
  recordInheritance(session: Session, view: ResearchWorkerContextView): ResearchContextInheritanceProjection {
    const event: ResearchContextInheritance = { version: 1, manifest: view.manifest }
    session.append('research/context-inheritance', event)
    return structuredClone(view.manifest)
  }

  /** Process one durable event into the mutable in-memory locator index. */
  private indexEvent(state: SessionIndex, event: SessionEvent): void {
    if (event.type === 'research/handoff-imported') {
      state.handoffs.push(Object.freeze({ ...event.data.handoff, importEventSeq: event.seq }))
      return
    }
    if (event.type === 'user/message' && !isDerivedPluginMessage(event)) {
      const text = messageText(event.data)
      if (text.length > 0) {
        state.directUserCount += 1
        state.latestDirectUser = Object.freeze({ seq: event.seq, text })
      }
    }
    if (event.type === 'turn/start') {
      state.active = { turn: event.data.turn, seqs: [], rows: [] }
      return
    }
    if (event.type === 'turn/end') {
      if (state.active?.turn === event.data.turn && state.active.rows.length > 0) {
        const text = state.active.rows.map(row => row.text).join('\n\n')
        const terms = new Set<string>()
        for (const row of state.active.rows) for (const term of row.terms) terms.add(term)
        const block = Object.freeze({
          turn: state.active.turn,
          seqs: Object.freeze([...state.active.seqs]),
          text,
          terms,
          rows: Object.freeze([...state.active.rows]),
        })
        state.blocks.push(block)
        for (const term of terms) indexTerm(state, term, block.turn)
      }
      state.active = undefined
      return
    }
    const row = eventRow(event)
    if (row !== undefined && state.active !== undefined) {
      state.active.rows.push(Object.freeze({ ...row, terms: termsOf(row.text) }))
      state.active.seqs.push(event.seq)
    }
  }

  /** Advance one session's loop index without model calls or durable cache writes. */
  private index(session: Session, maxEvents = Number.POSITIVE_INFINITY): SessionIndex {
    const state = this.indexes.get(session) ?? {
      indexedSeq: 0,
      blocks: [],
      handoffs: [],
      active: undefined,
      termPostings: new Map<string, Set<number>>(),
      termGrams: new Map<string, ReadonlySet<string>>(),
      gramTerms: new Map<string, Set<string>>(),
      directUserCount: 0,
      latestDirectUser: undefined,
    }
    const events = session.events
    const end = Math.min(events.length, state.indexedSeq + maxEvents)
    for (let offset = state.indexedSeq; offset < end; offset += 1) {
      const event = events[offset]
      if (event === undefined) continue
      this.indexEvent(state, event)
      state.indexedSeq = offset + 1
    }
    this.indexes.set(session, state)
    return state
  }

  /** Yield between bounded index batches so Session load and tool output never monopolize the host loop. */
  private schedulePrewarm(session: Session, active: () => boolean): void {
    if (this.prewarming.has(session)) return
    this.prewarming.add(session)
    const run = (): void => {
      if (!active()) {
        this.prewarming.delete(session)
        return
      }
      const state = this.index(session, PREWARM_EVENT_BATCH)
      if (state.indexedSeq < session.events.length) {
        setImmediate(run)
        return
      }
      this.prewarming.delete(session)
    }
    setImmediate(run)
  }

  private retrievalScore(
    query: ReadonlySet<string>,
    candidate: { readonly turn: number; readonly kind: 'loop' | LoopRowKind | 'handoff'; readonly text: string; readonly terms: ReadonlySet<string> },
    fuzzy: ReadonlyMap<string, number>,
  ): number {
    let bestFuzzy = 0
    for (const term of candidate.terms) bestFuzzy = Math.max(bestFuzzy, fuzzy.get(term) ?? 0)
    let score = overlap(query, candidate.terms) * 16 + bestFuzzy * 4
    for (const [term, aliases] of Object.entries(this.config.retrievalAliases ?? {})) {
      const queryHas = query.has(term) || aliases.some(alias => query.has(alias))
      if (!queryHas) continue
      if (candidate.terms.has(term) || aliases.some(alias => candidate.terms.has(alias))) score += 12
    }
    for (const provider of this.retrievers.values()) {
      if (this.failedRetrievers.has(provider.id)) continue
      try {
        const value = provider.score(query, candidate)
        if (Number.isFinite(value) && value > 0) score += value
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        this.failedRetrievers.add(provider.id)
        this.ctx.logger.warn(`research retrieval provider ${provider.id} failed: ${message}; skipping it`)
      }
    }
    return score
  }

  /**
   * Assemble one bounded, source-addressed view for the current request.
   * @param session - durable source log.
   * @param requestMessages - admitted current-turn messages before logging.
   * @param goal - optional active same-session Goal.
   * @returns a complete view and the raw event seqs it materializes.
   */
  assemble(session: Session, requestMessages: readonly Message[], goal?: ResearchContextGoal): ResearchContextView {
    const started = performance.now()
    const researchState = this.state(session)
    const stateEventSeq = latestEventSeq(session, 'research/state-change')
    const index = this.index(session)
    const requestText = currentRequestText(requestMessages)
    const latestDirectIsCurrent = index.latestDirectUser?.text === requestText
      && index.active?.seqs.includes(index.latestDirectUser.seq) === true
    const priorDirectRequests = index.directUserCount - (latestDirectIsCurrent ? 1 : 0)
    const focusMode = classifyFocus(requestText, priorDirectRequests === 0)
    const continueRoute = focusMode === 'continue'
    const exposeRoute = focusMode !== 'reframe'
    const workingText = researchState.working === undefined ? '' : [
      researchState.working.currentTask,
      ...researchState.working.unresolved,
      researchState.working.nextAction,
    ].join('\n')
    const ideaLens = classifyIdeaLens(requestText, workingText, focusMode)
    const goalText = goal === undefined ? '' : `${goal.objective}\n${goal.phase}`
    const retrievalRequest = focusMode === 'reframe' ? reframeQuery(requestText) : requestText
    const query = [retrievalRequest, ...(continueRoute ? [workingText, goalText] : [])].filter(Boolean).join('\n')
    const queryTerms = termsOf(query)
    const lensNodes = selectInquiryNodes(researchState.inquiry, ideaLens, queryTerms)
    const lensSection = renderIdeaLens(researchState.inquiry, ideaLens, lensNodes)
    const retrievalTerms = new Set(queryTerms)
    for (const [term, aliases] of Object.entries(this.config.retrievalAliases ?? {})) {
      if (queryTerms.has(term) || aliases.some(alias => queryTerms.has(alias))) {
        retrievalTerms.add(term)
        for (const alias of aliases) retrievalTerms.add(alias)
      }
    }
    const fuzzy = fuzzyMatches(index, queryTerms)
    const authorityTerms = termsOf(`${researchState.kernel.text}\n${researchState.frame?.text ?? ''}`)
    const latestHandoff = index.handoffs.at(-1)
    const handoffs = index.handoffs
      .map((handoff, position) => {
        const score = this.retrievalScore(queryTerms, {
          turn: 0,
          kind: 'handoff',
          text: handoff.text,
          terms: termsOf(handoff.text),
        }, fuzzy)
        const bootstrap = continueRoute && index.blocks.length === 0 && handoff === latestHandoff
        return { handoff, score: (bootstrap ? 1_000_000 : 0) + score + position / Math.max(1, index.handoffs.length) }
      })
      .filter(candidate => candidate.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 2)
      .map(candidate => candidate.handoff)
    const recentStart = continueRoute
      ? Math.max(0, index.blocks.length - this.config.recentTurns)
      : index.blocks.length
    const mandatory = index.blocks.slice(recentStart)
    const rootTurns = new Set(continueRoute ? researchState.working?.evidenceRoots ?? [] : [])
    const candidateTurns = new Set(rootTurns)
    addPostingTurns(candidateTurns, index, retrievalTerms)
    addPostingTurns(candidateTurns, index, fuzzy.keys())
    const olderBlocks = index.blocks.slice(0, recentStart)
    const older = olderBlocks
      .filter(block => candidateTurns.has(block.turn) || this.retrievers.size > 0)
      .map((block, position) => {
        const root = rootTurns.has(block.turn)
        const queryScore = this.retrievalScore(queryTerms, { ...block, kind: 'loop' }, fuzzy)
        const lexicalScore = queryScore + overlap(authorityTerms, block.terms) * 2
        return {
          block,
          queryScore,
          score: (root ? 1_000_000 : 0) + lexicalScore + position / Math.max(1, olderBlocks.length),
          eligible: root || queryScore > 0,
        }
      })
      .filter(candidate => candidate.eligible)
      .sort((left, right) => right.score - left.score || right.block.turn - left.block.turn)

    const evidence: TurnBlock[] = []
    const covered = new Set<string>()
    for (const candidate of older) {
      if (evidence.length >= this.config.maxEvidenceTurns) break
      evidence.push(candidate.block)
      for (const term of queryTerms) if (candidate.block.terms.has(term)) covered.add(term)
      if (rootTurns.size === 0 && queryTerms.size > 0 && covered.size === queryTerms.size) break
    }
    const selected = [...new Map([...evidence, ...mandatory].map(block => [block.turn, block])).values()]
      .sort((left, right) => left.turn - right.turn)
    const selectedTurns = new Set<number>()
    const selectedLocators: string[] = []
    const partialTurns: number[] = []
    const visibleGoal = exposeRoute ? goal : undefined
    const goalEventSeq = visibleGoal === undefined ? undefined : latestEventSeq(session, 'goal/change')
    const sourceSeqs: number[] = [
      stateEventSeq,
      goalEventSeq,
      ...lensNodes.flatMap(node => node.sourceSeqs),
    ].filter((seq): seq is number => seq !== undefined)
    const kernelSection = researchState.kernel.text
    const frameSection = researchState.frame === undefined ? '' : `<research-frame>\n${researchState.frame.text}\n</research-frame>`
    const ladderSection = [
      `<objective-ladder focus-mode="${focusMode}">`,
      'authority: active per-Session Idea Seed plus the latest user instruction.',
      'evolution: update Seed or Frame only from unambiguous feedback or after resolving an Idea discussion.',
      `provisional: Working State, Goal, and ${ideaLens} Lens cannot silently redefine the Idea.`,
      '</objective-ladder>',
    ].join('\n')
    const workingSection = !exposeRoute || researchState.working === undefined ? '' : [
      '<task-idea-bridge authority="model-maintained" status="provisional">',
      `task-binding: ${researchState.working.currentTask}`,
      ...researchState.working.unresolved.map(value => `unresolved: ${value}`),
      `next-evidence-action: ${researchState.working.nextAction}`,
      ...researchState.working.evidenceRoots.length === 0 ? [] : [`evidence-roots: ${researchState.working.evidenceRoots.join(',')}`],
      '</task-idea-bridge>',
    ].join('\n')
    const goalSection = visibleGoal === undefined ? '' : [
      `<active-goal id="${visibleGoal.id}" authority="execution-lease" phase="${visibleGoal.phase}" rounds="${visibleGoal.roundsStarted}">`,
      visibleGoal.objective,
      '</active-goal>',
    ].join('\n')
    const sections = [
      kernelSection,
      '<research-context authority="session-persistent">',
      ...frameSection.length === 0 ? [] : [frameSection],
      ladderSection,
      ...lensSection.length === 0 ? [] : [lensSection],
      ...workingSection.length === 0 ? [] : [workingSection],
      ...goalSection.length === 0 ? [] : [goalSection],
    ]
    const kernelTokens = estimateMessageTokens(this.ctx, kernelSection)
    if (kernelTokens > this.config.maxKernelTokens) {
      throw new Error(`research kernel needs ~${kernelTokens} tokens, above the ${this.config.maxKernelTokens}-token attention budget; revise the Kernel instead of silently truncating it`)
    }
    const authorityTokens = estimateMessageTokens(this.ctx, [kernelSection, frameSection, lensSection, workingSection].filter(Boolean).join('\n'))
    const contextWindow = lastContextWindow(session)
    const authorityBudget = contextWindow === undefined
      ? this.config.fallbackAuthorityTokens
      : Math.floor(contextWindow / 20)
    if (authorityTokens > authorityBudget) {
      throw new Error(`research authority needs ~${authorityTokens} tokens, above the ${authorityBudget}-token authority budget`)
    }
    let historyTokens = 0
    for (const handoff of handoffs) {
      const anchors = handoff.anchors.map(xmlAttribute).join(' ')
      const section = [
        `<handoff-bridge source-harness="${xmlAttribute(handoff.sourceHarness)}" source-session="${xmlAttribute(handoff.sourceSessionId)}" import-seq="${handoff.importEventSeq}"${anchors.length === 0 ? '' : ` anchors="${anchors}"`}>`,
        handoff.text,
        '</handoff-bridge>',
      ].join('\n')
      const projected = [...sections, section, '</research-context>'].join('\n')
      if (projected.length > this.config.maxViewChars || estimateMessageTokens(this.ctx, projected) > this.config.maxViewTokens) continue
      sections.push(section)
      historyTokens += estimateMessageTokens(this.ctx, section)
      sourceSeqs.push(handoff.importEventSeq)
      selectedLocators.push(`handoff:${handoff.id}`)
    }
    for (const block of selected) {
      const section = `<historical-loop turn="${block.turn}" source-seqs="${block.seqs.join(',')}">\n${block.text}\n</historical-loop>`
      const projected = [...sections, section, '</research-context>'].join('\n')
      const projectedTokens = estimateMessageTokens(this.ctx, projected)
      if (projected.length <= this.config.maxViewChars && projectedTokens <= this.config.maxViewTokens) {
        sections.push(section)
        historyTokens += estimateMessageTokens(this.ctx, section)
        selectedTurns.add(block.turn)
        selectedLocators.push(`turn:${block.turn}:full`)
        sourceSeqs.push(...block.seqs)
        continue
      }

      // An oversized loop is never arbitrarily sliced. Restore relevant message-level
      // rows together with the first user row and the nearest causal dialogue row.
      const mandatoryBlock = mandatory.some(value => value.turn === block.turn)
      const rootBlock = rootTurns.has(block.turn)
      const rowCandidates = block.rows.map(row => ({
        row,
        score: this.retrievalScore(queryTerms, { turn: block.turn, kind: row.kind, text: row.text, terms: row.terms }, fuzzy),
      })).filter(candidate => candidate.score > 0)
      if (rowCandidates.length === 0 && (mandatoryBlock || rootBlock) && block.rows.length > 0) {
        const lastRow = block.rows.at(-1)
        if (lastRow !== undefined) rowCandidates.push({ row: lastRow, score: 1 })
      }
      rowCandidates.sort((left, right) => right.score - left.score || right.row.seq - left.row.seq)
      const chosen = new Map<number, LoopRow>()
      const firstUser = block.rows.find(row => row.kind === 'dialogue' && row.text.startsWith('USER:'))
      for (const candidate of rowCandidates.slice(0, 4)) {
        const bridge = new Map<number, LoopRow>()
        if (firstUser !== undefined) bridge.set(firstUser.seq, firstUser)
        if (candidate.row.kind === 'tool-evidence') {
          const preceding = block.rows.filter(row => row.kind === 'dialogue' && row.seq < candidate.row.seq).at(-1)
          if (preceding !== undefined) bridge.set(preceding.seq, preceding)
        }
        const next = new Map(chosen)
        for (const row of bridge.values()) next.set(row.seq, row)
        next.set(candidate.row.seq, candidate.row)
        const rows = [...next.values()].sort((left, right) => left.seq - right.seq)
        const body = rows.map(row => row === firstUser || (row.kind === 'dialogue' && row.seq !== candidate.row.seq)
          ? `<parent-bridge source-seq="${row.seq}">\n${row.text}\n</parent-bridge>`
          : `<${row.kind} source-seq="${row.seq}">\n${row.text}\n</${row.kind}>`).join('\n')
        const partial = `<historical-loop turn="${block.turn}" mode="partial">\n${body}\n</historical-loop>`
        const partialProjected = [...sections, partial, '</research-context>'].join('\n')
        const projectedTokens = estimateMessageTokens(this.ctx, partialProjected)
        if (partialProjected.length > this.config.maxViewChars || projectedTokens > this.config.maxViewTokens) continue
        chosen.clear()
        for (const row of next.values()) chosen.set(row.seq, row)
      }
      if (chosen.size === 0) continue
      const rows = [...chosen.values()].sort((left, right) => left.seq - right.seq)
      const chosenSeqs = new Set(rows.map(row => row.seq))
      const body = rows.map(row => row === firstUser || (row.kind === 'dialogue' && !rowCandidates.some(candidate => candidate.row.seq === row.seq))
        ? `<parent-bridge source-seq="${row.seq}">\n${row.text}\n</parent-bridge>`
        : `<${row.kind} source-seq="${row.seq}">\n${row.text}\n</${row.kind}>`).join('\n')
      const partial = `<historical-loop turn="${block.turn}" mode="partial">\n${body}\n</historical-loop>`
      sections.push(partial)
      historyTokens += estimateMessageTokens(this.ctx, partial)
      selectedTurns.add(block.turn)
      partialTurns.push(block.turn)
      sourceSeqs.push(...chosenSeqs)
      selectedLocators.push(...rows.map(row => `turn:${block.turn}:${row.kind}:seq:${row.seq}`))
    }
    const omittedTurns = index.blocks.filter(block => !selectedTurns.has(block.turn)).map(block => block.turn)
    const locator = omittedTurns.length === 0
      ? ''
      : `<history-locators omitted-count="${omittedTurns.length}" omitted-turn-ranges="${turnRanges(omittedTurns)}" />`
    if (locator.length > 0) sections.push(locator)
    sections.push('</research-context>')
    const text = sections.join('\n')
    const estimatedTokens = estimateMessageTokens(this.ctx, text)
    if (text.length > this.config.maxViewChars || estimatedTokens > this.config.maxViewTokens) {
      throw new Error('research authority and fixed view metadata exceed the configured view budget')
    }
    const components: ResearchContextComponents = {
      kernelTokens,
      frameTokens: estimateMessageTokens(this.ctx, frameSection),
      workingTokens: estimateMessageTokens(this.ctx, workingSection),
      goalTokens: estimateMessageTokens(this.ctx, goalSection),
      historyTokens,
      locatorTokens: estimateMessageTokens(this.ctx, locator),
      lensTokens: estimateMessageTokens(this.ctx, lensSection),
    }
    return Object.freeze({
      text,
      sourceSeqs: Object.freeze([...new Set(sourceSeqs)]),
      selectedTurns: Object.freeze([...selectedTurns]),
      selectedLocators: Object.freeze(selectedLocators),
      partialTurns: Object.freeze(partialTurns),
      omittedTurns: Object.freeze(omittedTurns),
      scannedEvents: index.indexedSeq,
      stateRevision: researchState.revision,
      estimatedTokens,
      assemblyMicros: Math.max(0, Math.round((performance.now() - started) * 1_000)),
      components: Object.freeze(components),
      focusMode,
      ideaLens,
      ...(visibleGoal === undefined ? {} : { goalId: visibleGoal.id }),
    })
  }

  /**
   * Compile a child request without copying the parent's transcript. The parent
   * assembler chooses research evidence from the short delegated request; this
   * method then adds only relevant complete child loops and the current child
   * request. The confirmed parent Kernel therefore remains the exact prefix.
   * @param workerSession - child session whose own completed loops may be recalled.
   * @param requestMessages - current child request messages.
   * @param parentSessionId - durable id of the research parent session.
   * @param parentView - already assembled parent research view to inherit selectively.
   * @returns the bounded worker view and exact cross-session provenance manifest.
   */
  assembleWorker(
    workerSession: Session,
    requestMessages: readonly Message[],
    parentSessionId: string,
    parentView: ResearchContextView,
  ): ResearchWorkerContextView {
    const started = performance.now()
    const index = this.index(workerSession)
    const direct = latestDirectUser(workerSession)
    const query = direct?.text
      ?? requestMessages.map(messageText).filter(Boolean).at(-1)
      ?? ''
    const queryTerms = termsOf(query)
    const recentStart = Math.max(0, index.blocks.length - this.config.recentTurns)
    const mandatory = index.blocks.slice(recentStart)
    const older = index.blocks.slice(0, recentStart)
      .map((block, position) => ({
        block,
        queryScore: overlap(queryTerms, block.terms),
        score: overlap(queryTerms, block.terms) * 16 + position / Math.max(1, recentStart),
      }))
      .filter(candidate => candidate.queryScore > 0)
      .sort((left, right) => right.score - left.score || right.block.turn - left.block.turn)
      .slice(0, this.config.maxEvidenceTurns)
      .map(candidate => candidate.block)
    const selected = [...new Map([...older, ...mandatory].map(block => [block.turn, block])).values()]
      .sort((left, right) => left.turn - right.turn)
    const sections = [
      parentView.text,
      `<research-worker-context parent-session="${parentSessionId}">`,
      `<delegated-request>\n${query}\n</delegated-request>`,
    ]
    const selectedTurns: number[] = []
    const workerSourceSeqs: number[] = direct === undefined ? [] : [direct.seq]
    for (const block of selected) {
      const section = `<worker-loop turn="${block.turn}" source-seqs="${block.seqs.join(',')}">\n${block.text}\n</worker-loop>`
      const projected = [...sections, section, '</research-worker-context>'].join('\n')
      if (projected.length > this.config.maxViewChars || estimateMessageTokens(this.ctx, projected) > this.config.maxViewTokens) continue
      sections.push(section)
      selectedTurns.push(block.turn)
      workerSourceSeqs.push(...block.seqs)
    }
    const omittedTurns = index.blocks.filter(block => !selectedTurns.includes(block.turn)).map(block => block.turn)
    if (omittedTurns.length > 0) {
      sections.push(`<worker-history-locators omitted-count="${omittedTurns.length}" omitted-turn-ranges="${turnRanges(omittedTurns)}" />`)
    }
    sections.push('</research-worker-context>')
    const text = sections.join('\n')
    const estimatedTokens = estimateMessageTokens(this.ctx, text)
    if (text.length > this.config.maxViewChars || estimatedTokens > this.config.maxViewTokens) {
      throw new Error('parent research view and delegated request exceed the configured worker-view budget')
    }
    const manifest: ResearchContextInheritanceProjection = {
      parentSessionId,
      parentStateRevision: parentView.stateRevision,
      parentSourceSeqs: [...parentView.sourceSeqs],
      parentSelectedTurns: [...parentView.selectedTurns],
      workerSourceSeqs: [...new Set(workerSourceSeqs)],
      workerSelectedTurns: selectedTurns,
      workerOmittedTurns: omittedTurns,
      estimatedTokens,
      assemblyMicros: parentView.assemblyMicros + Math.max(0, Math.round((performance.now() - started) * 1_000)),
      viewHash: digest(text),
      focusMode: parentView.focusMode,
      ...(parentView.goalId === undefined ? {} : { goalId: parentView.goalId }),
    }
    return Object.freeze({ text, manifest: Object.freeze(manifest) })
  }

  private async expectRevision(session: Session, expectedRevision: number): Promise<ResearchStateProjection> {
    safeInteger(expectedRevision, 'expected research revision', 1)
    const current = await this.stateForRequest(session)
    if (current.revision !== expectedRevision) throw new TypeError('research state revision is stale')
    return current
  }

  private async commit(
    session: Session,
    current: ResearchStateProjection,
    operation: Exclude<ResearchStateOperation, 'initialize'>,
    replacements: Partial<Pick<ResearchStateProjection, 'kernel' | 'frame' | 'working' | 'inquiry' | 'proposal'>>,
    clearProposal = false,
  ): Promise<ResearchStateProjection> {
    const next: ResearchStateProjection = {
      ...current,
      ...replacements,
      revision: current.revision + 1,
      updatedAt: Date.now(),
    }
    if (clearProposal) delete (next as { proposal?: ResearchAuthorityProposal }).proposal
    const committed = this.authorityProvider === undefined
      ? next
      : await this.authorityProvider.commit(session, current.revision, next)
    this.appendState(session, operation, committed)
    return structuredClone(committed)
  }

  private syncIdeaSelection(session: Session): void {
    const ideas = this.authorityProvider?.list?.(session) ?? []
    if (ideas.length === 0) return
    const current = latestIdeaSelection(session)
    const first = ideas[0]
    if (first === undefined) return
    const ideaId = current === undefined ? first.ideaId : current.ideaId
    if (current === undefined || !sameIdeas(current.ideas, ideas)) this.appendIdeaSelection(session, ideaId, ideas)
  }

  private appendIdeaSelection(session: Session, ideaId: string | null, ideas: readonly ResearchIdeaSummary[]): void {
    const selection: ResearchIdeaSelection = { version: 1, ideaId, ideas: structuredClone(ideas) }
    session.append('research/idea-selection', selection)
  }

  /** Mirror the project snapshot into this Session only when its local replay is stale. */
  private mirrorProjectState(session: Session, project: ResearchStateProjection): void {
    const local = foldState(session.events)
    if (local === undefined) {
      this.appendState(session, 'initialize', project)
      return
    }
    if (JSON.stringify(local.state) === JSON.stringify(project)) return
    this.appendState(session, 'sync-project', project)
  }

  private appendState(session: Session, operation: ResearchStateOperation, state: ResearchStateProjection): void {
    const change: ResearchStateChange = { version: 1, operation, state }
    session.append('research/state-change', change)
  }
}

export default ResearchContextAssembler
