import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService, { GoalId } from '@deepseek-ai/dsh-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import * as GoalRoundStepBudget from '@deepseek-ai/dsh-goal-round-step-budget'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
})

/** Mount a real loop and one deterministic tool. */
async function harness(maxStepsPerGoalRound: number) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const budget = await ctx.plugin(GoalRoundStepBudget, { maxStepsPerGoalRound })
  ctx.tools.register(defineContentToolFixture({
    name: 'probe',
    description: 'Return a deterministic result.',
    parameters: {},
    async execute() { return [{ type: 'text', text: 'ok' }] },
  }))
  return { ctx, budget }
}

/** Mount the real Goal service and driver around the hard step budget. */
async function automaticGoalHarness(maxStepsPerGoalRound: number) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(GoalService)
  await ctx.plugin(GoalRoundDriver)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(GoalRoundStepBudget, { maxStepsPerGoalRound })
  ctx.tools.register(defineContentToolFixture({
    name: 'probe',
    description: 'Return a deterministic result.',
    parameters: {},
    async execute() { return [{ type: 'text', text: 'ok' }] },
  }))
  return ctx
}

/** Queue one automatic Goal Round source. */
function goalRound(agent: Agent): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'continue' }],
    source: { kind: 'goal', goalId: GoalId('goal-test'), revision: 1, round: 1 },
  }))
}

describe('goal round step admission', () => {
  it('cancels before dispatching the first model step over the configured limit', async () => {
    const { ctx } = await harness(2)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', {}),
      toolCallResponse('c2', 'probe', {}),
      toolCallResponse('c3', 'probe', {}),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('limited'), { provider: 'mock', model: 'mock' })

    goalRound(agent)
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.events.filter(event => event.type === 'step/end')).toHaveLength(2)
    expect(agent.session.events.findLast(event => event.type === 'turn/end')?.data.reason)
      .toEqual({ kind: 'aborted', reason: { kind: 'parent' } })
  })

  it('does not govern an ordinary user turn', async () => {
    const { ctx } = await harness(1)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', {}),
      toolCallResponse('c2', 'probe', {}),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('user-turn'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(3)
    expect(agent.session.events.findLast(event => event.type === 'turn/end')?.data.reason)
      .toEqual({ kind: 'completed' })
  })

  it('preserves a Goal Round that naturally completes exactly at the limit', async () => {
    const { ctx } = await harness(2)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', {}),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('exact-limit'), { provider: 'mock', model: 'mock' })

    goalRound(agent)
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.events.findLast(event => event.type === 'turn/end')?.data.reason)
      .toEqual({ kind: 'completed' })
  })

  it('pauses a real automatic Goal after the budget cancels its admitted round', async () => {
    const ctx = await automaticGoalHarness(2)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', {}),
      toolCallResponse('c2', 'probe', {}),
      toolCallResponse('c3', 'probe', {}),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('automatic-goal'), { provider: 'mock', model: 'mock' })

    ctx.goals.create(agent, { objective: 'exercise the hard step budget', maxGoalRounds: 8 })
    await vi.waitFor(() => { expect(ctx.goals.get(agent)?.phase).toBe('paused') })
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(ctx.goals.get(agent)).toMatchObject({
      phase: 'paused',
      activation: 'disarmed',
      roundsStarted: 1,
    })
  })

  it('removes enforcement when the Cordis plugin is disposed', async () => {
    const { ctx, budget } = await harness(1)
    await budget.dispose()
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', {}),
      toolCallResponse('c2', 'probe', {}),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('disposed-policy'), { provider: 'mock', model: 'mock' })

    goalRound(agent)
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(3)
    expect(agent.session.events.findLast(event => event.type === 'turn/end')?.data.reason)
      .toEqual({ kind: 'completed' })
  })

  it('rejects a non-positive direct config at plugin load', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })

    await expect(ctx.plugin(GoalRoundStepBudget, { maxStepsPerGoalRound: 0 }))
      .rejects.toThrow('expected number >= 1')
  })
})
