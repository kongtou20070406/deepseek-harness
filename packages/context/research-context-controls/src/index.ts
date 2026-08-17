/**
 * Research-state model tools and human confirmation command.
 * @module @deepseek-ai/dsh-research-context-controls
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-fs'
import type {
  HumanBoardEdgeInput,
  HumanBoardNodeInput,
  InquiryEdgeInput,
  InquiryNodeInput,
  ResearchInquiryEdge,
  ResearchInquiryNodeKind,
  ResearchStateProjection,
} from '@deepseek-ai/dsh-research-context'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'research-context-controls'
export const inject = ['commands', 'fs', 'researchContext', 'systemPrompt', 'tools']

const GUIDANCE = 'Each Session owns one persistent Idea. Keep its Seed slow, its Frame slower than Working State, and update the lowest sufficient layer after meaningful feedback. Before acting, compare the latest user message with the active Idea. If there is one action-consistent reading, proceed autonomously. If two plausible readings would change the research object, success criterion, forbidden substitution, or one high-lock-in action, automatically open an Idea discussion, ask exactly one concrete question, and pause only that conflicting action. Ordinary operational uncertainty is not ambiguity: choose the reversible path. Resolve a pending discussion from the next clear user answer before updating the Idea. Evidence and Inquiry entries are optional and stay empty until real source-addressed evidence exists. Never create placeholders. Keep Working State concise and in Simplified Chinese.'

const EVOLUTION_SCOPE_ZH = {
  clarify: '澄清表述',
  adjust: '调整追求',
  pivot: '转换方向',
} as const

function requireSession(invocation: CommandInvocation) {
  return invocation.agent.session
}

function requireToolSession(exec: { agent?: { session: import('@deepseek-ai/dsh-session').Session } }) {
  if (exec.agent === undefined) throw new Error('research state tools require an owning agent session')
  return exec.agent.session
}

function stateValue(state: ResearchStateProjection): { state_json: string } {
  return { state_json: JSON.stringify(state) }
}

async function retryModelStateMutation(
  ctx: Context,
  session: import('@deepseek-ai/dsh-session').Session,
  expectedRevision: number,
  mutate: (revision: number) => Promise<ResearchStateProjection>,
): Promise<ResearchStateProjection> {
  try {
    return await mutate(expectedRevision)
  } catch (error: unknown) {
    if (!(error instanceof TypeError) || error.message !== 'research state revision is stale') throw error
    const current = await ctx.researchContext.stateForRequest(session)
    return await mutate(current.revision)
  }
}

const STATE_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { state_json: { type: 'string', required: true } },
  },
  render: (_args: unknown, value: { state_json: string }) => [{ type: 'text' as const, text: value.state_json }],
} as const

function renderState(state: ResearchStateProjection): string {
  const proposal = state.proposal
  const inquiry = state.inquiry
  return [
    `研究状态版本：${state.revision}`,
    `Idea Seed v${state.kernel.version}：`,
    state.kernel.text,
    '',
    state.frame === undefined
      ? '研究框架：未设置'
      : `研究框架 v${state.frame.version}：\n${state.frame.text}`,
    '',
    state.working === undefined
      ? '工作状态：未设置'
      : [
        `工作状态 r${state.working.revision}：${state.working.currentTask}`,
        ...state.working.unresolved.map(value => `- 未解决：${value}`),
        `下一步：${state.working.nextAction || '未设置'}`,
        `证据来源：${state.working.evidenceRoots.join(', ') || '无'}`,
      ].join('\n'),
    '',
    inquiry === undefined
      ? '探究／证据：暂无（不创建空占位）'
      : [
        `探究地图 r${inquiry.revision}：${inquiry.nodes.length} 张卡片，${inquiry.edges.length} 条语义关联`,
        `证据标记：${inquiry.nodes.filter(node => node.kind === 'evidence' || node.kind === 'counterevidence').length}`,
        inquiry.frontier === undefined
          ? '决策前沿：未设置'
          : `决策前沿：${inquiry.frontier.question}\n所需证据：${inquiry.frontier.evidenceNeeded}`,
        inquiry.leap?.status === 'pending'
          ? [
            `Idea 歧义待讨论 ${inquiry.leap.id}：${inquiry.leap.question}`,
            `仅暂停动作：${inquiry.leap.blockedAction}`,
            ...inquiry.leap.evidenceFrontierActions.map(value => `- AI 继续推进的证据前沿：${value}`),
          ].join('\n')
          : '待决跃迁：无',
      ].join('\n'),
    '',
    proposal === undefined
      ? '待确认权威提案：无'
      : [
        `待确认 ${proposal.target} 提案 ${proposal.id}`,
        proposal.evolution === undefined
          ? '调整依据：未记录（旧版提案）'
          : `调整幅度：${EVOLUTION_SCOPE_ZH[proposal.evolution.scope]}\n反馈依据与保留项：${proposal.evolution.basis}`,
        `基于版本：${proposal.baseVersion ?? '无'}`,
        '--- 当前内容',
        proposal.target === 'kernel' ? state.kernel.text : state.frame?.text ?? '未设置',
        '+++ 候选内容',
        proposal.text,
        '',
        `确认：/research confirm ${proposal.id}`,
        `拒绝：/research reject ${proposal.id}`,
      ].join('\n'),
  ].join('\n')
}

function stringValue(record: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = record[key]
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  if (!required && value === undefined) return undefined
  throw new TypeError(`handoff field ${key} must be a non-empty string`)
}

function stringList(record: Record<string, unknown>, key: string): string[] {
  const value = record[key]
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new TypeError(`handoff field ${key} must be a string array`)
  }
  return value.map(item => item.trim()).filter(Boolean)
}

function parseHandoff(raw: string) {
  if (raw.length > 64_000) throw new TypeError('handoff file must not exceed 64000 characters')
  const value: unknown = JSON.parse(raw)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('handoff file must be an object')
  const card = value as Record<string, unknown>
  if (card.version !== 1) throw new TypeError('handoff version must be 1')
  const sourceValue = card.source
  if (typeof sourceValue !== 'object' || sourceValue === null || Array.isArray(sourceValue)) {
    throw new TypeError('handoff source must be an object')
  }
  const source = sourceValue as Record<string, unknown>
  const rows = [
    ['target', stringValue(card, 'target')],
    ['boundary', stringValue(card, 'boundary')],
    ['last-confirmed-user-request', stringValue(card, 'last_confirmed_user_request')],
    ...stringList(card, 'decisions_and_authority').map(text => ['decision-or-authority', text]),
    ...stringList(card, 'completed').map(text => ['completed', text]),
    ...stringList(card, 'pending_or_blocked').map(text => ['pending-or-blocked', text]),
    ...stringList(card, 'live_state_to_verify').map(text => ['live-state-to-verify', text]),
  ] as const
  const projectPath = stringValue(source, 'project_path', false)
  return {
    sourceHarness: stringValue(source, 'harness') ?? '',
    sourceSessionId: stringValue(source, 'session_id') ?? '',
    ...(projectPath === undefined ? {} : { projectPath }),
    anchors: stringList(card, 'anchors'),
    text: rows.map(([name, text]) => `${name}: ${text}`).join('\n'),
  }
}

const NODE_KINDS = new Set<ResearchInquiryNodeKind>([
  'question', 'hypothesis', 'rival', 'assumption', 'claim', 'evidence-requirement',
  'evidence', 'counterevidence', 'decision', 'rejection',
])
const EDGE_RELATIONS = new Set<ResearchInquiryEdge['relation']>([
  'supports', 'challenges', 'depends-on', 'alternative-to', 'informs', 'supersedes', 'related',
])

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`board field ${key} must be a non-empty string`)
  return value.trim()
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new TypeError(`board field ${key} must be a string`)
  return value.trim() || undefined
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new TypeError(`board field ${key} must be a boolean`)
  return value
}

async function executeBoardCommand(ctx: Context, invocation: CommandInvocation, raw: string): Promise<CommandResult> {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('board payload must be a JSON object')
    const record = value as Record<string, unknown>
    const action = requiredString(record, 'action')
    const session = requireSession(invocation)
    let state: ResearchStateProjection
    if (action === 'upsert-node') {
      const kind = requiredString(record, 'kind') as ResearchInquiryNodeKind
      if (!NODE_KINDS.has(kind)) throw new TypeError(`unknown board node kind: ${kind}`)
      const id = optionalString(record, 'id')
      const modelVisible = optionalBoolean(record, 'modelVisible')
      const input: HumanBoardNodeInput = {
        ...(id === undefined ? {} : { id }),
        kind,
        text: requiredString(record, 'text'),
        ...(modelVisible === undefined ? {} : { modelVisible }),
      }
      state = await ctx.researchContext.upsertHumanBoardNode(session, input)
    } else if (action === 'upsert-edge') {
      const relation = requiredString(record, 'relation') as ResearchInquiryEdge['relation']
      if (!EDGE_RELATIONS.has(relation)) throw new TypeError(`unknown board edge relation: ${relation}`)
      const id = optionalString(record, 'id')
      const label = optionalString(record, 'label')
      const modelVisible = optionalBoolean(record, 'modelVisible')
      const input: HumanBoardEdgeInput = {
        ...(id === undefined ? {} : { id }),
        fromId: requiredString(record, 'fromId'),
        toId: requiredString(record, 'toId'),
        relation,
        ...(label === undefined ? {} : { label }),
        ...(modelVisible === undefined ? {} : { modelVisible }),
      }
      state = await ctx.researchContext.upsertHumanBoardEdge(session, input)
    } else if (action === 'visibility') {
      state = await ctx.researchContext.setBoardVisibility(
        session,
        requiredString(record, 'id'),
        optionalBoolean(record, 'modelVisible') ?? true,
      )
    } else {
      throw new TypeError(`unknown board action: ${action}`)
    }
    return { kind: 'success', text: renderState(state) }
  } catch (error: unknown) {
    return { kind: 'error', text: `Board update failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

async function executeIdeaInput(
  ctx: Context,
  session: import('@deepseek-ai/dsh-session').Session,
  raw: string,
): Promise<CommandResult> {
  ctx.researchContext.setEnabled(session, true)
  const input = raw.trim()
  let state = await ctx.researchContext.stateForRequest(session)
  if (input.length === 0 || /^(?:show|查看)$/iu.test(input)) {
    return { kind: 'success', text: renderState(state) }
  }
  if (/^(?:help|帮助)$/iu.test(input)) {
    return { kind: 'success', text: '用法：/idea（查看）｜/idea set <完整 Idea Seed>｜/idea frame <完整 Research Frame>。也可直接输入 /idea <完整 Idea Seed>。' }
  }

  const frameMatch = /^(?:frame|框架)\s+([\s\S]+)$/iu.exec(input)
  const seedMatch = /^(?:set|seed|目标)\s+([\s\S]+)$/iu.exec(input)
  const target = frameMatch === null ? 'kernel' as const : 'frame' as const
  const text = (frameMatch?.[1] ?? seedMatch?.[1] ?? input).trim()
  if (text.length === 0) return { kind: 'error', text: 'Idea 内容不能为空。运行 /idea help 查看用法。' }

  const pending = state.inquiry?.leap
  if (pending?.status === 'pending') {
    state = await ctx.researchContext.resolveLeap(session, pending.id, {
      kind: 'clarify',
      text: `用户通过 /idea 明确写入 ${target === 'kernel' ? 'Idea Seed' : 'Research Frame'}。`,
    })
  }
  const next = await ctx.researchContext.updateAuthority(session, state.revision, target, text, {
    scope: 'adjust',
    basis: '用户通过 /idea 直接修改；保留未被新文本替换的会话证据与工作记录。',
  })
  return { kind: 'success', text: renderState(next) }
}

async function executeIdeaCommand(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  try {
    return await executeIdeaInput(ctx, requireSession(invocation), invocation.rawInput)
  } catch (error: unknown) {
    return { kind: 'error', text: `Idea 更新失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

async function executeCommand(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const input = invocation.rawInput.trim()
  const session = requireSession(invocation)
  const control = /^(off|on|close|open)$/iu.exec(input)
  if (control !== null) {
    const enabled = !['off', 'close'].includes((control[1] ?? '').toLowerCase())
    if (!enabled) {
      ctx.researchContext.setEnabled(session, false)
      return { kind: 'success', text: '当前对话已关闭 Idea；后续请求不再组装研究上下文。' }
    }
    ctx.researchContext.setEnabled(session, true)
    return { kind: 'success', text: renderState(await ctx.researchContext.stateForRequest(session)) }
  }
  const state = await ctx.researchContext.stateForRequest(session)
  if (input.length === 0 || input === 'show') return { kind: 'success', text: renderState(state) }
  const ideaMatch = /^idea(?:\s+([\s\S]+))?$/iu.exec(input)
  if (ideaMatch !== null) return await executeIdeaInput(ctx, session, ideaMatch[1] ?? '')
  const importMatch = /^import-handoff\s+(.+)$/iu.exec(input)
  if (importMatch !== null) {
    try {
      const session = requireSession(invocation)
      const target = await ctx.fs.resolve((importMatch[1] ?? '').trim(), {
        ...(session.header.cwd === undefined ? {} : { cwd: session.header.cwd }),
        signal: invocation.signal,
      })
      const handoff = parseHandoff(await ctx.fs.readText(target, invocation.signal))
      const imported = ctx.researchContext.importHandoff(session, handoff)
      return {
        kind: 'success',
        text: `Imported handoff ${imported.id} from ${imported.sourceHarness}:${imported.sourceSessionId}. It is evidence, not authority.`,
        sourceEventSeq: imported.importEventSeq,
      }
    } catch (error: unknown) {
      return { kind: 'error', text: `Handoff import failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  const boardMatch = /^board\s+(.+)$/isu.exec(input)
  if (boardMatch !== null) return await executeBoardCommand(ctx, invocation, boardMatch[1] ?? '')
  const leapMatch = /^leap\s+(accept|reject)\s+(research-leap-[0-9a-f-]+)(?:\s+(\d+))?$/iu.exec(input)
  if (leapMatch !== null) {
    try {
      const next = (leapMatch[1] ?? '').toLowerCase() === 'accept'
        ? await ctx.researchContext.resolveLeap(requireSession(invocation), leapMatch[2] ?? '', {
          kind: 'accept', candidateIndex: Number(leapMatch[3] ?? 1),
        })
        : await ctx.researchContext.resolveLeap(requireSession(invocation), leapMatch[2] ?? '', { kind: 'reject' })
      return { kind: 'success', text: renderState(next) }
    } catch (error: unknown) {
      return { kind: 'error', text: `Leap resolution failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  const match = /^(confirm|reject)\s+(research-proposal-[0-9a-f-]+)$/iu.exec(input)
  if (match === null) return { kind: 'error', text: 'Usage: /research [show|on|off|idea [set|frame] <text>|import-handoff <path>|confirm <legacy-proposal-id>|reject <legacy-proposal-id>|leap accept <id> <candidate>|leap reject <id>|board <json>]' }
  try {
    const next = (match[1] ?? '').toLowerCase() === 'confirm'
      ? await ctx.researchContext.confirmAuthority(requireSession(invocation), match[2] ?? '')
      : await ctx.researchContext.rejectAuthority(requireSession(invocation), match[2] ?? '')
    return { kind: 'success', text: renderState(next) }
  } catch (_staleProposal) {
    return { kind: 'error', text: 'That proposal is no longer current. Run /research to inspect the active state.' }
  }
}

/** Register model proposal/working-state tools and the human confirmation command. */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({ name: 'research-context:authority', order: 113, text: GUIDANCE })

  ctx.commands.register({
    name: 'research',
    description: 'advanced research-state and legacy compatibility commands',
    input: { hint: '[show|on|off|idea [set|frame] <text>|import-handoff <path>|confirm <legacy-proposal-id>|reject <legacy-proposal-id>]' },
    handler: invocation => executeCommand(ctx, invocation),
  })

  ctx.commands.register({
    name: 'idea',
    description: '查看或直接修改当前对话自己的持久 Idea',
    input: { hint: '[show|set <完整 Idea Seed>|frame <完整 Research Frame>]' },
    handler: invocation => executeIdeaCommand(ctx, invocation),
  })

  ctx.tools.register(defineTool({
    name: 'get_research_state',
    description: 'Read the current human-confirmed research pursuit, Research Frame, model-maintained Working State, and any pending unconfirmed authority proposal.',
    parameters: {},
    output: STATE_OUTPUT,
    async execute(_args, exec) {
      return stateValue(await ctx.researchContext.stateForRequest(requireToolSession(exec)))
    },
    presentCall: () => ({ card: 'generic', title: '读取研究状态', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'update_research_idea',
    description: 'Persist one complete per-Session Idea Seed or Frame replacement after unambiguous feedback. If plausible readings would change action, open and resolve an Idea discussion first.',
    parameters: {
      expected_revision: { type: 'number', required: true, description: 'Exact revision returned by get_research_state.' },
      target: { type: 'string', required: true, enum: ['kernel', 'frame'] },
      text: { type: 'string', required: true, description: 'Complete replacement, in the user\'s language.' },
      change_scope: { type: 'string', required: true, enum: ['clarify', 'adjust', 'pivot'] },
      basis: { type: 'string', required: true, description: 'The user feedback that changed it and what remains.' },
    },
    output: STATE_OUTPUT,
    async execute(args, exec) {
      const session = requireToolSession(exec)
      const state = await retryModelStateMutation(ctx, session, args.expected_revision, revision => (
        ctx.researchContext.updateAuthority(
          session,
          revision,
          args.target,
          args.text,
          { scope: args.change_scope, basis: args.basis },
        )
      ))
      return stateValue(state)
    },
    presentCall: args => ({ card: 'generic', title: `维护 ${args.target === 'kernel' ? 'Idea Seed' : 'Research Frame'}`, kind: 'other', rawInput: args.text }),
  }))

  ctx.tools.register(defineTool({
    name: 'update_research_working_state',
    description: 'Replace non-authoritative execution state for continuation. Use raw completed-loop turn numbers as evidence_roots. This cannot change the active research pursuit or Research Frame.',
    parameters: {
      expected_revision: { type: 'number', required: true, description: 'Exact revision returned by get_research_state.' },
      current_task: { type: 'string', required: true, description: 'Concrete task currently being advanced.' },
      unresolved: { type: 'array', required: true, items: { type: 'string' }, description: 'Open questions or blockers.' },
      next_action: { type: 'string', required: true, description: 'Next executable action, or an empty string if none.' },
      evidence_roots: { type: 'array', required: true, items: { type: 'number' }, description: 'Completed historical turn numbers required to continue this task.' },
    },
    output: STATE_OUTPUT,
    async execute(args, exec) {
      const session = requireToolSession(exec)
      const state = await retryModelStateMutation(ctx, session, args.expected_revision, revision => (
        ctx.researchContext.updateWorking(session, revision, {
          currentTask: args.current_task,
          unresolved: args.unresolved,
          nextAction: args.next_action,
          evidenceRoots: args.evidence_roots,
        })
      ))
      return stateValue(state)
    },
    presentCall: args => ({ card: 'generic', title: '更新研究工作状态', kind: 'other', rawInput: args.current_task }),
  }))

  ctx.tools.register(defineTool({
    name: 'update_research_inquiry',
    description: 'Upsert a few provisional Inquiry Map cards/connections and optionally replace the single Decision Frontier. Use only when evidence or the research question materially changes; omitted cards are valid. Evidence requirements are practical Idea-support contracts, not paper-only obligations. A model-generated supported status cannot close a contract. A model-generated why-question must cite its triggering source, remain unanswered unless evidence discriminates, and connect to falsifiable rivals or a missing observation. This cannot modify human-authored cards or scientific authority.',
    parameters: {
      expected_revision: { type: 'number', required: true, description: 'Current research-state revision. A stale model-only update is merged once onto the latest revision.' },
      nodes: {
        type: 'array', required: true, description: 'Zero to sixteen sparse card upserts.',
        items: {
          type: 'object', additionalProperties: false, properties: {
            id: { type: 'string', description: 'Existing model-card id to update; omit to create.' },
            kind: { type: 'string', required: true, enum: [...NODE_KINDS] },
            text: { type: 'string', required: true },
            status: { type: 'string', enum: ['active', 'supported', 'challenged', 'retired', 'rejected'] },
            model_visible: { type: 'boolean', description: 'Whether this card may enter a future Idea Lens; default true.' },
            source_seqs: { type: 'array', items: { type: 'number' }, description: 'Exact same-session event seqs supporting this card.' },
            evidence_class: {
              type: 'string',
              enum: ['task-effect', 'matched-baseline', 'mechanism', 'ablation', 'generalization', 'resource', 'statistics', 'reproducibility', 'negative-evidence'],
              description: 'Only for evidence-requirement cards.',
            },
          },
        },
      },
      edges: {
        type: 'array', required: true, description: 'Zero to twenty-four semantic edge upserts. Canvas positions never belong here.',
        items: {
          type: 'object', additionalProperties: false, properties: {
            id: { type: 'string', description: 'Existing model-edge id to update; omit to create.' },
            from_id: { type: 'string', required: true },
            to_id: { type: 'string', required: true },
            relation: { type: 'string', required: true, enum: [...EDGE_RELATIONS] },
            label: { type: 'string' },
            model_visible: { type: 'boolean', description: 'Whether this edge may affect future Idea Lenses; default true.' },
          },
        },
      },
      frontier_question: { type: 'string', description: 'When set, all three frontier text fields replace the current Decision Frontier.' },
      frontier_changes_action_when: { type: 'string' },
      frontier_evidence_needed: { type: 'string' },
      frontier_node_ids: { type: 'array', items: { type: 'string' } },
      clear_frontier: { type: 'boolean', description: 'Clear the current Frontier; mutually exclusive with frontier_question.' },
    },
    output: STATE_OUTPUT,
    async execute(args, exec) {
      const session = requireToolSession(exec)
      const frontier = args.clear_frontier === true
        ? null
        : args.frontier_question === undefined
          ? undefined
          : {
            question: args.frontier_question,
            changesActionWhen: args.frontier_changes_action_when ?? '',
            evidenceNeeded: args.frontier_evidence_needed ?? '',
            nodeIds: args.frontier_node_ids ?? [],
          }
      const nodes: InquiryNodeInput[] = args.nodes.map(node => ({
        ...(node.id === undefined ? {} : { id: node.id }),
        kind: node.kind,
        text: node.text,
        ...(node.status === undefined ? {} : { status: node.status }),
        ...(node.model_visible === undefined ? {} : { modelVisible: node.model_visible }),
        ...(node.source_seqs === undefined ? {} : { sourceSeqs: node.source_seqs }),
        ...(node.evidence_class === undefined ? {} : { evidenceClass: node.evidence_class }),
      }))
      const edges: InquiryEdgeInput[] = args.edges.map(edge => ({
        ...(edge.id === undefined ? {} : { id: edge.id }),
        fromId: edge.from_id,
        toId: edge.to_id,
        relation: edge.relation,
        ...(edge.label === undefined ? {} : { label: edge.label }),
        ...(edge.model_visible === undefined ? {} : { modelVisible: edge.model_visible }),
      }))
      const state = await retryModelStateMutation(ctx, session, args.expected_revision, revision => (
        ctx.researchContext.updateInquiry(session, revision, {
          nodes,
          edges,
          ...(frontier === undefined ? {} : { frontier }),
        })
      ))
      return stateValue(state)
    },
    presentCall: args => ({ card: 'generic', title: '更新探究地图', kind: 'other', rawInput: args.frontier_question ?? `${args.nodes.length} 张卡片` }),
  }))

  ctx.tools.register(defineTool({
    name: 'manage_idea_discussion',
    description: 'Automatically persist or resolve one material ambiguity. Open only when multiple plausible readings change the research object, success criterion, forbidden substitution, or a high-lock-in action; never for routine uncertainty.',
    parameters: {
      action: { type: 'string', required: true, enum: ['open', 'resolve'] },
      expected_revision: { type: 'number', required: true },
      question: { type: 'string', description: 'Open: the single concrete question to ask.' },
      interpretations: { type: 'array', items: { type: 'string' }, description: 'Open: two to four materially different readings.' },
      blocked_action: { type: 'string', description: 'Open: the one conflicting action to pause.' },
      discussion_id: { type: 'string', description: 'Resolve: current discussion id.' },
      resolution: { type: 'string', description: 'Resolve: the user\'s clarified meaning.' },
    },
    output: STATE_OUTPUT,
    async execute(args, exec) {
      const session = requireToolSession(exec)
      if (args.action === 'open') {
        if (args.question === undefined || args.blocked_action === undefined || (args.interpretations?.length ?? 0) < 2) {
          throw new TypeError('opening an Idea discussion requires one question, one blocked action, and at least two interpretations')
        }
        const state = await retryModelStateMutation(ctx, session, args.expected_revision, revision => (
          ctx.researchContext.raiseLeap(session, revision, {
            trigger: 'confirmed-boundary-conflict',
            question: args.question ?? '',
            whyHuman: '不同解释会改变 Idea 边界或实际动作，需由用户澄清。',
            candidates: args.interpretations ?? [],
            blockedAction: args.blocked_action ?? '',
            evidenceFrontierActions: [],
            evidenceNodeIds: [],
          })
        ))
        return stateValue(state)
      }
      if (args.discussion_id === undefined || args.resolution === undefined) {
        throw new TypeError('resolving an Idea discussion requires discussion_id and resolution')
      }
      const state = await ctx.researchContext.resolveLeap(session, args.discussion_id, {
        kind: 'clarify', text: args.resolution,
      })
      return stateValue(state)
    },
    presentCall: args => ({
      card: 'generic',
      title: args.action === 'open' ? '进入 Idea 讨论' : '结束 Idea 讨论',
      kind: 'other',
      rawInput: args.question ?? args.resolution,
    }),
  }))
}
