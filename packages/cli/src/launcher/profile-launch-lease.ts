import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { liveProcessStartedAt, processesUsingUserDataDir, recordedProcessStatus } from './process-identity.js'
import { acquireKernelOperationLock, KernelOperationBusyError } from './kernel-operation-lock.js'

export interface CodexProfileLaunchLease {
  readonly userDataDir: string
  release(): Promise<void>
}

export interface CodexProfileLaunchLeaseOptions {
  /** Receives one `[cordisx]` log line when a stale lock left by an exited launcher is reclaimed. */
  readonly stdout?: (line: string) => void
}

interface ProfileLeaseRecord {
  readonly version: 2
  readonly pid: number
  readonly processStartedAt: string
  readonly token: string
  readonly userDataDir: string
}

async function canonicalProfileLeaseTarget(userDataDir: string): Promise<string> {
  const resolvedProfile = path.resolve(userDataDir)
  try {
    return await realpath(resolvedProfile)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const parent = path.dirname(resolvedProfile)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  return path.join(await realpath(parent), path.basename(resolvedProfile))
}

function profileLeasePath(userDataDir: string): string {
  return `${userDataDir}.cordisx-launch-lock`
}

function parseProfileLeaseRecord(source: string): ProfileLeaseRecord | undefined {
  try {
    const value = JSON.parse(source) as Partial<ProfileLeaseRecord>
    if (
      value.version !== 2 || !Number.isInteger(value.pid) || value.pid! <= 0
      || typeof value.processStartedAt !== 'string' || value.processStartedAt === ''
      || typeof value.token !== 'string' || value.token === ''
      || typeof value.userDataDir !== 'string' || !path.isAbsolute(value.userDataDir)
    ) return undefined
    return value as ProfileLeaseRecord
  } catch {
    return undefined
  }
}

/**
 * Called only under the stable profile operation mutex, including inspection
 * and replacement publication. Rename alone cannot fence delayed reclaimers.
 */
async function reclaimStaleProfileLease(lockPath: string, stale: ProfileLeaseRecord): Promise<void> {
  const quarantine = `${lockPath}.stale-${randomUUID()}`
  try {
    await rename(lockPath, quarantine)
  } catch (error) {
    // Another launcher already moved it; the retry re-inspects the current owner.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const moved = parseProfileLeaseRecord(await readFile(path.join(quarantine, 'owner.json'), 'utf8').catch(() => ''))
  if (moved?.token === stale.token) {
    await rm(quarantine, { recursive: true, force: true })
    return
  }
  // The lock changed hands after inspection; give it back to its live owner.
  try {
    await rename(quarantine, lockPath)
  } catch (error) {
    throw new Error(
      `Codex profile launch lock changed owner during recovery; restore it manually from ${quarantine}`,
      { cause: error },
    )
  }
}

/**
 * Exclusively reserve one persistent Chromium profile for this launcher process.
 *
 * A lock whose recorded launcher has exited is reclaimed automatically, but
 * only when no live process still uses the profile. Every other conflict fails
 * closed and names the lock to inspect.
 */
export async function acquireCodexProfileLaunchLease(
  userDataDir: string,
  options: CodexProfileLaunchLeaseOptions = {},
): Promise<CodexProfileLaunchLease> {
  const resolvedProfile = await canonicalProfileLeaseTarget(userDataDir)
  const unlock = await acquireProfileOperationLock(resolvedProfile)
  try {
    return await acquireLockedProfileLease(resolvedProfile, options)
  } finally {
    await unlock()
  }
}

async function acquireProfileOperationLock(profile: string): Promise<() => Promise<void>> {
  try {
    return await acquireKernelOperationLock(`${profile}.cordisx-launch-mutex`)
  } catch (error) {
    if (error instanceof KernelOperationBusyError) {
      throw new Error(`Codex profile is in use by another launch or release operation: ${profile}`)
    }
    throw error
  }
}

async function acquireLockedProfileLease(
  resolvedProfile: string,
  options: CodexProfileLaunchLeaseOptions,
): Promise<CodexProfileLaunchLease> {
  const lockPath = profileLeasePath(resolvedProfile)
  const ownerPath = path.join(lockPath, 'owner.json')
  const processStartedAt = liveProcessStartedAt(process.pid)
  if (processStartedAt === undefined) throw new Error('cannot identify the CordisX launcher process')
  // At most one stale-lock reclaim followed by one retry; a second conflict fails closed.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let createdLock = false
    try {
      await mkdir(lockPath, { mode: 0o700 })
      createdLock = true
      const record: ProfileLeaseRecord = {
        version: 2,
        pid: process.pid,
        processStartedAt,
        token: randomUUID(),
        userDataDir: resolvedProfile,
      }
      await writeFile(ownerPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      let released = false
      let releasing: Promise<void> | undefined
      return Object.freeze({
        userDataDir: resolvedProfile,
        release: async () => {
          if (released) return
          if (releasing !== undefined) return await releasing
          const operation = (async () => {
            const unlock = await acquireProfileOperationLock(resolvedProfile)
            try {
              const current = parseProfileLeaseRecord(await readFile(ownerPath, 'utf8').catch(() => ''))
              if (current?.token !== record.token) {
                throw new Error(`Codex profile launch lease ownership changed: ${resolvedProfile}`)
              }
              await rm(lockPath, { recursive: true })
              released = true
            } finally {
              await unlock()
            }
          })()
          releasing = operation
          try {
            await operation
          } finally {
            if (!released && releasing === operation) releasing = undefined
          }
        },
      })
    } catch (error) {
      if (createdLock) {
        await rm(lockPath, { recursive: true, force: true })
        throw error
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const owner = parseProfileLeaseRecord(await readFile(ownerPath, 'utf8').catch(() => ''))
      if (owner === undefined || owner.userDataDir !== resolvedProfile) {
        throw new Error(
          `Codex profile is in use or has an unrecognized launch lock; inspect ${lockPath} before launching: ${resolvedProfile}. Legacy v1 locks require manual cleanup only after all older CordisX launchers and profile Hosts have exited`,
        )
      }
      const status = recordedProcessStatus(owner.pid, owner.processStartedAt)
      if (status === 'alive') {
        throw new Error(`Codex profile is in use by launcher process ${owner.pid}: ${resolvedProfile}`)
      }
      if (status === 'unknown') {
        throw new Error(
          `Codex profile has a stale launch lock that requires inspection because launcher process ${owner.pid} could not be verified: ${lockPath}`,
        )
      }
      if (attempt > 0) {
        throw new Error(
          `Codex profile launch lock was replaced during recovery by another exited launcher process ${owner.pid}; inspect ${lockPath}`,
        )
      }
      const holders = processesUsingUserDataDir([resolvedProfile])
      if (holders === undefined) {
        throw new Error(
          `Codex profile has a stale launch lock that requires inspection because live Host processes could not be enumerated: ${lockPath}`,
        )
      }
      if (holders.length > 0) {
        throw new Error(
          `Codex profile launch lock owner ${owner.pid} has exited, but the profile is still used by process ${
            holders.join(', ')
          }; stop that Host before launching: ${resolvedProfile}`,
        )
      }
      await reclaimStaleProfileLease(lockPath, owner)
      options.stdout?.(
        `[cordisx] reclaimed stale Codex profile launch lock left by exited launcher process ${owner.pid} (started ${owner.processStartedAt}): ${lockPath}`,
      )
    }
  }
  throw new Error(`Codex profile launch lease could not be acquired: ${resolvedProfile}`)
}
