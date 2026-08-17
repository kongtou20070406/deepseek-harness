/** Package-owned invariant companion. @module @deepseek-ai/dsh-model-execution-policy/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-model-execution-policy'

/** Cordis companion plugin name. */
export const name = 'model-execution-policy-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the plugin owns no durable or mutable state; the prompt
 * registry owns section identity, assembly ordering, and lifecycle disposal.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
