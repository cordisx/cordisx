import { mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { acquireKernelOperationLock, KernelOperationBusyError } from '../launcher/kernel-operation-lock.js'
import type { HomeConfigPlugin } from './home-config.js'
import { SharedProfileFence } from './shared-profile-fence.js'

const PROFILE = /^[a-z0-9][a-z0-9._-]{0,63}$/u
// The Home document is JSON; structuredClone does not retain null prototypes.
const equalJson = (left: unknown, right: unknown) =>
  isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)))

export class ProfilePluginConfigFenceBusyError extends Error {
  constructor() {
    super('plugin configuration is in use by an active profile renderer')
    this.name = 'ProfilePluginConfigFenceBusyError'
  }
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
  if (process.platform !== 'darwin' && process.platform !== 'linux' || equalJson(previous, candidate)) {
    return async () => {}
  }
  const root = await directory(configPath)
  const releases: Array<() => Promise<void>> = [await lock(path.join(root, 'registry.mutex'))]
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
    const profiles = (await readdir(root))
      .filter(name => name.endsWith('.lock') && PROFILE.test(name.slice(0, -5)))
      .map(name => name.slice(0, -5)).sort()
    if (profiles.length > 4096) throw new Error('plugin configuration fence limit exceeded')
    for (const profile of profiles) {
      if (!equalJson(projection(previous, profile), projection(candidate, profile))) {
        releases.push(await lock(path.join(root, `${profile}.lock`)))
      }
    }
  } catch (error) {
    await releaseAll()
    throw error
  }
  return releaseAll
}

export class SharedProfilePluginConfigFence extends SharedProfileFence {
  constructor(configPath: string, profileId: string) {
    super(async () => await admit(configPath, profileId), 'plugin configuration fence is closed')
  }
}
