import type { Context } from '@deepseek-ai/cordis'

export const CORDISX_PLUGIN_ID = Symbol('cordisx.pluginId')
/** Launcher-owned source inherited by the same runtime-created child Context. */
export const CORDISX_PLUGIN_SOURCE = Symbol('cordisx.pluginSource')
/** Launcher-issued immutable module generation inherited by the plugin Context. */
export const CORDISX_PLUGIN_GENERATION = Symbol('cordisx.pluginGeneration')

export function ownerFromContext(ctx: Context): string {
  return (ctx as Context & { [CORDISX_PLUGIN_ID]?: string })[CORDISX_PLUGIN_ID] ?? 'host'
}

export function generationFromContext(ctx: Context): string | undefined {
  return (ctx as Context & { [CORDISX_PLUGIN_GENERATION]?: string })[CORDISX_PLUGIN_GENERATION]
}

export function qualifyOwnedId(owner: string, id: string): string {
  return id.includes(':') ? id : `${owner}:${id}`
}
