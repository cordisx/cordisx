import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import { acquirePermissionFence, borrowOwnedPermissionWrite } from './owned-profile-permission-write.js'
export { ProfilePermissionFenceBusyError, SharedProfilePermissionFence } from './owned-profile-permission-write.js'

/** Acquire nonblocking locks after comparing the pre-update and candidate policy ledgers. */
export async function fenceChangedPermissionProfiles(
  configPath: string,
  previous: readonly CordisXPersistedPermissionPolicyRecord[],
  candidate: readonly CordisXPersistedPermissionPolicyRecord[],
): Promise<() => Promise<void>> {
  // Renderer admission does not enable this fence on unsupported platforms.
  if (process.platform !== 'darwin' && process.platform !== 'linux') return async () => {}
  const owned = borrowOwnedPermissionWrite(configPath, previous, candidate)
  if (owned) return owned
  const grouped = (records: readonly CordisXPersistedPermissionPolicyRecord[]) => {
    const profiles = new Map<string, string[]>()
    for (const record of records) {
      const entries = profiles.get(record.key.profileId) ?? []
      entries.push(JSON.stringify(record))
      profiles.set(record.key.profileId, entries)
    }
    return profiles
  }
  const before = grouped(previous)
  const after = grouped(candidate)
  const changed = [...new Set([...before.keys(), ...after.keys()])].sort().filter(profile =>
    JSON.stringify(before.get(profile) ?? []) !== JSON.stringify(after.get(profile) ?? [])
  )
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
    if (failures.length > 0) throw new AggregateError(failures, 'permission fence release failed')
  }
  try {
    for (const profile of changed) releases.push(await acquirePermissionFence(configPath, profile))
  } catch (error) {
    await releaseAll()
    throw error
  }
  return releaseAll
}
