import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { KNOWN_SESSION_EVENT_TYPES, Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ResearchContextAssembler, { evaluateResearchEvidenceSupport } from '@deepseek-ai/dsh-research-context'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

const CONFIG = {
  kernel: '研究长期科研对话中的意图连续性，不能用局部工程完成冒充研究成功。',
  frame: '使用模型外账本和按当前问题选择的证据视图。',
  maxViewChars: 8_000,
  recentTurns: 1,
  maxEvidenceTurns: 2,
}

function appendTurn(session: Session, turn: number, user: string, assistant: string): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: user }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: assistant }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

describe('research-context assembler', () => {
  it('keeps every durable research event in the persistence vocabulary', () => {
    expect(KNOWN_SESSION_EVENT_TYPES.has('research/idea-selection')).toBe(true)
    expect(KNOWN_SESSION_EVENT_TYPES.has('research/state-change')).toBe(true)
  })

  it('selects matching evidence for an explicit task without carrying an unrelated recent loop', () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const assembler = new ResearchContextAssembler(ctx, CONFIG)
    const session = Session.create(SessionId('research-context-selection'))
    appendTurn(session, 1, '我们需要修复空会话绑定。', '空会话需要原子重绑 session id。')
    appendTurn(session, 2, '讨论网页配色。', '先不做 UI。')
    appendTurn(session, 3, '上下文召回必须保持证据来源。', '每个历史块记录 source seq。')

    const view = assembler.assemble(session, [createUserMessage({
      content: [{ type: 'text', text: '空会话为什么会换 session id？' }],
      source: { kind: 'user' },
    })])

    expect(view.text.startsWith(CONFIG.kernel)).toBe(true)
    expect(view.focusMode).toBe('task')
    expect(view.text).toContain('<historical-loop turn="1"')
    expect(view.text).not.toContain('<historical-loop turn="3"')
    expect(view.text).not.toContain('<historical-loop turn="2"')
    expect(view.omittedTurns).toContain(2)
  })

  it('keeps each pursuit version fixed while allowing a human-confirmed slow revision', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const assembler = new ResearchContextAssembler(ctx, CONFIG)
    const session = Session.create(SessionId('research-context-authority'))

    const initial = assembler.state(session)
    const proposed = await assembler.proposeAuthority(
      session,
      initial.revision,
      'frame',
      '新的候选路线。',
      { scope: 'adjust', basis: '新反馈否定旧路线；保留长期科学对象和成功判据。' },
    )
    expect(proposed.frame?.text).toBe(CONFIG.frame)
    expect(proposed.proposal?.text).toBe('新的候选路线。')
    expect(proposed.proposal?.evolution).toEqual({
      scope: 'adjust',
      basis: '新反馈否定旧路线；保留长期科学对象和成功判据。',
    })

    await expect(assembler.proposeAuthority(
      session,
      proposed.revision,
      'kernel',
      '不能覆盖尚未确认的路线提案。',
      { scope: 'pivot', basis: '第二份并发提案必须等待第一份被处理。' },
    )).rejects.toThrow(`research authority proposal already pending: ${proposed.proposal!.id}`)
    expect((await assembler.stateForRequest(session)).proposal?.id).toBe(proposed.proposal!.id)

    const confirmed = await assembler.confirmAuthority(session, proposed.proposal!.id)
    expect(confirmed.frame?.text).toBe('新的候选路线。')
    expect(confirmed.frame?.evolution?.scope).toBe('adjust')
    expect(confirmed.proposal).toBeUndefined()
    expect(session.events.filter(event => event.type === 'research/state-change')).toHaveLength(3)

    const parked = await assembler.updateWorking(session, confirmed.revision, {
      currentTask: '候选路线验证已完成。',
      unresolved: [],
      nextAction: '   ',
      evidenceRoots: [],
    })
    expect(parked.working?.nextAction).toBe('')

    const view = assembler.assemble(session, [])
    expect(view.text.startsWith(CONFIG.kernel)).toBe(true)
    expect(view.text).toContain('<research-context authority="session-persistent">')
    expect(view.text).not.toContain('state-revision=')
    expect(view.stateRevision).toBe(parked.revision)
  })

  it('projects a task-specific Idea Lens instead of exposing the complete Inquiry Map', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const assembler = new ResearchContextAssembler(ctx, CONFIG)
    const session = Session.create(SessionId('research-context-idea-lens'))
    appendTurn(session, 1, 'matched MDTA 需要多 seed 配对。', '至少三个 seed，并保留资源证据。')
    const sourceSeq = session.events.find(event => event.type === 'assistant/message')!.seq
    const initial = assembler.state(session)
    const state = await assembler.updateInquiry(session, initial.revision, {
      nodes: [
        { id: 'claim-main', kind: 'claim', text: 'EqOp 编译器在 matched 资源下胜出。', sourceSeqs: [sourceSeq] },
        { id: 'need-match', kind: 'evidence-requirement', text: '完成 matched MDTA 多 seed 对比。', evidenceClass: 'matched-baseline' },
        { id: 'rival-route', kind: 'rival', text: '性能可能来自训练配方而非编译器。' },
        { id: 'private-note', kind: 'hypothesis', text: '白板私有假设绝不能进入模型。', modelVisible: false },
      ],
      edges: [
        { id: 'edge-need', fromId: 'need-match', toId: 'claim-main', relation: 'supports' },
        { id: 'edge-private', fromId: 'private-note', toId: 'claim-main', relation: 'related', modelVisible: false },
      ],
      frontier: {
        question: 'matched MDTA 配对是否改变胜负？',
        changesActionWhen: '任一 held source 上优势反转。',
        evidenceNeeded: '同初始化、同预算、至少三个 seed。',
        nodeIds: ['claim-main', 'need-match'],
      },
    })

    const view = assembler.assemble(session, [createUserMessage({
      content: [{ type: 'text', text: '整理论文里的 matched baseline 和消融证据。' }], source: { kind: 'user' },
    })])

    expect(state.inquiry?.nodes).toHaveLength(4)
    expect(view.ideaLens).toBe('paper')
    expect(view.text).toContain('<idea-lens mode="paper"')
    expect(view.text).toContain('matched-baseline')
    expect(view.text).toContain('relation="supports"')
    expect(view.text).not.toContain('白板私有假设')
    expect(view.components.lensTokens).toBeGreaterThan(0)
    expect(view.sourceSeqs).toContain(sourceSeq)
  })

  it('keeps a pending mechanism leap non-blocking and records the human choice', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const assembler = new ResearchContextAssembler(ctx, CONFIG)
    const session = Session.create(SessionId('research-context-leap'))
    const initial = assembler.state(session)
    const pending = await assembler.raiseLeap(session, initial.revision, {
      trigger: 'confirmed-boundary-conflict',
      question: '是否把 held-source 不变性升级为确认边界？',
      whyHuman: '这会改变最终科学主张。',
      candidates: ['升级为确认边界', '保持为待检验假设'],
      blockedAction: '改写 Idea Seed',
      evidenceFrontierActions: ['完成 matched 多 seed 对比', '复核 held-source 反转'],
    })
    const view = assembler.assemble(session, [createUserMessage({
      content: [{ type: 'text', text: '继续做' }], source: { kind: 'user' },
    })], { id: 'goal-leap', objective: '闭合 EqOp 科学证据', phase: 'active', roundsStarted: 3 })

    expect(view.text).toContain('<leap-pending')
    expect(view.text).toContain('autonomous-evidence-frontier: 完成 matched 多 seed 对比')
    expect(view.text).toContain('<active-goal id="goal-leap"')
    const resolved = await assembler.resolveLeap(session, pending.inquiry!.leap!.id, { kind: 'accept', candidateIndex: 2 })
    const decision = resolved.inquiry!.nodes.find(node => node.origin === 'human')!
    expect(decision.text).toContain('保持为待检验假设')
    await expect(assembler.updateInquiry(session, resolved.revision, {
      nodes: [{ id: decision.id, kind: 'decision', text: '模型覆盖人类决定' }], edges: [],
    })).rejects.toThrow('human inquiry node is immutable')
  })

  it('clones legacy state once and keeps later Idea revisions local to each Session', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const assembler = new ResearchContextAssembler(ctx, CONFIG)
    const first = Session.create(SessionId('research-session-owned-first'))
    const second = Session.create(SessionId('research-session-owned-second'))
    const legacy = {
      revision: 4,
      kernel: { version: 2, text: '旧共享 Idea', confirmedAt: 1 },
      updatedAt: 1,
    }
    assembler.registerLegacyStateProvider({ id: 'legacy-test', read: () => legacy })

    const firstSeed = await assembler.stateForRequest(first)
    const secondSeed = await assembler.stateForRequest(second)
    await assembler.updateAuthority(first, firstSeed.revision, 'kernel', '第一个对话自己的 Idea', {
      scope: 'adjust', basis: '用户明确调整；第二个对话保持原状。',
    })

    expect((await assembler.stateForRequest(first)).kernel.text).toBe('第一个对话自己的 Idea')
    expect(await assembler.stateForRequest(second)).toEqual(secondSeed)
    expect(first.events.filter(event => event.type === 'research/state-change').map(event => event.data.operation)).toEqual([
      'migrate-session-idea', 'update-authority',
    ])
  })

  it('persists material ambiguity as a discussion and blocks Idea mutation until clarification', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const assembler = new ResearchContextAssembler(ctx, CONFIG)
    const session = Session.create(SessionId('research-automatic-discussion'))
    const initial = assembler.state(session)
    const pending = await assembler.raiseLeap(session, initial.revision, {
      trigger: 'confirmed-boundary-conflict',
      question: '“完成 EqOp”是完成当前编译器，还是闭合整项研究？',
      whyHuman: '两种解释会改变成功标准。',
      candidates: ['只完成当前编译器', '闭合整项 EqOp 研究'],
      blockedAction: '重写 Idea Seed',
      evidenceFrontierActions: [],
    })

    await expect(assembler.updateAuthority(session, pending.revision, 'kernel', '错误地直接改写'))
      .rejects.toThrow('resolve pending Idea discussion before updating Idea')
    const clarified = await assembler.resolveLeap(session, pending.inquiry!.leap!.id, {
      kind: 'clarify', text: '闭合整项 EqOp 研究；编译器只是当前瓶颈。',
    })
    const updated = await assembler.updateAuthority(session, clarified.revision, 'kernel', '完成 EqOp 整项研究。', {
      scope: 'clarify', basis: '用户明确了整项研究与当前编译器的层级。',
    })
    expect(updated.kernel.text).toBe('完成 EqOp 整项研究。')
    expect(updated.inquiry?.leap?.status).toBe('accepted')
  })

  it('keeps human detective-board cards private until explicitly shown to the model', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const assembler = new ResearchContextAssembler(ctx, CONFIG)
    const session = Session.create(SessionId('research-context-board-visibility'))
    const hidden = await assembler.upsertHumanBoardNode(session, {
      kind: 'counterevidence', text: '人工白板：held source 出现反转。',
    })
    const card = hidden.inquiry!.nodes[0]!
    const privateView = assembler.assemble(session, [createUserMessage({
      content: [{ type: 'text', text: '审计 held source 证据。' }], source: { kind: 'user' },
    })])
    expect(card.modelVisible).toBe(false)
    expect(privateView.text).not.toContain('人工白板')

    await assembler.setBoardVisibility(session, card.id, true)
    const visibleView = assembler.assemble(session, [createUserMessage({
      content: [{ type: 'text', text: '审计 held source 证据。' }], source: { kind: 'user' },
    })])
    expect(visibleView.text).toContain('人工白板')
  })

  it('bounds the current Inquiry Map while preserving removed model nodes in append-only state events', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const assembler = new ResearchContextAssembler(ctx, { ...CONFIG, maxInquiryNodes: 8 })
    const session = Session.create(SessionId('research-context-bounded-inquiry'))
    const initial = assembler.state(session)
    const first = await assembler.updateInquiry(session, initial.revision, {
      nodes: Array.from({ length: 8 }, (_, index) => ({
        id: `old-${index}`, kind: 'hypothesis' as const, text: `旧假设 ${index}`,
      })),
      edges: [],
    })
    const second = await assembler.updateInquiry(session, first.revision, {
      nodes: Array.from({ length: 4 }, (_, index) => ({
        id: `new-${index}`, kind: 'evidence' as const, text: `新证据 ${index}`,
      })),
      edges: [],
    })

    expect(second.inquiry?.nodes).toHaveLength(8)
    expect(second.inquiry?.nodes.some(node => node.id === 'old-0')).toBe(false)
    const snapshots = session.events
      .filter(event => event.type === 'research/state-change')
      .map(event => event.data.state)
    expect(snapshots.some(state => state.inquiry?.nodes.some(node => node.id === 'old-0'))).toBe(true)
  })

  it('replays pre-removal authority hashes by normalizing them to version-only state', () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const assembler = new ResearchContextAssembler(ctx, CONFIG)
    const session = Session.create(SessionId('research-context-legacy-hash'))
    session.append('research/state-change', {
      version: 1,
      operation: 'initialize',
      state: {
        revision: 1,
        kernel: { version: 1, text: CONFIG.kernel, hash: 'legacy', confirmedAt: 1 },
        updatedAt: 1,
      },
    } as never)

    const state = assembler.state(session)
    expect(state.kernel).toEqual({ version: 1, text: CONFIG.kernel, confirmedAt: 1 })
    expect('hash' in state.kernel).toBe(false)
  })

  it('uses Working State evidence roots to resolve an otherwise ambiguous continuation', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const assembler = new ResearchContextAssembler(ctx, { ...CONFIG, recentTurns: 1 })
    const session = Session.create(SessionId('research-context-continue'))
    appendTurn(session, 1, '修复 Windows proper-lockfile 锁冲突。', '将锁拥有者和恢复路径记录为证据。')
    appendTurn(session, 2, '讨论不相关的终端配色。', '暂不处理 UI。')
    const state = assembler.state(session)
    await assembler.updateWorking(session, state.revision, {
      currentTask: '继续处理锁冲突',
      unresolved: ['需要恢复第一个 loop 的锁证据'],
      nextAction: '检查恢复路径',
      evidenceRoots: [1],
    })

    const view = assembler.assemble(session, [createUserMessage({
      content: [{ type: 'text', text: '继续做' }], source: { kind: 'user' },
    })], { id: 'goal-lock', objective: '恢复可靠的长期研究循环', phase: 'active', roundsStarted: 4 })

    expect(view.selectedTurns).toEqual([1, 2])
    expect(view.focusMode).toBe('continue')
    expect(view.text).toContain('<historical-loop turn="1"')
    expect(view.text).toContain('<active-goal id="goal-lock"')
    expect(view.text).toContain('<task-idea-bridge authority="model-maintained" status="provisional">')
    expect(view.text.indexOf('<research-frame>')).toBeLessThan(view.text.indexOf('<task-idea-bridge'))
    expect(view.text).not.toContain('<working-state')
    expect(view.sourceSeqs).toContain(session.events.filter(event => event.type === 'research/state-change').at(-1)!.seq)
  })

  it('lets an explicit task drive retrieval while exposing old route state only as provisional', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const assembler = new ResearchContextAssembler(ctx, { ...CONFIG, recentTurns: 1 })
    const session = Session.create(SessionId('research-context-explicit-task'))
    appendTurn(session, 1, '继续优化 DH9 路由。', 'DH9 路由实验仍在排队。')
    appendTurn(session, 2, '记录最终编译器的资源证据。', '最终编译器需要 matched 资源闭环。')
    const state = assembler.state(session)
    await assembler.updateWorking(session, state.revision, {
      currentTask: '把 DH9 固化为最终路线', unresolved: ['DH9 routing'], nextAction: '继续 DH9', evidenceRoots: [1],
    })

    const view = assembler.assemble(session, [createUserMessage({
      content: [{ type: 'text', text: '检查最终编译器的资源证据。' }], source: { kind: 'user' },
    })], { id: 'goal-dh9', objective: '推进 DH9', phase: 'active', roundsStarted: 2 })

    expect(view.focusMode).toBe('task')
    expect(view.selectedTurns).toEqual([2])
    expect(view.text).toContain('status="provisional"')
    expect(view.text).toContain('authority="execution-lease"')
    expect(view.text).toContain('把 DH9 固化为最终路线')
    expect(view.text.indexOf('<research-frame>')).toBeLessThan(view.text.indexOf('<task-idea-bridge'))
  })

  it('drops rejected route, Goal, roots, and recent baggage on an explicit reframe', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const assembler = new ResearchContextAssembler(ctx, { ...CONFIG, recentTurns: 2 })
    const session = Session.create(SessionId('research-context-eqop-reframe'))
    appendTurn(session, 1, '把 DH9 设为最终编译器。', '继续 DH9 routing。')
    appendTurn(session, 2, '把 MSF9 设为当前目标。', '继续 MSF9 删减。')
    const state = assembler.state(session)
    await assembler.updateWorking(session, state.revision, {
      currentTask: '固化 DH9/MSF9', unresolved: ['继续旧路线'], nextAction: '跑 routing', evidenceRoots: [1, 2],
    })

    const view = assembler.assemble(session, [createUserMessage({
      content: [{ type: 'text', text: 'MSF9 不是当前目标；不对，核心是完成 EqOp。' }], source: { kind: 'user' },
    })], { id: 'goal-msf9', objective: '完成 MSF9', phase: 'active', roundsStarted: 7 })

    expect(view.focusMode).toBe('reframe')
    expect(view.selectedTurns).toEqual([])
    expect(view.text).not.toContain('<task-idea-bridge')
    expect(view.text).not.toContain('<active-goal')
    expect(view.text).not.toContain('DH9')
    expect(view.text).not.toContain('MSF9')
  })

  it('does not retrieve a route that is only named to reject it', () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const assembler = new ResearchContextAssembler(ctx, CONFIG)
    const session = Session.create(SessionId('research-context-negative-route-only'))
    appendTurn(session, 1, '继续推进 MSF9。', 'MSF9 是当前路线。')
    let observedQuery: ReadonlySet<string> | undefined
    assembler.registerRetrievalProvider({
      id: 'observe-negative-route-query',
      score: (query) => {
        observedQuery = new Set(query)
        return 0
      },
    })

    const view = assembler.assemble(session, [createUserMessage({
      content: [{ type: 'text', text: 'MSF9 不是当前目标。' }], source: { kind: 'user' },
    })])

    expect(view.focusMode).toBe('reframe')
    expect([...observedQuery ?? []]).toEqual([])
    expect(view.selectedTurns).toEqual([])
    expect(view.text).not.toContain('MSF9')
  })

  it('does not mistake an incomplete older turn for a new Session first request', () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const assembler = new ResearchContextAssembler(ctx, CONFIG)
    const session = Session.create(SessionId('research-context-incomplete-prior-turn'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '旧请求仍未完成。' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const view = assembler.assemble(session, [createUserMessage({
      content: [{ type: 'text', text: '检查最终编译器证据。' }], source: { kind: 'user' },
    })])

    expect(view.focusMode).toBe('task')
  })

  it('gives a new session explicit request a clean focus despite project Working State', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const assembler = new ResearchContextAssembler(ctx, CONFIG)
    const session = Session.create(SessionId('research-context-fresh-focus'))
    const state = assembler.state(session)
    await assembler.updateWorking(session, state.revision, {
      currentTask: '旧 DH9 路线', unresolved: ['旧路线未完成'], nextAction: '继续旧实验', evidenceRoots: [9],
    })

    const view = assembler.assemble(session, [createUserMessage({
      content: [{ type: 'text', text: '完成 EqOp；当前瓶颈是找到最终编译器。' }], source: { kind: 'user' },
    })], { id: 'goal-old', objective: '继续旧实验', phase: 'active', roundsStarted: 1 })

    expect(view.focusMode).toBe('reframe')
    expect(view.text.startsWith(CONFIG.kernel)).toBe(true)
    expect(view.text).toContain('<objective-ladder focus-mode="reframe">')
    expect(view.text).toContain('<research-frame>')
    expect(view.text).not.toContain('旧 DH9 路线')
    expect(view.text).not.toContain('<active-goal')
  })

  it('fails closed when an always-present Kernel exceeds its attention budget', () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const assembler = new ResearchContextAssembler(ctx, { ...CONFIG, maxKernelTokens: 2 })
    const session = Session.create(SessionId('research-context-kernel-attention-budget'))

    expect(() => assembler.assemble(session, [])).toThrow(/kernel.*attention budget/)
  })

  it('fails closed when confirmed authority exceeds one twentieth of the known route window', () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const assembler = new ResearchContextAssembler(ctx, {
      ...CONFIG,
      kernel: '不可替代的研究目标。'.repeat(200),
      maxViewChars: 20_000,
      maxKernelTokens: 20_000,
    })
    const session = Session.create(SessionId('research-context-budget'))
    session.append('request/context', { provider: 'mock', model: 'mock', contextWindow: 1_000 })
    expect(() => assembler.assemble(session, [])).toThrow(/authority budget/)
  })

  it('rebuilds authority and loop locators from the raw log after a cold service restart', async () => {
    const session = Session.create(SessionId('research-context-restart'))
    const firstCtx = new Context()
    new TokenMeter(firstCtx)
    const first = new ResearchContextAssembler(firstCtx, CONFIG)
    appendTurn(session, 1, '记录恢复后仍需保留的 proper-lockfile 证据。', '证据位于原始 Session loop。')
    const initial = first.state(session)
    await first.updateWorking(session, initial.revision, {
      currentTask: '恢复锁证据', unresolved: [], nextAction: '继续验证', evidenceRoots: [1],
    })

    const resumedCtx = new Context()
    new TokenMeter(resumedCtx)
    const resumed = new ResearchContextAssembler(resumedCtx, CONFIG)
    const view = resumed.assemble(session, [createUserMessage({
      content: [{ type: 'text', text: '继续做' }], source: { kind: 'user' },
    })])

    expect(resumed.state(session).working?.evidenceRoots).toEqual([1])
    expect(view.text).toContain('proper-lockfile')
    expect(view.selectedTurns).toEqual([1])
  })

  it('bootstraps a new session from a source-addressed handoff, then stops carrying unrelated bridges', () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const assembler = new ResearchContextAssembler(ctx, CONFIG)
    const session = Session.create(SessionId('research-context-handoff'))
    const before = assembler.state(session)
    const imported = assembler.importHandoff(session, {
      sourceHarness: 'codex',
      sourceSessionId: 'codex:current-thread',
      projectPath: 'D:/research/pi-idea',
      anchors: ['message:user-intent', 'session:codex:current-thread'],
      text: 'target: 迁移当前上下文\npending-or-blocked: 验证图片粘贴',
    })

    const bootstrap = assembler.assemble(session, [createUserMessage({
      content: [{ type: 'text', text: '继续做' }], source: { kind: 'user' },
    })])
    expect(bootstrap.text).toContain('<handoff-bridge source-harness="codex"')
    expect(bootstrap.text).toContain('迁移当前上下文')
    expect(bootstrap.sourceSeqs).toContain(imported.importEventSeq)
    expect(bootstrap.selectedLocators).toContain(`handoff:${imported.id}`)
    expect(assembler.state(session)).toEqual(before)

    appendTurn(session, 1, '讨论无关的终端颜色。', '保持默认颜色。')
    const later = assembler.assemble(session, [createUserMessage({
      content: [{ type: 'text', text: '终端颜色如何？' }], source: { kind: 'user' },
    })])
    expect(later.text).not.toContain('<handoff-bridge')
  })

  it('restores an oversized loop as causal dialogue and tool-evidence locators', () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const assembler = new ResearchContextAssembler(ctx, { ...CONFIG, maxViewChars: 1_200, maxViewTokens: 5_000 })
    const session = Session.create(SessionId('research-context-long-turn'))
    const callId = CallId('long-turn-call')
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '查清 proper-lockfile 的真实拥有者。' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1, step: 1, message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'pwsh', arguments: '{"path":"lock"}' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'proper-lockfile owner PID 4242 已验证。' }], isError: false }),
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1, step: 2, message: createMessage({
        role: 'assistant', content: [{ type: 'text', text: `无关长输出 ${'x'.repeat(4_000)}` }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const view = assembler.assemble(session, [createUserMessage({
      content: [{ type: 'text', text: 'proper-lockfile owner 是谁？' }], source: { kind: 'user' },
    })])

    expect(view.partialTurns).toEqual([1])
    expect(view.text).toContain('mode="partial"')
    expect(view.text).toContain('<parent-bridge')
    expect(view.text).toContain('<tool-evidence')
    expect(view.text).toContain('PID 4242')
    expect(view.text).not.toContain('无关长输出')
    expect(view.assemblyMicros).toBeLessThan(100_000)
  })

  it('keeps multi-megabyte tool-history retrieval below the hot-path budget', () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const assembler = new ResearchContextAssembler(ctx, {
      ...CONFIG, maxViewChars: 12_000, maxViewTokens: 12_000, recentTurns: 1,
    })
    const session = Session.create(SessionId('research-context-realistic-tool-history'))
    for (let turn = 1; turn <= 15; turn += 1) {
      const callId = CallId(`large-tool-${turn}`)
      session.append('turn/start', { turn })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `检查第 ${turn} 轮实验。` }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('tool/result', {
        turn, step: 1,
        message: createToolResultMessage({
          callId,
          content: [{
            type: 'text',
            text: Array.from({ length: 4_000 }, (_, index) => `artifact_${turn}_${index}`).join(' '),
          }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
      session.append('assistant/message', {
        turn, step: 2, message: createMessage({
          role: 'assistant', content: [{
            type: 'text',
            text: turn === 3 ? 'artifact_3_3999 已定位到第三轮工具证据。' : `第 ${turn} 轮证据已定位。`,
          }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        }),
      }, { surfaceOp: 'append' })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    const request = [
      '恢复 artifact_3_3999 的完整父 loop。',
      ...Array.from({ length: 300 }, (_, index) => `query_${index}`),
    ].join(' ')
    const cold = assembler.assemble(session, [createUserMessage({
      content: [{ type: 'text', text: request }], source: { kind: 'user' },
    })])
    const warm = assembler.assemble(session, [createUserMessage({
      content: [{ type: 'text', text: request }], source: { kind: 'user' },
    })])

    if (process.env.DSH_CONTEXT_BENCHMARK === '1') {
      process.stdout.write(`research-context benchmark: cold=${cold.assemblyMicros}us warm=${warm.assemblyMicros}us events=${cold.scannedEvents}\n`)
    }

    expect(cold.selectedTurns).toContain(3)
    expect(cold.assemblyMicros).toBeLessThan(500_000)
    expect(warm.assemblyMicros).toBeLessThan(100_000)
  })

  it('prewarms a live Session locator index in yielded batches before the request path', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const sessions = new SessionStore(ctx)
    const assembler = new ResearchContextAssembler(ctx, {
      ...CONFIG, maxViewChars: 12_000, maxViewTokens: 12_000, recentTurns: 1,
    })
    const session = sessions.create(SessionId('research-context-prewarm'))
    for (let turn = 1; turn <= 15; turn += 1) {
      const callId = CallId(`prewarm-tool-${turn}`)
      session.append('turn/start', { turn })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `检查第 ${turn} 轮。` }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('tool/result', {
        turn, step: 1,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text: Array.from({ length: 4_000 }, (_, index) => `prewarm_${turn}_${index}`).join(' ') }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
      session.append('assistant/message', {
        turn, step: 2,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: turn === 3 ? 'prewarm_3_3999 已定位。' : `第 ${turn} 轮已定位。` }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        }),
      }, { surfaceOp: 'append' })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }

    for (let yielded = 0; yielded < 8; yielded += 1) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    const view = assembler.assemble(session, [createUserMessage({
      content: [{ type: 'text', text: '恢复 prewarm_3_3999。' }], source: { kind: 'user' },
    })])

    if (process.env.DSH_CONTEXT_BENCHMARK === '1') {
      process.stdout.write(`research-context prewarm benchmark: request=${view.assemblyMicros}us events=${view.scannedEvents}\n`)
    }

    expect(view.selectedTurns).toContain(3)
    expect(view.assemblyMicros).toBeLessThan(100_000)
    await ctx.fiber.dispose()
  })

  it('supports terminology aliases and a replaceable synchronous retrieval provider', () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const assembler = new ResearchContextAssembler(ctx, {
      ...CONFIG,
      recentTurns: 0,
      retrievalAliases: { checkpoint: ['snapshot'] },
    })
    const session = Session.create(SessionId('research-context-retrieval-provider'))
    appendTurn(session, 1, '保存 snapshot 恢复点。', '恢复点已经落盘。')
    appendTurn(session, 2, '记录完全不同的中文证据。', '玄武门证据已经落盘。')
    const dispose = assembler.registerRetrievalProvider({
      id: 'test-semantic-provider',
      score: (query, candidate) => query.has('resume') && candidate.text.includes('玄武门') ? 50 : 0,
    })

    const aliasView = assembler.assemble(session, [createUserMessage({
      content: [{ type: 'text', text: 'checkpoint 在哪里？' }], source: { kind: 'user' },
    })])
    const providerView = assembler.assemble(session, [createUserMessage({
      content: [{ type: 'text', text: 'resume' }], source: { kind: 'user' },
    })])
    dispose()

    expect(aliasView.selectedTurns).toContain(1)
    expect(providerView.selectedTurns).toContain(2)
  })

  it('projects a bounded manifest history and child results as non-authority evidence candidates', async () => {
    const ctx = new Context()
    new SessionProjectionRegistry(ctx)
    new TokenMeter(ctx)
    const sessions = new SessionStore(ctx)
    await ctx.plugin(ResearchContextAssembler, CONFIG)
    const assembler = ctx.researchContext
    const session = sessions.create(SessionId('research-context-history'))
    appendTurn(session, 1, '保留一次 Manifest。', '完成。')
    const view = assembler.assemble(session, [])
    assembler.recordAssembly(session, view)
    assembler.recordAssembly(session, view)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Background subagent child-7 reported: VERIFIED_RESULT' }],
      source: { kind: 'subagent-report', form: 'relay', senderSessionId: SessionId('child-7') } as never,
    }), { surfaceOp: 'append' })

    const values = ctx.sessionProjections.snapshot(session).values
    expect(values.researchContext?.focusMode).toBe('task')
    expect(values.researchContextHistory).toHaveLength(2)
    expect(values.researchContextHistory?.map(item => item.focusMode)).toEqual(['task', 'task'])
    expect(values.researchEvidenceCandidates).toMatchObject([{
      sourceSessionId: 'child-7', sourceKind: 'report', text: expect.stringContaining('VERIFIED_RESULT'),
    }])
    expect(assembler.state(session).revision).toBe(1)
  })

  it('projects imported handoffs as bounded non-authority evidence candidates', async () => {
    const ctx = new Context()
    new SessionProjectionRegistry(ctx)
    new TokenMeter(ctx)
    const sessions = new SessionStore(ctx)
    await ctx.plugin(ResearchContextAssembler, CONFIG)
    const session = sessions.create(SessionId('research-context-handoff-projection'))
    const imported = ctx.researchContext.importHandoff(session, {
      sourceHarness: 'obelisk', sourceSessionId: 'codex:abc', anchors: ['uuid:1'], text: 'pending: verify live state',
    })

    const values = ctx.sessionProjections.snapshot(session).values
    expect(values.researchHandoffs).toMatchObject([{
      id: imported.id, sourceHarness: 'obelisk', sourceSessionId: 'codex:abc', importEventSeq: imported.importEventSeq,
    }])
    expect(values.researchEvidenceCandidates).toMatchObject([{
      id: imported.id, sourceSessionId: 'codex:abc', sourceKind: 'handoff', text: 'pending: verify live state',
    }])
    expect(ctx.researchContext.state(session).revision).toBe(1)
  })

  it('assembles a child view from selected parent evidence plus child-local complete loops', () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const sessions = new SessionStore(ctx)
    const assembler = new ResearchContextAssembler(ctx, CONFIG)
    const parent = sessions.create(SessionId('research-parent'))
    appendTurn(parent, 1, '调查 proper-lockfile 的恢复问题。', '保留锁拥有者和恢复路径作为证据。')
    appendTurn(parent, 2, '讨论终端配色。', '这与锁恢复无关。')
    const child = sessions.create(SessionId('research-child'), {
      meta: { parentSession: parent.id, origin: 'subagent', delegationDepth: 1 },
    })
    appendTurn(child, 1, '核对锁恢复路径。', '发现恢复路径需要验证拥有者。')
    child.append('turn/start', { turn: 2 })
    child.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '继续核对 proper-lockfile' }], source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id },
    }), { surfaceOp: 'append' })

    const parentView = assembler.assemble(parent, [createUserMessage({
      content: [{ type: 'text', text: '继续核对 proper-lockfile' }], source: { kind: 'user' },
    })])
    const worker = assembler.assembleWorker(child, child.deriveMessages(), String(parent.id), parentView)
    assembler.recordInheritance(child, worker)

    expect(worker.text.startsWith(CONFIG.kernel)).toBe(true)
    expect(worker.text).toContain('<historical-loop turn="1"')
    expect(worker.text).toContain('<worker-loop turn="1"')
    expect(worker.text).toContain('<delegated-request>\n继续核对 proper-lockfile')
    expect(worker.manifest.parentSessionId).toBe(parent.id)
    expect(worker.manifest.workerSelectedTurns).toEqual([1])
    expect(child.events.some(event => event.type === 'research/state-change')).toBe(false)
    expect(child.events.at(-1)?.type).toBe('research/context-inheritance')
  })

  it('does not inherit an older child loop merely because it is recent among old candidates', () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const sessions = new SessionStore(ctx)
    const assembler = new ResearchContextAssembler(ctx, CONFIG)
    const parent = sessions.create(SessionId('research-worker-filter-parent'))
    appendTurn(parent, 1, '追踪 proper-lockfile 恢复。', '保留锁证据。')
    const child = sessions.create(SessionId('research-worker-filter-child'), {
      meta: { parentSession: parent.id, origin: 'subagent', delegationDepth: 1 },
    })
    appendTurn(child, 1, '核对 proper-lockfile owner。', 'owner 仍需验证。')
    appendTurn(child, 2, '讨论网页颜色。', '选择紫色。')
    appendTurn(child, 3, '检查终端字体。', '暂时保留默认字体。')
    child.append('turn/start', { turn: 4 })
    child.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '继续核对 proper-lockfile owner' }],
      source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id },
    }), { surfaceOp: 'append' })

    const parentView = assembler.assemble(parent, [createUserMessage({
      content: [{ type: 'text', text: '继续核对 proper-lockfile owner' }], source: { kind: 'user' },
    })])
    const worker = assembler.assembleWorker(child, child.deriveMessages(), String(parent.id), parentView)

    expect(worker.text).toContain('<worker-loop turn="1"')
    expect(worker.text).not.toContain('<worker-loop turn="2"')
    expect(worker.text).toContain('<worker-loop turn="3"')
  })

  it('does not create a new revision for an identical Working State', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const assembler = new ResearchContextAssembler(ctx, CONFIG)
    const session = Session.create(SessionId('research-working-noop'))
    const initial = assembler.state(session)
    const input = {
      currentTask: '验证最小上下文组装。',
      unresolved: ['仍需长对话实测。'],
      nextAction: '运行定向回归。',
      evidenceRoots: [3, 1, 3],
    }
    const first = await assembler.updateWorking(session, initial.revision, input)
    const eventCount = session.events.filter(event => event.type === 'research/state-change').length
    const repeated = await assembler.updateWorking(session, first.revision, input)

    expect(repeated.revision).toBe(first.revision)
    expect(repeated.working?.revision).toBe(first.working?.revision)
    expect(session.events.filter(event => event.type === 'research/state-change')).toHaveLength(eventCount)
  })

  it('keeps the confirmed Seed and Frame as a stable cache prefix across Working State changes', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const assembler = new ResearchContextAssembler(ctx, CONFIG)
    const session = Session.create(SessionId('research-stable-prefix'))
    const initial = assembler.state(session)
    const firstState = await assembler.updateWorking(session, initial.revision, {
      currentTask: '第一阶段。', unresolved: [], nextAction: '执行第一步。', evidenceRoots: [],
    })
    const first = assembler.assemble(session, [])
    await assembler.updateWorking(session, firstState.revision, {
      currentTask: '第二阶段。', unresolved: ['等待结果。'], nextAction: '执行第二步。', evidenceRoots: [],
    })
    const second = assembler.assemble(session, [])
    const frameEnd = first.text.indexOf('</research-frame>') + '</research-frame>'.length
    const stablePrefix = first.text.slice(0, frameEnd)

    expect(stablePrefix).toContain(CONFIG.kernel)
    expect(stablePrefix).toContain(CONFIG.frame)
    expect(second.text.startsWith(stablePrefix)).toBe(true)
    expect(first.text).not.toContain('state-revision=')
  })

  it('uses source-backed topology as lightweight guidance without claiming evidence closure', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const assembler = new ResearchContextAssembler(ctx, CONFIG)
    const session = Session.create(SessionId('research-evidence-navigation'))
    appendTurn(session, 1, '运行 matched 对比。', '观察到候选优于基线。')
    const sourceSeq = session.events.find(event => event.type === 'assistant/message')!.seq
    const initial = assembler.state(session)
    const open = await assembler.updateInquiry(session, initial.revision, {
      nodes: [{
        id: 'need-task-effect', kind: 'evidence-requirement', text: '确认实践任务效果。',
        status: 'supported', evidenceClass: 'task-effect',
      }],
    })
    expect(evaluateResearchEvidenceSupport(open.inquiry).status).toBe('open')

    const supported = await assembler.updateInquiry(session, open.revision, {
      nodes: [{ id: 'result-one', kind: 'evidence', text: '一次配对结果为正。', sourceSeqs: [sourceSeq] }],
      edges: [{ id: 'supports-task', fromId: 'result-one', toId: 'need-task-effect', relation: 'supports' }],
    })
    expect(evaluateResearchEvidenceSupport(supported.inquiry).status).toBe('candidate')
    const view = assembler.assemble(session, [])
    expect(view.text).toContain('closure="not-assessed"')
  })

  it('unregisters the service and its indexes with the Cordis fiber', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const fiber = await ctx.plugin(ResearchContextAssembler, CONFIG)
    expect(ctx.researchContext).toBeInstanceOf(ResearchContextAssembler)
    await fiber.dispose()
    expect(ctx.researchContext).toBeUndefined()
  })
})
