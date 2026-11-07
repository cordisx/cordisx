import type { ChildProcess } from 'node:child_process'
import { type IsolatedCodexProfile, terminateIsolatedCodex } from '../launcher/process.js'

export interface InjectedHostCleanup {
  readonly beforeHostTermination: readonly Promise<unknown>[]
  readonly terminateHost?: () => Promise<unknown>
  readonly recoverAfterHostTermination?: (error: unknown) => unknown | undefined
}

/** Keep CDP alive until renderer and launcher-service cleanup has settled. */
export async function settleInjectedHostCleanup(
  input: InjectedHostCleanup,
): Promise<readonly PromiseSettledResult<unknown>[]> {
  const beforeHostTermination = await Promise.allSettled(input.beforeHostTermination)
  const hostTermination = input.terminateHost === undefined
    ? []
    : await Promise.allSettled([input.terminateHost()])
  const recovered = hostTermination[0]?.status === 'fulfilled' && input.recoverAfterHostTermination !== undefined
    ? beforeHostTermination.map(result => {
      if (result.status === 'fulfilled') return result
      const remaining = input.recoverAfterHostTermination!(result.reason)
      return remaining === undefined
        ? { status: 'fulfilled' as const, value: undefined }
        : { status: 'rejected' as const, reason: remaining }
    })
    : beforeHostTermination
  return [...recovered, ...hostTermination]
}

/** Capture the outcome so callers can finish other cleanup before releasing the profile. */
export async function stopPrelaunchedHost(
  child: ChildProcess | undefined,
  profile: IsolatedCodexProfile | undefined,
): Promise<PromiseSettledResult<void> | undefined> {
  if (child === undefined) return undefined
  const [termination] = await Promise.allSettled([terminateIsolatedCodex(child, profile)])
  return termination
}

/** Keep the profile fenced when the termination of a prelaunched Host is unverified. */
export async function releaseHostProfileLease(
  release: (() => Promise<void>) | undefined,
  termination: PromiseSettledResult<unknown> | undefined,
): Promise<void> {
  if (termination?.status !== 'rejected') await release?.()
}

/** Finish prelaunch cleanup without replacing the startup error. */
export async function cleanupPrelaunch(
  child: ChildProcess | undefined,
  profile: IsolatedCodexProfile | undefined,
  release: (() => Promise<void>) | undefined,
): Promise<void> {
  const termination = await stopPrelaunchedHost(child, profile)
  await releaseHostProfileLease(release, termination).catch(() => undefined)
}
