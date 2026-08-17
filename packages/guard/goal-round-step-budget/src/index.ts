/** Hard model-step budget for automatic Goal Rounds. @module @deepseek-ai/dsh-goal-round-step-budget */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-goal'
import type { UserMessage } from '@deepseek-ai/dsh-session'

/** Plugin configuration. */
export interface Config {
  /** Maximum model steps admitted in one automatic Goal Round turn. */
  maxStepsPerGoalRound: number
}

/** Validated plugin configuration. */
export const Config: z<Config> = z.object({
  maxStepsPerGoalRound: z.number().step(1).min(1).required(),
})

/** Cordis plugin name used by loader diagnostics. */
export const name = 'goal-round-step-budget'

/** Agent lifecycle service observed by this policy. */
export const inject = ['agents']

/** Whether the first-step batch belongs to an automatic positive-numbered Goal Round. */
function containsGoalRound(messages: readonly UserMessage[]): boolean {
  return messages.some(message => message.source.kind === 'goal' && message.source.round > 0)
}

/** Install one constant-time admission check on each proposed agent step. */
export function apply(ctx: Context, config: Config): void {
  const maxSteps = config.maxStepsPerGoalRound
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
    throw new Error('goal-round-step-budget: maxStepsPerGoalRound must be a positive safe integer')
  }

  const goalTurns = new WeakMap<Agent, number>()

  ctx.on('agent/pre-step', ({ agent, messages, turn, step }, next) => {
    if (step === 1 && containsGoalRound(messages)) goalTurns.set(agent, turn)
    if (goalTurns.get(agent) !== turn || step <= maxSteps) return next()

    goalTurns.delete(agent)
    agent.cancel({ kind: 'parent' })
    return Promise.resolve({ kind: 'reject' as const })
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') goalTurns.delete(agent)
  })

  ctx.on('agent/disposed', ({ agent }) => { goalTurns.delete(agent) })
}
