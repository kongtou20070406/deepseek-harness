/** Invariant companion for the legacy Workspace migration bridge. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-research-authority-workspace'

export const name = 'research-authority-workspace-invariant'
export const inject = ['invariants']
/** No runtime invariant: the owning service clones legacy state into the Session exactly once. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
