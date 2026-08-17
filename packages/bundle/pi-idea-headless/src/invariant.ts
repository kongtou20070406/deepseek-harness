/** Package-owned invariant companion for the Pi-Idea headless bundle. @module @deepseek-ai/dsh-pi-idea-headless/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-pi-idea-headless'

/** Cordis companion plugin name. */
export const name = 'pi-idea-headless-bundle-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/** No runtime invariant: the bundle only selects an existing compaction provider. */
const install: InvariantInstaller = () => {}

/** Register this bundle's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
