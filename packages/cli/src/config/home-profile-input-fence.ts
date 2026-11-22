import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import type { HomeConfig, HomeConfigPlugin } from './home-config.js'
import { fenceChangedPermissionProfiles } from './profile-permission-fence.js'
import { fenceChangedConfiguredPlugins, type ProfileManagedStartupInput } from './profile-plugin-config-fence.js'

type Inputs = {
  readonly permissions: readonly CordisXPersistedPermissionPolicyRecord[]
  readonly plugins: readonly HomeConfigPlugin[]
  readonly startup: readonly ProfileManagedStartupInput[]
}

/** Capture before running an updater, which is allowed to mutate its input. */
export function captureHomeProfileInputs(config: Pick<HomeConfig, 'permissions' | 'plugins' | 'apps'>): Inputs {
  const startup = Object.entries(config.apps).flatMap(([appId, app]) =>
    Object.entries(app.profiles).flatMap(([profileId, profile]) => {
      const value = profile.managedServiceStartupConfig
      return value === undefined || Object.keys(value).length === 0 ? [] : [{ appId, profileId, config: value }]
    })
  ).sort((left, right) => left.appId.localeCompare(right.appId) || left.profileId.localeCompare(right.profileId))
  return structuredClone({ permissions: config.permissions, plugins: config.plugins, startup })
}

/** Reserve every affected profile until the Home document is published. */
export async function fenceChangedHomeProfileInputs(
  configPath: string,
  previous: Inputs,
  candidate: Pick<HomeConfig, 'permissions' | 'plugins' | 'apps'>,
): Promise<() => Promise<void>> {
  const next = captureHomeProfileInputs(candidate)
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
    if (failures.length > 0) throw new AggregateError(failures, 'profile input fence release failed')
  }
  try {
    releases.push(await fenceChangedPermissionProfiles(configPath, previous.permissions, next.permissions))
    releases.push(
      await fenceChangedConfiguredPlugins(
        configPath,
        previous.plugins,
        next.plugins,
        previous.startup,
        next.startup,
      ),
    )
  } catch (error) {
    await releaseAll()
    throw error
  }
  return releaseAll
}
