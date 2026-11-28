import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { acquireKernelOperationLock, KernelOperationBusyError } from '../launcher/kernel-operation-lock.js'
import type { HomeConfig, HomeConfigPlugin, JsonValue } from './home-config.js'
import { SharedProfileFence } from './shared-profile-fence.js'
import { createOwnedPackageWrite, type OwnedPackageWrite } from './owned-profile-package-write.js'
import { hasOwnedProfileWrite, runOwnedProfileWrite } from './owned-profile-write-context.js'
import {
  isOwnedHomeServiceChange,
  isOwnedServiceChange,
  type OwnedServiceWrite,
} from './owned-profile-service-write.js'
import {
  createOwnedConfiguredWrite,
  isOwnedConfiguredChange,
  isOwnedHomeConfiguredChange,
  type OwnedConfiguredWrite,
} from './owned-profile-configured-write.js'

const PROFILE = /^[a-z0-9][a-z0-9._-]{0,63}$/u
const LOCAL_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/u
const ownedServiceWrites = new AsyncLocalStorage<OwnedServiceWrite>()
const ownedConfiguredWrites = new AsyncLocalStorage<OwnedConfiguredWrite>()
const ownedPackageWrites = new AsyncLocalStorage<OwnedPackageWrite>()
const currentOwnedPackageWrite = () => ownedPackageWrites.getStore()
// The Home document is JSON; structuredClone does not retain null prototypes.
const equalJson = (left: unknown, right: unknown) =>
  isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)))

export class ProfilePluginConfigFenceBusyError extends Error {
  constructor() {
    super('plugin configuration is in use by an active profile renderer')
    this.name = 'ProfilePluginConfigFenceBusyError'
  }
}

/** Capture a check without exposing the owner context or a way to create one. */
export function captureOwnedHomeServiceWriteCheck(
  configPath: string,
  previous: HomeConfig,
): (candidate: HomeConfig) => void {
  if (currentOwnedPackageWrite()) throw new ProfilePluginConfigFenceBusyError()
  const service = ownedServiceWrites.getStore()
  const configured = ownedConfiguredWrites.getStore()
  if (service && configured) throw new ProfilePluginConfigFenceBusyError()
  if (!service && !configured) return () => {}
  const baseline = structuredClone(previous)
  return candidate => {
    if (
      service && (ownedServiceWrites.getStore() !== service
          || !isOwnedHomeServiceChange(service, configPath, baseline, candidate))
      || configured && (ownedConfiguredWrites.getStore() !== configured
          || !isOwnedHomeConfiguredChange(configured, configPath, baseline, candidate))
    ) {
      throw new ProfilePluginConfigFenceBusyError()
    }
  }
}

/** Only runWhileHeld can create this private borrowing context. */
async function runOwnedServiceWrite<T>(input: {
  readonly configPath: string
  readonly profileId: string
  readonly pluginId: string
  readonly serviceId: string
  readonly isCurrent: () => boolean
}, action: () => Promise<T>): Promise<T> {
  if (
    hasOwnedProfileWrite() || ownedServiceWrites.getStore() !== undefined
    || ownedConfiguredWrites.getStore() !== undefined || currentOwnedPackageWrite()
  ) {
    throw new Error('owned service write is unavailable')
  }
  let accepting = true
  let borrowed = 0
  const waiters = new Set<() => void>()
  const authorityCurrent = () => {
    try {
      return input.isCurrent()
    } catch {
      return false
    }
  }
  const current = () => accepting && authorityCurrent()
  const owner: OwnedServiceWrite = {
    configPath: path.resolve(input.configPath),
    profileId: input.profileId,
    pluginId: input.pluginId,
    serviceId: input.serviceId,
    current,
    borrow() {
      if (!current()) throw new Error('owned service write is unavailable')
      borrowed++
      let released = false
      return async () => {
        if (released) return
        released = true
        borrowed--
        if (borrowed === 0) { for (const notify of waiters) notify() }
      }
    },
  }
  let value: T | undefined
  let failure: unknown
  let failed = false
  try {
    value = await runOwnedProfileWrite(async () => await ownedServiceWrites.run(owner, action))
  } catch (error) {
    failed = true
    failure = error
  }
  const outstanding = borrowed !== 0
  accepting = false
  if (borrowed !== 0) {
    await new Promise<void>(resolve => {
      waiters.add(resolve)
    })
  }
  if (outstanding || !authorityCurrent()) throw new Error('owned service write result is uncertain')
  if (failed) throw failure
  return value as T
}

/** Only the held profile fence can install this package-writing context. */
async function runOwnedPackageWrite<T>(input: {
  readonly homeDir: string
  readonly profileId: string
  readonly pluginId: string
  readonly isCurrent: () => boolean
}, action: () => Promise<T>): Promise<T> {
  if (hasOwnedProfileWrite() || currentOwnedPackageWrite()) throw new Error('owned package write is unavailable')
  const scope = createOwnedPackageWrite(input)
  if (!scope.owner.current()) throw new Error('owned package write is unavailable')
  let value: T | undefined
  let failure: unknown
  let failed = false
  try {
    value = await runOwnedProfileWrite(async () => await ownedPackageWrites.run(scope.owner, action))
  } catch (error) {
    failed = true
    failure = error
  }
  await scope.finish()
  if (failed) throw failure
  return value as T
}

/** Only the held profile fence can install this configured-plugin write context. */
async function runOwnedConfiguredWrite<T>(input: {
  readonly configPath: string
  readonly profileId: string
  readonly pluginId: string
  readonly isCurrent: () => boolean
}, action: () => Promise<T>): Promise<T> {
  if (
    hasOwnedProfileWrite() || ownedServiceWrites.getStore() !== undefined
    || ownedConfiguredWrites.getStore() !== undefined || currentOwnedPackageWrite()
  ) throw new Error('owned configured plugin write is unavailable')
  const scope = createOwnedConfiguredWrite(input)
  if (!scope.owner.current()) throw new Error('owned configured plugin write is unavailable')
  let value: T | undefined
  let failure: unknown
  let failed = false
  try {
    value = await runOwnedProfileWrite(async () => await ownedConfiguredWrites.run(scope.owner, action))
  } catch (error) {
    failed = true
    failure = error
  }
  await scope.finish()
  if (failed) throw failure
  return value as T
}

async function directory(configPath: string): Promise<string> {
  const result = path.join(path.dirname(path.resolve(configPath)), 'run', 'profile-plugin-config-fences')
  await mkdir(result, { recursive: true, mode: 0o700 })
  return result
}

async function lock(file: string): Promise<() => Promise<void>> {
  try {
    // The pathname is a persistent kernel mutex and must not be unlinked.
    return await acquireKernelOperationLock(file)
  } catch (error) {
    if (error instanceof KernelOperationBusyError) throw new ProfilePluginConfigFenceBusyError()
    throw error
  }
}

async function admit(configPath: string, profileId: string): Promise<() => Promise<void>> {
  if (!PROFILE.test(profileId)) throw new Error('invalid plugin configuration profile id')
  const root = await directory(configPath)
  const registry = await lock(path.join(root, 'registry.mutex'))
  try {
    return await lock(path.join(root, `${profileId}.lock`))
  } finally {
    await registry()
  }
}

/** Serialize installed-package writes with the same profile fence as Manager admission. */
export async function fencePackageProfileWrite(
  homeDir: string,
  profileId: string,
  pluginId?: string,
): Promise<() => Promise<void>> {
  if (!PROFILE.test(profileId)) throw new Error('invalid plugin configuration profile id')
  // A configured Home service authority does not authorize installed-package state.
  if (ownedServiceWrites.getStore() !== undefined || ownedConfiguredWrites.getStore() !== undefined) {
    throw new ProfilePluginConfigFenceBusyError()
  }
  const owner = currentOwnedPackageWrite()
  if (owner) {
    if (
      !pluginId || pluginId !== owner.pluginId || profileId !== owner.profileId
      || path.resolve(homeDir) !== owner.homeDir || !owner.current()
    ) throw new ProfilePluginConfigFenceBusyError()
    return owner.borrow()
  }
  // A different owner scope (for example a permission-policy write) must not
  // acquire an unrelated package fence and mutate another profile.
  if (hasOwnedProfileWrite()) throw new ProfilePluginConfigFenceBusyError()
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return async () => {}
  }
  return await admit(path.join(homeDir, 'config.json'), profileId)
}

/** Exclude cross-process service writers while a credential recovery reads that file. */
export async function fencePackageServiceFile(
  homeDir: string,
  profileId: string,
  pluginId: string,
  serviceId: string,
): Promise<() => Promise<void>> {
  if (!PROFILE.test(profileId) || !LOCAL_ID.test(pluginId) || !LOCAL_ID.test(serviceId)) {
    throw new Error('invalid package service configuration identity')
  }
  if (process.platform !== 'darwin' && process.platform !== 'linux') return async () => {}
  const root = path.join(await directory(path.join(homeDir, 'config.json')), 'package-services', profileId, pluginId)
  await mkdir(root, { recursive: true, mode: 0o700 })
  return await lock(path.join(root, `${serviceId}.lock`))
}

export interface ProfileManagedStartupInput {
  readonly appId: string
  readonly profileId: string
  readonly config: Readonly<Record<string, JsonValue>>
}

/** The profile projection includes configured plugins and their owner-selected startup inputs. */
function projection(
  plugins: readonly HomeConfigPlugin[],
  profileId: string,
  startup: readonly ProfileManagedStartupInput[],
): unknown {
  const configured = plugins.map(plugin => {
    const scoped = plugin.profiles && Object.hasOwn(plugin.profiles, profileId)
      ? plugin.profiles[profileId]
      : undefined
    const services = Object.entries(plugin.services ?? {}).flatMap(([serviceId, service]) => {
      const state = Object.hasOwn(service.profiles, profileId) ? service.profiles[profileId] : undefined
      return state === undefined ? [] : [[serviceId, state] as const]
    }).sort(([left], [right]) => left.localeCompare(right))
    return {
      id: plugin.id,
      entry: plugin.entry,
      enabled: plugin.enabled !== false,
      config: scoped ?? { revision: 0, config: plugin.config ?? {} },
      services,
    }
  })
  return { configured, startup: startup.filter(item => item.profileId === profileId) }
}

/** Hold registry discovery through publication so an unlisted profile cannot join mid-write. */
export async function fenceChangedConfiguredPlugins(
  configPath: string,
  previous: readonly HomeConfigPlugin[],
  candidate: readonly HomeConfigPlugin[],
  previousStartup: readonly ProfileManagedStartupInput[] = [],
  candidateStartup: readonly ProfileManagedStartupInput[] = [],
): Promise<() => Promise<void>> {
  if (currentOwnedPackageWrite()) throw new ProfilePluginConfigFenceBusyError()
  const service = ownedServiceWrites.getStore()
  const configured = ownedConfiguredWrites.getStore()
  if (service && configured) throw new ProfilePluginConfigFenceBusyError()
  const owner = service ?? configured
  if (
    owner && (!(service
      ? isOwnedServiceChange(service, configPath, previous, candidate)
      : isOwnedConfiguredChange(configured!, configPath, previous, candidate))
      || !equalJson(previousStartup, candidateStartup))
  ) {
    throw new ProfilePluginConfigFenceBusyError()
  }
  if (
    process.platform !== 'darwin' && process.platform !== 'linux'
    || equalJson([previous, previousStartup], [candidate, candidateStartup])
  ) {
    return async () => {}
  }
  const releases: Array<() => Promise<void>> = []
  const releaseAll = async () => {
    const failures: unknown[] = []
    for (const release of [...releases].reverse()) {
      try {
        await release()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'plugin configuration fence release failed')
  }
  try {
    if (owner) releases.push(owner.borrow())
    const root = await directory(configPath)
    releases.push(await lock(path.join(root, 'registry.mutex')))
    const profiles = (await readdir(root))
      .filter(name => name.endsWith('.lock') && PROFILE.test(name.slice(0, -5)))
      .map(name => name.slice(0, -5)).sort()
    if (profiles.length > 4096) throw new Error('plugin configuration fence limit exceeded')
    for (const profile of profiles) {
      if (
        !equalJson(projection(previous, profile, previousStartup), projection(candidate, profile, candidateStartup))
      ) {
        if (owner && profile === owner.profileId) continue
        releases.push(await lock(path.join(root, `${profile}.lock`)))
      }
    }
    if (owner && !owner.current()) throw new ProfilePluginConfigFenceBusyError()
  } catch (error) {
    await releaseAll()
    throw error
  }
  return releaseAll
}

export class SharedProfilePluginConfigFence extends SharedProfileFence {
  constructor(private readonly configPath: string, private readonly profileId: string) {
    super(async () => await admit(configPath, profileId), 'plugin configuration fence is closed')
  }

  /** Host-only: the held profile lock remains exclusive throughout one service update. */
  async runServiceMutation<T>(input: {
    readonly pluginId: string
    readonly serviceId: string
    readonly isCurrent: () => boolean
  }, action: () => Promise<T>): Promise<T> {
    if (
      process.platform !== 'darwin' && process.platform !== 'linux' || hasOwnedProfileWrite()
      || !PROFILE.test(this.profileId)
      || !LOCAL_ID.test(input.pluginId) || !LOCAL_ID.test(input.serviceId)
    ) throw new Error('owned service write is unavailable')
    return await this.runWhileHeld(async held =>
      await runOwnedServiceWrite({
        configPath: this.configPath,
        profileId: this.profileId,
        pluginId: input.pluginId,
        serviceId: input.serviceId,
        isCurrent: () => held() && input.isCurrent(),
      }, action)
    )
  }

  /** Host-only: borrow the held profile lock for one installed plugin's configuration. */
  async runPackageMutation<T>(input: {
    readonly pluginId: string
    readonly isCurrent: () => boolean
  }, action: () => Promise<T>): Promise<T> {
    if (
      process.platform !== 'darwin' && process.platform !== 'linux' || hasOwnedProfileWrite()
      || !PROFILE.test(this.profileId)
      || !LOCAL_ID.test(input.pluginId) || ownedServiceWrites.getStore() !== undefined
    ) throw new Error('owned package write is unavailable')
    return await this.runWhileHeld(async held =>
      await runOwnedPackageWrite({
        homeDir: path.dirname(path.resolve(this.configPath)),
        profileId: this.profileId,
        pluginId: input.pluginId,
        isCurrent: () => held() && input.isCurrent(),
      }, action)
    )
  }

  /** Host-only: borrow the held profile lock for one configured plugin's profile state. */
  async runConfiguredMutation<T>(input: {
    readonly pluginId: string
    readonly isCurrent: () => boolean
  }, action: () => Promise<T>): Promise<T> {
    if (
      process.platform !== 'darwin' && process.platform !== 'linux' || hasOwnedProfileWrite()
      || !PROFILE.test(this.profileId) || !LOCAL_ID.test(input.pluginId)
      || ownedServiceWrites.getStore() !== undefined || currentOwnedPackageWrite()
    ) throw new Error('owned configured plugin write is unavailable')
    return await this.runWhileHeld(async held =>
      await runOwnedConfiguredWrite({
        configPath: this.configPath,
        profileId: this.profileId,
        pluginId: input.pluginId,
        isCurrent: () => held() && input.isCurrent(),
      }, action)
    )
  }
}
