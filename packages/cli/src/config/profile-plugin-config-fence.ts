import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { acquireKernelOperationLock, KernelOperationBusyError } from '../launcher/kernel-operation-lock.js'
import type { HomeConfig, HomeConfigPlugin } from './home-config.js'
import { SharedProfileFence } from './shared-profile-fence.js'
import {
  isOwnedHomeServiceChange,
  isOwnedServiceChange,
  type OwnedServiceWrite,
} from './owned-profile-service-write.js'

const PROFILE = /^[a-z0-9][a-z0-9._-]{0,63}$/u
const LOCAL_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/u
const ownedServiceWrites = new AsyncLocalStorage<OwnedServiceWrite>()
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
  const owner = ownedServiceWrites.getStore()
  if (!owner) return () => {}
  const baseline = structuredClone(previous)
  return candidate => {
    if (ownedServiceWrites.getStore() !== owner || !isOwnedHomeServiceChange(owner, configPath, baseline, candidate)) {
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
  if (ownedServiceWrites.getStore() !== undefined) throw new Error('owned service write is unavailable')
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
    value = await ownedServiceWrites.run(owner, action)
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

/** The profile projection is the selected configured plugin and service state, including candidates. */
function projection(plugins: readonly HomeConfigPlugin[], profileId: string): unknown {
  return plugins.map(plugin => {
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
}

/** Hold registry discovery through publication so an unlisted profile cannot join mid-write. */
export async function fenceChangedConfiguredPlugins(
  configPath: string,
  previous: readonly HomeConfigPlugin[],
  candidate: readonly HomeConfigPlugin[],
): Promise<() => Promise<void>> {
  const owner = ownedServiceWrites.getStore()
  if (owner && !isOwnedServiceChange(owner, configPath, previous, candidate)) {
    throw new ProfilePluginConfigFenceBusyError()
  }
  if (process.platform !== 'darwin' && process.platform !== 'linux' || equalJson(previous, candidate)) {
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
      if (!equalJson(projection(previous, profile), projection(candidate, profile))) {
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
      process.platform !== 'darwin' && process.platform !== 'linux' || !PROFILE.test(this.profileId)
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
}
