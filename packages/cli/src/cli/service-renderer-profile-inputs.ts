import { createHash } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { type HomeConfigProfile, loadHomeConfig } from '../config/home-config.js'
import { PackagePluginConfigStore } from '../launcher/package-plugin-config.js'
import { PackagePluginServiceConfigStore } from '../launcher/package-plugin-service-config.js'
import type { ServiceRendererSnapshot } from './service-renderer-bootstrap-state.js'

const PROFILE = /^[a-z0-9][a-z0-9._-]{0,63}$/u
const LOCAL_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/u
const MAX_SERVICE_STATES = 512

/** Bind profile input verification to the owner's selected startup configuration. */
export async function readOwnerProfileInputs(
  input: {
    readonly homeDir: string
    readonly configPath: string
    readonly appId: string
    readonly profileId: string
    readonly generation: string
    readonly protectProfileInputs?: boolean
    readonly projectPluginConfig?: unknown
  },
  ownerStartupConfig: NonNullable<HomeConfigProfile['managedServiceStartupConfig']>,
  snapshot: ServiceRendererSnapshot,
): Promise<Map<string, string>> {
  return await readSettledProfileInputs({
    homeDir: input.homeDir,
    configPath: input.configPath,
    appId: input.appId,
    profileId: input.profileId,
    generation: input.generation,
    ownerStartupConfig,
    pluginIds: snapshot.active.plugins.map(plugin => plugin.id),
    // The owner still decides which values can be projected. Under its fence,
    // unavailable packages may have private values that are only hashed.
    allowNonEmptyPluginConfig: input.protectProfileInputs === true,
  })
}

type Input = {
  readonly homeDir: string
  readonly profileId: string
  readonly generation: string
  readonly pluginIds: readonly string[]
  /** Only an owner with a separate verified redaction path may accept nonempty input. */
  readonly allowNonEmptyPluginConfig?: boolean
}

async function existingStateDirectory(homeDir: string, parts: readonly string[]): Promise<string | undefined> {
  let current = homeDir
  for (const part of parts) {
    current = path.join(current, part)
    try {
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('renderer-profile-input-unavailable')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  return current
}

/** The first package-config handoff excludes packages with any service state. */
export async function hasNoPackageServiceState(homeDir: string, profileId: string, pluginId: string): Promise<boolean> {
  if (!PROFILE.test(profileId) || !LOCAL_ID.test(pluginId)) return false
  const directory = await existingStateDirectory(homeDir, [
    'state',
    'profiles',
    profileId,
    'plugins',
    'services',
    pluginId,
  ])
  return directory === undefined || (await readdir(directory)).length === 0
}

/** Inspect settled package inputs without sending configuration or credentials to a renderer. */
export async function readSettledPackageInputs(input: Input): Promise<Map<string, string>> {
  if (
    !PROFILE.test(input.profileId) || input.pluginIds.length > 256
    || new Set(input.pluginIds).size !== input.pluginIds.length || input.pluginIds.some(id => !LOCAL_ID.test(id))
  ) throw new Error('renderer-profile-input-unavailable')
  const configs = new PackagePluginConfigStore(input.homeDir, input.profileId, input.generation)
  const services = new PackagePluginServiceConfigStore(input.homeDir, input.profileId, input.generation)
  const hashes = new Map<string, string>()
  let serviceCount = 0
  const root = ['state', 'profiles', input.profileId, 'plugins']
  const configDirectory = await existingStateDirectory(input.homeDir, [...root, 'config'])
  for (const pluginId of input.pluginIds) {
    const state = configDirectory ? await configs.loadStable(pluginId) : { revision: 0, config: {} }
    if (
      state.config === null || typeof state.config !== 'object' || Array.isArray(state.config)
      || !input.allowNonEmptyPluginConfig && Object.keys(state.config).length !== 0
    ) throw new Error('renderer-profile-input-unavailable')
    const hash = createHash('sha256').update(JSON.stringify(['plugin', state]))
    const directory = await existingStateDirectory(input.homeDir, [...root, 'services', pluginId])
    const names = directory === undefined ? [] : await readdir(directory, { withFileTypes: true })
    for (
      const item of names.filter(entry => entry.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name))
    ) {
      const serviceId = item.name.slice(0, -5)
      if (!item.isFile() || !LOCAL_ID.test(serviceId) || ++serviceCount > MAX_SERVICE_STATES) {
        throw new Error('renderer-profile-input-unavailable')
      }
      await services.withLockedRawState(pluginId, serviceId, async raw => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('renderer-profile-input-unavailable')
        const serviceState = (raw as { readonly state?: { readonly candidate?: unknown } }).state
        if (!serviceState || serviceState.candidate !== undefined) throw new Error('renderer-profile-input-pending')
        hash.update(JSON.stringify([serviceId, raw]))
      })
    }
    hashes.set(pluginId, hash.digest('hex'))
  }
  return hashes
}

/** The caller holds the owner profile fence while selecting and rechecking these inputs. */
export async function readSettledProfileInputs(
  input: Input & {
    readonly configPath: string
    readonly appId: string
    readonly ownerStartupConfig: NonNullable<HomeConfigProfile['managedServiceStartupConfig']>
  },
): Promise<Map<string, string>> {
  const config = await loadHomeConfig(input.configPath)
  const selectedStartup = config.apps[input.appId]?.profiles[input.profileId]?.managedServiceStartupConfig ?? {}
  if (
    !isDeepStrictEqual(
      JSON.parse(JSON.stringify(selectedStartup)),
      JSON.parse(JSON.stringify(input.ownerStartupConfig)),
    )
  ) throw new Error('renderer-profile-owner-startup-stale')
  for (const plugin of config.plugins) {
    if (plugin.profiles?.[input.profileId]?.candidate !== undefined) throw new Error('renderer-profile-input-pending')
    for (const service of Object.values(plugin.services ?? {})) {
      if (service.profiles[input.profileId]?.candidate !== undefined) throw new Error('renderer-profile-input-pending')
    }
  }
  return await readSettledPackageInputs(input)
}
