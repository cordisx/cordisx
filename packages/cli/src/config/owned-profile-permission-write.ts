import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { acquireKernelOperationLock, KernelOperationBusyError } from '../launcher/kernel-operation-lock.js'
import {
  type CordisXPersistedPermissionPolicyRecord,
  mergePersistedPermissionPolicies,
  normalizePersistedPermissionPolicyRecord,
  persistedPermissionRecordKey,
} from '../permission-persistence.js'
import type { HomeConfig } from './home-config.js'
import { hasOwnedProfileWrite, runOwnedProfileWrite } from './owned-profile-write-context.js'
import { SharedProfileFence } from './shared-profile-fence.js'

export class ProfilePermissionFenceBusyError extends Error {
  constructor() {
    super('permission policy is in use by an active profile renderer')
    this.name = 'ProfilePermissionFenceBusyError'
  }
}

/** Acquire the same kernel lock used by ordinary policy writers. */
export async function acquirePermissionFence(configPath: string, profileId: string): Promise<() => Promise<void>> {
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

type Owner = {
  readonly configPath: string
  readonly profileId: string
  readonly expected: string
  readonly candidate: string
  current(): boolean
  borrow(): () => Promise<void>
}

const owners = new AsyncLocalStorage<Owner>()

function profileRecords(records: readonly CordisXPersistedPermissionPolicyRecord[], profileId: string) {
  return records.filter(record => record.key.profileId === profileId)
}

function withoutPermissions(value: HomeConfig): unknown {
  const { permissions: _permissions, ...remaining } = value
  return JSON.parse(JSON.stringify(remaining)) as unknown
}

/** A borrowed permission fence cannot authorize any other Home configuration change. */
export function captureOwnedHomePermissionWriteCheck(configPath: string, previous: HomeConfig) {
  const owner = owners.getStore()
  if (!owner) return (_candidate: HomeConfig) => {}
  const baseline = withoutPermissions(previous)
  return (candidate: HomeConfig) => {
    if (
      owners.getStore() !== owner || owner.configPath !== path.resolve(configPath) || !owner.current()
      || !isDeepStrictEqual(baseline, withoutPermissions(candidate))
    ) throw new ProfilePermissionFenceBusyError()
  }
}

/** Borrow only for the exact owner-selected profile snapshot and policy batch. */
export function borrowOwnedPermissionWrite(
  configPath: string,
  previous: readonly CordisXPersistedPermissionPolicyRecord[],
  candidate: readonly CordisXPersistedPermissionPolicyRecord[],
): (() => Promise<void>) | undefined {
  const owner = owners.getStore()
  if (!owner) return undefined
  if (
    owner.configPath !== path.resolve(configPath) || !owner.current()
    || JSON.stringify(profileRecords(previous, owner.profileId)) !== owner.expected
    || JSON.stringify(profileRecords(candidate, owner.profileId)) !== owner.candidate
    || JSON.stringify(previous.filter(record => record.key.profileId !== owner.profileId))
      !== JSON.stringify(candidate.filter(record => record.key.profileId !== owner.profileId))
  ) throw new ProfilePermissionFenceBusyError()
  return owner.borrow()
}

/** Called only while the owner's shared profile lock remains held. */
async function runOwnedPermissionWrite<T>(input: {
  readonly configPath: string
  readonly profileId: string
  readonly expected: readonly CordisXPersistedPermissionPolicyRecord[]
  readonly updates: readonly CordisXPersistedPermissionPolicyRecord[]
  readonly isCurrent: () => boolean
}, action: () => Promise<T>): Promise<T> {
  if (hasOwnedProfileWrite() || owners.getStore()) throw new Error('owned permission write is unavailable')
  const expected = input.expected.map(record => normalizePersistedPermissionPolicyRecord(record))
  const updates = input.updates.map(record => normalizePersistedPermissionPolicyRecord(record))
  if (
    expected.length > 4096 || updates.length === 0 || updates.length > 256
    || [...expected, ...updates].some(record => record.key.profileId !== input.profileId)
    || new Set(expected.map(persistedPermissionRecordKey)).size !== expected.length
    || new Set(updates.map(persistedPermissionRecordKey)).size !== updates.length
  ) throw new Error('owned permission write is unavailable')
  let accepting = true
  let borrowed = 0
  let used = false
  const waiters = new Set<() => void>()
  const authorityCurrent = () => {
    try {
      return input.isCurrent() === true
    } catch {
      return false
    }
  }
  const owner: Owner = {
    configPath: path.resolve(input.configPath),
    profileId: input.profileId,
    expected: JSON.stringify(expected),
    candidate: JSON.stringify(mergePersistedPermissionPolicies(expected, updates)),
    current: () => accepting && authorityCurrent(),
    borrow() {
      if (!owner.current() || used) throw new ProfilePermissionFenceBusyError()
      used = true
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
  if (!owner.current()) throw new Error('owned permission write is unavailable')
  let value: T | undefined
  let failed = false
  let failure: unknown
  try {
    value = await runOwnedProfileWrite(async () => await owners.run(owner, action))
  } catch (error) {
    failed = true
    failure = error
  }
  const outstanding = borrowed !== 0
  accepting = false
  if (outstanding) {
    await new Promise<void>(resolve => {
      waiters.add(resolve)
    })
  }
  if (outstanding || !authorityCurrent() || failed && used || !failed && !used) {
    throw new Error('owned permission write result is uncertain')
  }
  if (failed) throw failure
  return value as T
}

/** Only an instance holding a live kernel lock can create a borrowing scope. */
export class SharedProfilePermissionFence extends SharedProfileFence {
  constructor(private readonly configPath: string, private readonly profileId: string) {
    super(async () => await acquirePermissionFence(configPath, profileId), 'permission fence is closed')
  }

  async runPolicyMutation<T>(input: {
    readonly expected: readonly CordisXPersistedPermissionPolicyRecord[]
    readonly updates: readonly CordisXPersistedPermissionPolicyRecord[]
    readonly isCurrent: () => boolean
  }, action: () => Promise<T>): Promise<T> {
    if (
      process.platform !== 'darwin' && process.platform !== 'linux' || hasOwnedProfileWrite()
      || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(this.profileId)
    ) throw new Error('owned permission write is unavailable')
    return await this.runWhileHeld(async held =>
      await runOwnedPermissionWrite({
        configPath: this.configPath,
        profileId: this.profileId,
        expected: input.expected,
        updates: input.updates,
        isCurrent: () => held() && input.isCurrent(),
      }, action)
    )
  }
}
