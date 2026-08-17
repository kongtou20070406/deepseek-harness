/** Package-owned invariant companion for the Pi-Idea context bundle. @module @deepseek-ai/dsh-pi-idea-context/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-pi-idea-context'

/** Cordis companion plugin name. */
export const name = 'pi-idea-context-bundle-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/** No runtime invariant: the bundle only composes plugin rows whose packages own their checks. */
const install: InvariantInstaller = () => {}

/** Register this bundle's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
