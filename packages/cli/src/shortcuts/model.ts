import path from 'node:path'
import type { CordisXDataMode, CordisXManagedInvocation } from '../cli/parse.js'
import { createHash } from 'node:crypto'

export interface ShortcutRecord {
  schemaVersion: 1
  entryId: string
  appId: string
  profileId: string
  dataMode?: CordisXDataMode
  cordisxHome: string
  runtimePath: string
  argv: string[]
  cwd: string
  codexHome?: string
  bundlePath: string
  bookmark: string
  helperDigest?: string
  iconDigest: string
  iconSource: 'host-default' | 'host-avatar' | 'cordisx-default' | 'cordisx-avatar' | 'user'
  launchIdentity?: ShortcutLaunchIdentity
}
export interface ShortcutLaunchIdentity {
  supervisorPid: number
  supervisorStartedAt: string
  hostPid: number
  hostStartedAt: string
}
export interface ShortcutRuntime {
  schemaVersion: 1
  node: string
  cli: string
  entryScript: string
}
export interface ShortcutOutputOptions {
  readonly directory?: string
  readonly registry?: string
}
export function legacyShortcutKey(home: string, app: string, profile: string): string {
  return createHash('sha256').update(JSON.stringify([home, app, profile])).digest('hex').slice(0, 32)
}
export function shortcutKey(home: string, app: string, profile: string, mode: CordisXDataMode): string {
  return createHash('sha256').update(JSON.stringify([home, app, profile, mode])).digest('hex').slice(0, 32)
}
export function shortcutArgv(
  invocation: CordisXManagedInvocation,
  app: string,
  profile: string,
  cwd: string,
  mode: CordisXDataMode,
): string[] {
  // An adapter-owned persistable Host-argument allowlist can extend this later.
  if (invocation.hostArgs.length) {
    throw new Error('This first shortcut version does not persist Host arguments after --')
  }
  if (invocation.options.debugPort !== undefined || invocation.options.onlineDevtools) {
    throw new Error('This first shortcut version does not persist debugPort or onlineDevtools')
  }
  const argv = ['start', app, profile, '--data', mode]
  if (invocation.options.executable !== undefined) {
    argv.push('--executable', path.resolve(cwd, invocation.options.executable))
  }
  if (invocation.options.profileDir !== undefined) {
    argv.push('--profile-dir', path.resolve(cwd, invocation.options.profileDir))
  }
  return argv
}
export function validRecord(value: unknown): value is ShortcutRecord {
  if (!value || typeof value !== 'object') return false
  const v = value as ShortcutRecord
  return v.schemaVersion === 1 && /^[a-f0-9]{32}$/.test(v.entryId) && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(v.appId)
    && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(v.profileId)
    && (v.dataMode === undefined || v.dataMode === 'shared' || v.dataMode === 'host-isolated')
    && [v.cordisxHome, v.cwd, v.runtimePath, v.bundlePath].every(p => typeof p === 'string' && path.isAbsolute(p))
    && Array.isArray(v.argv) && v.argv.every(a => typeof a === 'string') && typeof v.bookmark === 'string'
    && (v.launchIdentity === undefined || (
      Number.isInteger(v.launchIdentity.supervisorPid) && v.launchIdentity.supervisorPid > 0
      && typeof v.launchIdentity.supervisorStartedAt === 'string'
      && Number.isInteger(v.launchIdentity.hostPid) && v.launchIdentity.hostPid > 0
      && typeof v.launchIdentity.hostStartedAt === 'string'
    ))
}
