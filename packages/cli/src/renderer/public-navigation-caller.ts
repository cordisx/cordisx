import type { Context } from '@deepseek-ai/cordis'
import type { PluginConsoleAspect } from './plugin-console.js'
import { generationVisibilityFromContext } from './generation-visibility.js'
import { ownerFromContext } from './ownership.js'

/** Resolve the caller from Cordis context only; no public owner/source parameters. */
export function publicNavigationCallerActive(ctx: Context, console?: PluginConsoleAspect): boolean {
  try {
    if (ctx.fiber.uid === null) return false
    const visibility = generationVisibilityFromContext(ctx)
    if (visibility !== undefined && !visibility.visible(visibility.effect(ctx))) return false
    if (console !== undefined && ownerFromContext(ctx) !== 'host') {
      const token = console.tokenFromContext(ctx)
      if (token === undefined || console.owner(token).id !== ownerFromContext(ctx)) return false
    }
    return true
  } catch {
    return false
  }
}
