/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-llm-pi-ai`.
 * @module @deepseek-ai/dsh-llm-pi-ai/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-llm-pi-ai'

/** Cordis companion plugin name. */
export const name = 'llm-pi-ai-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: OAuth authority remains the credentials service (or
 * the bare composition's in-memory store). The Remote is a direct projection
 * of that authority plus one disposable in-flight controller, not an
 * independent event sequence.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
