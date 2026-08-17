import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import GoalService from '@deepseek-ai/dsh-goal'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import ResearchContextAssembler from '@deepseek-ai/dsh-research-context'
import ResearchContextCompactionEngine from '@deepseek-ai/dsh-compaction-research-context'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

function completedSession(id = SessionId('research-context-compaction')): Session {
  const session = Session.create(id)
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '原始问题：上下文如何组装？' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: '原始回答：按完整 loop 建索引。' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

describe('research-context compaction provider', () => {
  it('replaces only the model surface while retaining raw source events', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    new ResearchContextAssembler(ctx, {
      kernel: '长期目标：科研方向不漂移。',
      frame: '按当前问题组装完整历史 loop。',
      maxViewChars: 4_000,
      recentTurns: 1,
      maxEvidenceTurns: 1,
    })
    const engine = new ResearchContextCompactionEngine(ctx)
    const session = completedSession()
    const rawUser = session.events.find(event => event.type === 'user/message')!

    await engine.compileSurface(session, [], null)

    expect(session.surface.nodes).toHaveLength(1)
    expect(session.events).toContain(rawUser)
    expect(session.deriveMessages()[0]!.content[0]).toMatchObject({
      type: 'text', text: expect.stringContaining('长期目标：科研方向不漂移。'),
    })
    expect(session.events.map(event => event.type)).toContain('compaction/summary')
    expect(session.events.map(event => event.type)).toContain('research/context-assembly')
  })

  it('skips closed Idea assembly and resumes it in the same Session', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const assembler = new ResearchContextAssembler(ctx, {
      kernel: '长期目标：科研方向不漂移。',
      frame: '按当前问题组装完整历史 loop。',
      maxViewChars: 4_000,
      recentTurns: 1,
      maxEvidenceTurns: 1,
    })
    const engine = new ResearchContextCompactionEngine(ctx)
    const session = completedSession(SessionId('research-context-toggle'))

    expect(assembler.setEnabled(session, false)).toBe(false)
    await expect(engine.compileSurface(session, [], null)).resolves.toBeUndefined()
    expect(session.events.map(event => event.type)).not.toContain('research/context-assembly')
    expect(session.events.map(event => event.type)).not.toContain('compaction/start')

    expect(assembler.setEnabled(session, true)).toBe(true)
    await expect(engine.compileSurface(session, [], null)).resolves.toContain('长期目标：科研方向不漂移。')
    expect(session.events.map(event => event.type)).toContain('research/context-assembly')
  })

  it('unloads both the compaction service and pre-step effect', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    new SessionStore(ctx)
    new AgentRegistry(ctx)
    new GoalService(ctx)
    await ctx.plugin(ResearchContextAssembler, {
      kernel: '研究目标', maxViewChars: 1_000, recentTurns: 1, maxEvidenceTurns: 1,
    })
    const fiber = await ctx.plugin(ResearchContextCompactionEngine)
    expect(ctx.compaction).toBeInstanceOf(ResearchContextCompactionEngine)
    await fiber.dispose()
    expect(ctx.compaction).toBeUndefined()
  })

  it('compiles a subagent surface from its root research session without creating child authority', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const sessions = new SessionStore(ctx)
    new AgentRegistry(ctx)
    new GoalService(ctx)
    new ResearchContextAssembler(ctx, {
      kernel: '长期目标：科研方向不漂移。',
      frame: '按子任务从父会话选择完整证据 loop。',
      maxViewChars: 8_000,
      recentTurns: 1,
      maxEvidenceTurns: 2,
    })
    const engine = new ResearchContextCompactionEngine(ctx)
    const parent = sessions.create(SessionId('worker-parent'))
    parent.append('turn/start', { turn: 1 })
    parent.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '调查 proper-lockfile 恢复路径。' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    parent.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: '锁拥有者和恢复路径必须一起保留。' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const child = sessions.create(SessionId('worker-child'), {
      meta: { parentSession: parent.id, origin: 'subagent', delegationDepth: 1 },
    })
    child.append('turn/start', { turn: 1 })
    child.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '核对 proper-lockfile。' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    await engine.compileSurface(child, [], null)

    const text = (child.deriveMessages()[0]!.content[0] as { text: string }).text
    expect(text.startsWith('长期目标：科研方向不漂移。')).toBe(true)
    expect(text).toContain('锁拥有者和恢复路径必须一起保留。')
    expect(text).toContain('<delegated-request>\n核对 proper-lockfile。')
    expect(child.events.some(event => event.type === 'research/context-inheritance')).toBe(true)
    expect(child.events.some(event => event.type === 'research/state-change')).toBe(false)
  })

  it('loads a cold parent through sessionPersistence.inspect without publishing or resuming it', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const sessions = new SessionStore(ctx)
    new AgentRegistry(ctx)
    new GoalService(ctx)
    new ResearchContextAssembler(ctx, {
      kernel: '冷父会话也必须继承长期研究目标。',
      maxViewChars: 8_000,
      recentTurns: 1,
      maxEvidenceTurns: 2,
    })
    const parent = completedSession(SessionId('cold-parent'))
    class ColdPersistence extends Service {
      constructor() { super(ctx, 'sessionPersistence') }
      inspect(id: SessionId): Promise<{ meta: typeof parent.header; events: typeof parent.events }> {
        if (id !== parent.id) return Promise.reject(new Error('missing'))
        return Promise.resolve({ meta: parent.header, events: parent.events })
      }
    }
    new ColdPersistence()
    const child = sessions.create(SessionId('cold-child'), {
      meta: { parentSession: parent.id, origin: 'subagent', delegationDepth: 1 },
    })
    child.append('turn/start', { turn: 1 })
    child.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '继续检查上下文组装。' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const engine = new ResearchContextCompactionEngine(ctx)

    await engine.compileSurface(child, [], null)

    expect((child.deriveMessages()[0]!.content[0] as { text: string }).text)
      .toContain('冷父会话也必须继承长期研究目标。')
    expect(sessions.get(parent.id)).toBeUndefined()
  })
})
