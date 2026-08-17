import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as controls from '../src/index.ts'

function agentFor(ctx: Context): Agent {
  const session = ctx.sessions.create(SessionId('research-controls-test'))
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  let status: AgentStatus = 'idle'
  return {
    id: session.id, options: {}, session, inbox, ctx: new Context(),
    get status() { return status }, send: () => {}, followup: () => {}, steer: () => {}, inject: () => {},
    cancel() { status = 'idle' }, runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
}

describe('research commands', () => {
  it('uses /idea as the per-Session view/edit surface and keeps /research visibility compatible', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionStore)
    let state = { revision: 1, kernel: { version: 1, text: '旧 Idea', confirmedAt: 1 }, updatedAt: 1 }
    const research = {
      stateForRequest: vi.fn(async () => state),
      setEnabled: vi.fn(),
      updateAuthority: vi.fn(async (_session, _revision, target, text) => {
        state = {
          ...state,
          revision: state.revision + 1,
          kernel: target === 'kernel' ? { version: 2, text, confirmedAt: 2 } : state.kernel,
          ...(target === 'frame' ? { frame: { version: 1, text, confirmedAt: 2 } } : {}),
          updatedAt: 2,
        } as typeof state
        return state
      }),
      resolveLeap: vi.fn(),
    }
    ctx.provide('researchContext', research as never)
    ctx.provide('systemPrompt', { section: vi.fn() } as never)
    ctx.provide('fs', {} as never)
    ctx.provide('tools', { register: vi.fn() } as never)
    controls.apply(ctx)
    const agent = agentFor(ctx)
    const signal = new AbortController().signal

    expect((await ctx.commands.execute(agent, '/idea', signal))?.result).toMatchObject({
      kind: 'success', text: expect.stringContaining('旧 Idea'),
    })
    expect((await ctx.commands.execute(agent, '/idea set 完成 EqOp，并以实践证据校正方向。', signal))?.result).toMatchObject({
      kind: 'success', text: expect.stringContaining('完成 EqOp'),
    })
    expect(research.updateAuthority).toHaveBeenCalledWith(
      agent.session, 1, 'kernel', '完成 EqOp，并以实践证据校正方向。', expect.objectContaining({ scope: 'adjust' }),
    )

    await expect((await ctx.commands.execute(agent, '/research off', signal))?.result).toEqual({
      kind: 'success', text: '当前对话已关闭 Idea；后续请求不再组装研究上下文。',
    })
    expect(research.setEnabled).toHaveBeenCalledWith(agent.session, false)
  })

  it('exposes autonomous Idea maintenance and one automatic discussion tool instead of proposal tools', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionStore)
    const register = vi.fn()
    ctx.provide('researchContext', {} as never)
    ctx.provide('systemPrompt', { section: vi.fn() } as never)
    ctx.provide('fs', {} as never)
    ctx.provide('tools', { register } as never)
    controls.apply(ctx)

    const names = register.mock.calls.map(([tool]) => tool.name)
    expect(names).toContain('update_research_idea')
    expect(names).toContain('manage_idea_discussion')
    expect(names).not.toContain('propose_research_authority')
    expect(names).not.toContain('raise_research_leap')
  })
})
