import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as executionPolicy from '@deepseek-ai/dsh-model-execution-policy'

async function harness() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { persona: 'You are {{model}}.' })
  const fiber = await ctx.plugin(executionPolicy)
  return { ctx, fiber }
}

class CaptureAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('model execution policy', () => {
  it('keeps one lean policy in every model assembly', async () => {
    const { ctx } = await harness()

    const assembly = await ctx.systemPrompt.assemble()
    const sections = assembly.sections.filter(section => section.name === 'model:execution-policy')
    expect(sections).toHaveLength(1)
    expect(sections[0]?.text).toMatchInlineSnapshot(`
      "Execution policy:
      - Infer intent from the latest user request and confirmed project authority. A current direct user correction overrides earlier assistant plans, Working State, and amendable project monitors. If a project contract changes, preserve the old version as evidence, create a traceable new version, and never claim the revised run satisfied the old contract.
      - For explain, review, diagnose, or plan requests, inspect and report without unrelated mutation. For change, build, fix, continue, or resume requests, perform in-scope local work and non-destructive verification without asking first.
      - Ask only when a missing user-owned choice would materially change the result, or before a required external write, destructive action, purchase, or material scope expansion. Once the user resolves an ambiguity, do not ask it again.
      - Treat warnings, background processes, and resource use as observations. They block only when measured causal interference or a current user-confirmed threshold establishes it. An actual platform or tool denial remains binding.
      - Continue while useful in-scope work remains. Do not substitute review, governance, or precaution for the requested result."
    `)
  })

  it('is identical for Sol, DeepSeek, and Luna route variables', async () => {
    for (const selected of [
      { provider: 'openai-codex', model: 'gpt-5.6-sol' },
      { provider: 'deepseek', model: 'deepseek-v4-pro' },
      { provider: 'openai-codex', model: 'gpt-5.6-luna' },
    ]) {
      const { ctx } = await harness()
      installModelSelection(ctx, { current: selected, assembled: undefined })
      const assembly = await ctx.systemPrompt.assemble()
      expect(assembly.variables).toMatchObject(selected)
      expect(assembly.sections.filter(section => section.name === 'model:execution-policy')).toHaveLength(1)
      await ctx.fiber.dispose()
    }
  })

  it('removes both the section and assembly listener on disposal', async () => {
    const { ctx, fiber } = await harness()
    expect((await ctx.systemPrompt.assemble()).sections)
      .toContainEqual(expect.objectContaining({ name: 'model:execution-policy' }))

    await fiber.dispose()
    expect((await ctx.systemPrompt.assemble()).sections)
      .not.toContainEqual(expect.objectContaining({ name: 'model:execution-policy' }))
  })

  it('enters the real Sol request and its durable request header', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(executionPolicy)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new CaptureAdapter()
    ctx.llm.registerAdapter(['openai-codex'], adapter)
    const agent = ctx.agentLoop.create(SessionId('sol-request'), {
      provider: 'openai-codex', model: 'gpt-5.6-sol',
    })
    installModelSelection(agent.ctx, {
      current: { provider: 'openai-codex', model: 'gpt-5.6-sol' },
      assembled: undefined,
    })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.system).toContain('Once the user resolves an ambiguity, do not ask it again.')
    const header = agent.session.events.find(event => event.type === 'request/header')
    expect(header?.type).toBe('request/header')
    if (header?.type !== 'request/header') throw new Error('missing request header')
    expect(header.data.header.system).toBe(adapter.requests[0]?.system)
    await ctx.fiber.dispose()
  })
})
