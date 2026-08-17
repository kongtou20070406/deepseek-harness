/** Package-owned invariant companion for research-context compaction. @module @deepseek-ai/dsh-compaction-research-context/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-compaction-research-context'

/** Cordis companion plugin name. */
export const name = 'compaction-research-context-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: Session and compaction event invariants validate the replacement transaction. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
