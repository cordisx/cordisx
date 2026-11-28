import path from 'node:path'
import { lstat } from 'node:fs/promises'
import { processIdentityStatus } from '../cli/supervisor-state.js'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
} from './management-rpc.js'
import type { TerminalProviderRequest, TerminalProviderResult } from './terminal-provider.js'
import { existingModelProviderDisplays } from './existing-model-provider-display.js'

export interface ExistingTerminalProviderSource {
  readonly homeDir: string
  readonly profileId: string
  /** Explicit configured app namespaces eligible to own this same profile. */
  readonly appIds?: readonly string[]
  readonly selectedAppId?: string
  /** When attaching a native client, pin discovery to its verified service generation. */
  readonly expectedOwner?: Readonly<{ pid: number; processStartedAt: string; generation: string }>
}

export class TerminalOwnerDiscoveryError extends Error {
  constructor(readonly reason: 'no-owner' | 'ambiguous' | 'unverified') {
    super(
      reason === 'ambiguous'
        ? 'More than one CordisX owner claims this profile; resolve the ownership conflict first'
        : reason === 'unverified'
        ? 'A CordisX owner for this profile could not be verified; no provider was selected'
        : 'Existing CordisX provider Host unavailable',
    )
  }
}

/** Pin one existing Host. Every request and response remains inside that exact owner lifetime. */
export async function connectExistingTerminalProvider(source: ExistingTerminalProviderSource) {
  const configPath = path.resolve(source.homeDir, 'config.json')
  const appIds = [...new Set(source.appIds ?? ['codex'])]
  if (
    !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(source.profileId)
    || appIds.length === 0 || appIds.length > 64 || appIds.some(id => !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(id))
  ) {
    throw new TerminalOwnerDiscoveryError('unverified')
  }
  if (source.selectedAppId !== undefined && !appIds.includes(source.selectedAppId)) {
    throw new TerminalOwnerDiscoveryError('no-owner')
  }
  const discover = async () => {
    const candidates = await Promise.all(appIds.map(async appId => {
      const paths = pluginManagementRpcPaths(source.homeDir, appId, source.profileId)
      const metadata = await lstat(paths.state).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw new TerminalOwnerDiscoveryError('unverified')
      })
      if (!metadata) return undefined
      if (
        !metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0
        || typeof process.getuid === 'function' && metadata.uid !== process.getuid()
      ) {
        throw new TerminalOwnerDiscoveryError('unverified')
      }
      const endpoint = await readPluginManagementRpcEndpoint(paths)
      if (
        !endpoint || endpoint.appId !== appId || endpoint.profileId !== source.profileId
        || path.resolve(endpoint.configPath) !== configPath
      ) {
        throw new TerminalOwnerDiscoveryError('unverified')
      }
      const identity = await processIdentityStatus(endpoint.pid, endpoint.processStartedAt)
      if (identity === 'unknown') throw new TerminalOwnerDiscoveryError('unverified')
      return identity === 'dead' ? undefined : { paths, endpoint }
    }))
    const active = candidates.filter((value): value is NonNullable<typeof value> => value !== undefined)
    if (active.length > 1) throw new TerminalOwnerDiscoveryError('ambiguous')
    if (active.length === 0) throw new TerminalOwnerDiscoveryError('no-owner')
    if (source.selectedAppId !== undefined && active[0]!.endpoint.appId !== source.selectedAppId) {
      throw new TerminalOwnerDiscoveryError('no-owner')
    }
    return active[0]!
  }
  const { paths, endpoint } = await discover()
  if (
    source.expectedOwner !== undefined
    && (endpoint.pid !== source.expectedOwner.pid
      || endpoint.processStartedAt !== source.expectedOwner.processStartedAt
      || endpoint.generation !== source.expectedOwner.generation)
  ) throw new TerminalOwnerDiscoveryError('unverified')
  const check = async () => {
    const current = (await discover()).endpoint
    if (
      current.appId !== endpoint.appId || current.profileId !== endpoint.profileId
      || current.pid !== endpoint.pid || current.processStartedAt !== endpoint.processStartedAt
      || current.token !== endpoint.token || current.generation !== endpoint.generation
    ) {
      throw new Error('CordisX owner changed; start a new session')
    }
  }
  return async (request: TerminalProviderRequest): Promise<TerminalProviderResult> => {
    await check()
    const result = await requestPluginManagementRpc(paths, endpoint, {
      kind: 'terminal-provider',
      request,
    }) as TerminalProviderResult
    if (
      endpoint.appId === 'codex' && request.kind === 'list' && result.kind === 'list'
      && result.providers.some(provider => provider.managed && provider.display === undefined)
    ) {
      // Optional metadata only. A legacy UI read failure cannot retire a healthy service catalog.
      const displays = await existingModelProviderDisplays(source, endpoint).catch(() => [])
      await check()
      return {
        ...result,
        providers: result.providers.map(provider => {
          const display = provider.managed && provider.display === undefined
            ? displays.find(display => display.providerId === provider.providerId)
            : undefined
          return display === undefined ? provider : { ...provider, title: display.title, display }
        }),
      }
    }
    await check()
    return result
  }
}
