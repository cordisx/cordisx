import path from 'node:path'

export interface AppLauncherRuntime {
  readonly schemaVersion: 1
  readonly node: string
  readonly entryScript: string
  readonly cordisxHome: string
  readonly cwd: string
  readonly cacheDirectory: string
  readonly cacheRegistry: string
  readonly codexHome?: string
}

export interface AppLauncherProfile {
  readonly id: string
  readonly displayName: string
  readonly dataMode: 'shared' | 'host-isolated'
}

export interface AppLauncherMenu {
  readonly ok: true
  readonly appId: string
  readonly defaultProfile: string
  readonly profiles: readonly AppLauncherProfile[]
}

export function validAppLauncherRuntime(value: unknown): value is AppLauncherRuntime {
  if (!value || typeof value !== 'object') return false
  const runtime = value as AppLauncherRuntime
  return runtime.schemaVersion === 1
    && [
      runtime.node,
      runtime.entryScript,
      runtime.cordisxHome,
      runtime.cwd,
      runtime.cacheDirectory,
      runtime.cacheRegistry,
    ]
      .every(item => typeof item === 'string' && path.isAbsolute(item))
    && (runtime.codexHome === undefined || path.isAbsolute(runtime.codexHome))
}
