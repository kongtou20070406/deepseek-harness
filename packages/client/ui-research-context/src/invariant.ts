/** Invariant companion for the pure research-context UI plugin. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-research-context'

/** Cordis companion plugin name. */
export const name = 'client-ui-research-context-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: the browser entry is a pure rendering of a host projection. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
