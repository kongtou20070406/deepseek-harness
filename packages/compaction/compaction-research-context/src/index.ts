/**
 * Model-free compaction provider for query-specific research context views.
 * @module @deepseek-ai/dsh-compaction-research-context
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-goal'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'
import type { ResearchContextView, ResearchWorkerContextView } from '@deepseek-ai/dsh-research-context'
import { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'

const PROVIDER = '@deepseek-ai/dsh-compaction-research-context'
const MODEL = 'deterministic-cpu'

function estimatedTokens(value: string): number {
  let ascii = 0
  let nonAscii = 0
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) < 128) ascii += 1
    else nonAscii += 1
  }
  return Math.ceil(ascii / 4) + nonAscii
}

function uniqueEarlierSeqs(values: readonly number[], before: number): number[] {
  return [...new Set(values)].filter(value => Number.isSafeInteger(value) && value >= 0 && value < before)
}

/** Compaction backend that replaces the prior surface with a logged selective view before each first step. */
export class ResearchContextCompactionEngine extends BasicCompactionEngine {
  static override inject = ['agents', 'goals', 'researchContext', 'sessions', 'tokenMeter']

  /**
   * Register the compaction service and the reversible pre-step consumer.
   * @param ctx - Cordis context carrying Agent, Session, and research-context services.
   */
  constructor(ctx: Context) {
    super(ctx)
    ctx.on('agent/pre-step', async (
      { agent, turn, step, signal },
      next,
    ): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || step !== 1 || signal.aborted) return decision
      try {
        const text = await this.compileSurface(agent.session, decision.messages, turn, signal)
        if (text !== undefined && agent.session.surface.nodes.length === 0) {
          return { kind: 'enter', messages: [this.viewMessage(text), ...decision.messages] }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        this.ctx.logger.warn(`research-context assembly failed: ${message}; preserving the full DSH surface`)
      }
      return decision
    })
  }

  /**
   * Compile and durably install one selective surface; native basic compaction remains the fallback.
   * @param session - session whose durable history supplies research evidence.
   * @param requestMessages - messages already admitted for the current model step.
   * @param turn - current agent turn number, when available.
   * @param signal - optional cancellation for cold parent-session lookup.
   * @returns the compiled view, or `undefined` when native DSH context should remain in force.
   */
  async compileSurface(
    session: Session,
    requestMessages: readonly Message[],
    turn: number | null,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    signal?.throwIfAborted()
    if (!this.ctx.researchContext.isEnabled(session)) return undefined
    if (session.header.origin === 'subagent') {
      const workerView = await this.workerView(session, requestMessages, signal)
      if (workerView === undefined) return undefined
      this.ctx.researchContext.recordInheritance(session, workerView)
      const nodes = session.surface.nodes
      const first = nodes[0]
      const last = nodes.at(-1)
      if (first !== undefined && last !== undefined) this.commitView(
        session,
        first,
        last,
        { text: workerView.text, sourceSeqs: workerView.manifest.workerSourceSeqs },
        turn,
      )
      return workerView.text
    }
    const sourceAgent = this.ctx.get('agents')?.get(session.id)
    const currentGoal = sourceAgent === undefined ? undefined : this.ctx.get('goals')?.get(sourceAgent)
    await this.ctx.researchContext.stateForRequest(session)
    const view = this.ctx.researchContext.assemble(session, requestMessages, currentGoal === undefined
      ? undefined
      : {
        id: currentGoal.id,
        objective: currentGoal.objective,
        phase: currentGoal.phase,
        roundsStarted: currentGoal.roundsStarted,
      })
    this.ctx.researchContext.recordAssembly(session, view)
    const nodes = session.surface.nodes
    const first = nodes[0]
    const last = nodes.at(-1)
    if (first !== undefined && last !== undefined) this.commitView(session, first, last, view, turn)
    return view.text
  }

  private viewMessage(text: string): UserMessage {
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'plugin',
        plugin: PROVIDER,
        form: 'snapshot',
        sections: [{ name: 'research-context', text }],
      },
    })
  }

  /** Resolve the root research session and assemble a query-specific child view. */
  private async workerView(
    session: Session,
    requestMessages: readonly Message[],
    signal?: AbortSignal,
  ): Promise<ResearchWorkerContextView | undefined> {
    let source = session
    const seen = new Set<string>([String(session.id)])
    while (source.header.parentSession !== undefined) {
      const parentId = source.header.parentSession
      if (seen.has(String(parentId))) return undefined
      seen.add(String(parentId))
      let parent = this.ctx.sessions.get(parentId)
      if (parent === undefined) {
        const persistence = this.ctx.get('sessionPersistence')
        if (persistence === undefined) return undefined
        try {
          const inspection = await persistence.inspect(parentId, signal)
          parent = Session.create(parentId, inspection.events, inspection.meta)
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          this.ctx.logger.warn(`cold parent session ${String(parentId)} is unavailable: ${message}`)
          return undefined
        }
      }
      source = parent
    }
    if (source === session || !this.ctx.researchContext.isEnabled(source)) return undefined
    const sourceAgent = this.ctx.agents.get(source.id)
    const currentGoal = sourceAgent === undefined ? undefined : this.ctx.goals.get(sourceAgent)
    const latestDirect = [...session.events].reverse().find(event =>
      event.type === 'user/message' && event.data.source.kind !== 'plugin')
    const queryMessages = latestDirect?.type === 'user/message' ? [latestDirect.data] : requestMessages
    await this.ctx.researchContext.stateForRequest(source)
    const parentView = this.ctx.researchContext.assemble(source, queryMessages, currentGoal === undefined
      ? undefined
      : {
        id: currentGoal.id,
        objective: currentGoal.objective,
        phase: currentGoal.phase,
        roundsStarted: currentGoal.roundsStarted,
      })
    return this.ctx.researchContext.assembleWorker(session, requestMessages, String(source.id), parentView)
  }

  private commitView(
    session: Session,
    start: number,
    end: number,
    view: Pick<ResearchContextView, 'text' | 'sourceSeqs'>,
    turn: number | null,
  ): CompactionResult {
    const surface = session.surface.nodes
    const startIndex = surface.indexOf(start)
    const endIndex = surface.indexOf(end)
    if (startIndex < 0 || endIndex < startIndex) throw new Error('research-context compaction range is invalid')
    const shadowedSeqs = surface.slice(startIndex, endIndex + 1)
    const shadowedTokenCount = shadowedSeqs.reduce((total, seq) => {
      const event = session.events[seq]
      if (event === undefined) return total
      const message = session.deriveEventMessage(event)
      return total + estimatedTokens(message === null ? '' : JSON.stringify(message.content))
    }, 0)
    const compactionId = CompactionId(randomUUID())
    const summary = [{ type: 'text' as const, text: view.text }]
    const startEvent = session.append('compaction/start', { compactionId, turn })
    const summaryEvent = session.append('compaction/summary', {
      compactionId,
      summary,
      shadowedRange: { start, end },
      shadowedSeqs,
      shadowedTokenCount,
      provider: PROVIDER,
      model: MODEL,
    })
    session.append('user/message', createUserMessage({
      content: summary,
      source: compactCheckpointSource(compactionId),
    }), {
      surfaceOp: { op: 'replace', start, end },
      sourceEventSeqs: uniqueEarlierSeqs(
        [startEvent.seq, summaryEvent.seq, ...shadowedSeqs, ...view.sourceSeqs],
        session.seq,
      ),
    })
    const endEvent = session.append('compaction/end', { compactionId, turn })
    return {
      compactionId,
      startSeq: startEvent.seq,
      summarySeq: summaryEvent.seq,
      endSeq: endEvent.seq,
      summary,
      shadowedRange: { start, end },
      shadowedSeqs,
      shadowedTokenCount,
    }
  }

}

export default ResearchContextCompactionEngine
