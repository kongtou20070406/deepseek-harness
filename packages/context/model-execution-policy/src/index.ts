/**
 * Shared execution guidance for every model route.
 * @module @deepseek-ai/dsh-model-execution-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name. */
export const name = 'model-execution-policy'

/** Prompt registry receiving the shared policy section. */
export const inject = ['systemPrompt']

const SECTION_NAME = 'model:execution-policy'

const POLICY = 'Execution policy:\n'
  + '- Infer intent from the latest user request and confirmed project authority. A current direct user correction overrides earlier assistant plans, Working State, and amendable project monitors. If a project contract changes, preserve the old version as evidence, create a traceable new version, and never claim the revised run satisfied the old contract.\n'
  + '- For explain, review, diagnose, or plan requests, inspect and report without unrelated mutation. For change, build, fix, continue, or resume requests, perform in-scope local work and non-destructive verification without asking first.\n'
  + '- Ask only when a missing user-owned choice would materially change the result, or before a required external write, destructive action, purchase, or material scope expansion. Once the user resolves an ambiguity, do not ask it again.\n'
  + '- Treat warnings, background processes, and resource use as observations. They block only when measured causal interference or a current user-confirmed threshold establishes it. An actual platform or tool denial remains binding.\n'
  + '- Continue while useful in-scope work remains. Do not substitute review, governance, or precaution for the requested result.'

/**
 * Register one prefix-stable section shared by every assembled model request.
 * @param ctx - plugin context carrying the prompt registry.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: 5,
    text: POLICY,
  }), 'model-execution-policy.section()')
}
