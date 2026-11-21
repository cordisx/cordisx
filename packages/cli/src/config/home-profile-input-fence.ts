import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import type { HomeConfigPlugin } from './home-config.js'
import { fenceChangedPermissionProfiles } from './profile-permission-fence.js'
import { fenceChangedConfiguredPlugins } from './profile-plugin-config-fence.js'

type Inputs = {
  readonly permissions: readonly CordisXPersistedPermissionPolicyRecord[]
  readonly plugins: readonly HomeConfigPlugin[]
}

/** Capture before running an updater, which is allowed to mutate its input. */
export function captureHomeProfileInputs(config: Inputs): Inputs {
  return structuredClone({ permissions: config.permissions, plugins: config.plugins })
}

/** Reserve every affected profile until the Home document is published. */
export async function fenceChangedHomeProfileInputs(
  configPath: string,
  previous: Inputs,
  candidate: Inputs,
): Promise<() => Promise<void>> {
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
    releases.push(await fenceChangedPermissionProfiles(configPath, previous.permissions, candidate.permissions))
    releases.push(await fenceChangedConfiguredPlugins(configPath, previous.plugins, candidate.plugins))
  } catch (error) {
    await releaseAll()
    throw error
  }
  return releaseAll
}
