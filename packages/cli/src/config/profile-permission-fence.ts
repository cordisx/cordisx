import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import { acquireKernelOperationLock, KernelOperationBusyError } from '../launcher/kernel-operation-lock.js'

/** A live renderer holds the same profile fence used by Home policy writers. */
export class ProfilePermissionFenceBusyError extends Error {
  constructor() {
    super('permission policy is in use by an active profile renderer')
    this.name = 'ProfilePermissionFenceBusyError'
  }
}

async function acquire(configPath: string, profileId: string): Promise<() => Promise<void>> {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(profileId)) throw new Error('invalid permission profile id')
  const directory = path.join(path.dirname(path.resolve(configPath)), 'run', 'profile-permission-fences')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    // Kernel lock paths are stable and must never be unlinked or replaced.
    return await acquireKernelOperationLock(path.join(directory, `${profileId}.lock`))
  } catch (error) {
    if (error instanceof KernelOperationBusyError) throw new ProfilePermissionFenceBusyError()
    throw error
  }
}

/** Acquire nonblocking locks after comparing the pre-update and candidate policy ledgers. */
export async function fenceChangedPermissionProfiles(
  configPath: string,
  previous: readonly CordisXPersistedPermissionPolicyRecord[],
  candidate: readonly CordisXPersistedPermissionPolicyRecord[],
): Promise<() => Promise<void>> {
  // Renderer admission does not enable this fence on unsupported platforms.
  if (process.platform !== 'darwin' && process.platform !== 'linux') return async () => {}
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
    for (const profile of changed) releases.push(await acquire(configPath, profile))
  } catch (error) {
    await releaseAll()
    throw error
  }
  return releaseAll
}

/** Share one owner-held kernel fence among that owner's live renderer sessions. */
export class SharedProfilePermissionFence {
  private queue: Promise<void> = Promise.resolve()
  private readonly leases = new Set<symbol>()
  private unlock: (() => Promise<void>) | undefined
  private closed = false
  private closing: Promise<void> | undefined

  constructor(private readonly configPath: string, private readonly profileId: string) {}

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  async acquire(): Promise<() => Promise<void>> {
    const lease = Symbol('profile-permission-reader')
    await this.enqueue(async () => {
      if (this.closed) throw new Error('permission fence is closed')
      if (!this.unlock) {
        const release = await acquire(this.configPath, this.profileId)
        if (this.closed) {
          await release()
          throw new Error('permission fence is closed')
        }
        this.unlock = release
      }
      this.leases.add(lease)
    })
    if (this.closed) {
      await this.closing
      throw new Error('permission fence is closed')
    }
    let ended = false
    return async () => {
      if (ended) return
      ended = true
      await this.enqueue(async () => {
        if (!this.leases.delete(lease) || this.leases.size !== 0) return
        const release = this.unlock
        this.unlock = undefined
        await release?.()
      })
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = this.enqueue(async () => {
      this.leases.clear()
      const release = this.unlock
      this.unlock = undefined
      await release?.()
    })
    return this.closing
  }
}
