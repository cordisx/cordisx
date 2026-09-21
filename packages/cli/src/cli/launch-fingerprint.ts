import path from 'node:path'
import type { CordisXLauncherOptions } from './parse.js'
import { effectiveConfigFingerprint } from './supervisor-state.js'

function configurationIntent(source: string): string {
  try {
    const config = JSON.parse(source)
    for (
      const app of Object.values(config.apps ?? {}) as {
        profiles?: Record<string, { management?: Record<string, unknown> }>
      }[]
    ) {
      for (const profile of Object.values(app.profiles ?? {})) {
        if (profile.management) {
          // Runtime migration bookkeeping does not change the launched configuration.
          delete profile.management.revision
          delete profile.management.migrations
        }
      }
    }
    return JSON.stringify(config)
  } catch {
    return source
  }
}

/** Output/create flags are not Host state; effective data mode is. */
export function launchFingerprint(input: {
  source: string
  options: CordisXLauncherOptions
  hostArgs: readonly string[]
  dataMode: string
  cwd: string
  codexHome?: string
}): string {
  return effectiveConfigFingerprint({
    source: configurationIntent(input.source),
    options: {
      system: input.options.system,
      executable: input.options.executable ? path.resolve(input.cwd, input.options.executable) : null,
      profileDir: input.options.profileDir ? path.resolve(input.cwd, input.options.profileDir) : null,
      debugPort: input.options.debugPort ?? null,
      onlineDevtools: input.options.onlineDevtools,
      dataMode: input.dataMode,
      cwd: input.cwd,
      codexHome: input.codexHome ?? null,
    },
    hostArgs: input.hostArgs,
  })
}
