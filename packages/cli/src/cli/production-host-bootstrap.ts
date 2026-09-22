import type { ChildProcess } from 'node:child_process'
import type { ResolvedLaunchPlan } from '../adapters/contracts.js'
import {
  type NativeSubmissionBootstrap,
  prepareNativeSubmissionBootstrap,
} from '../launcher/native-submission-composition.js'
import {
  acquireCodexProfileLaunchLease,
  assertLoopbackPortAvailable,
  findFreeLoopbackPort,
  type IsolatedCodexProfile,
  launchCodex,
  terminateIsolatedCodex,
} from '../launcher/process.js'
import { supportsOwnedMainInspector } from '../shortcuts/dock.js'
import type { PreparedRunCommand } from './run-command-dispatch.js'
import { captureMainInspectorUrl, type CordisXCliRuntime, rootFromConfigPath } from './run-support.js'
import { shouldEnableNativeSubmission } from './native-submission-launch-policy.js'

export interface ProductionHostBootstrap {
  readonly plan?: ResolvedLaunchPlan
  readonly debugPort?: number
  readonly profile?: IsolatedCodexProfile
  readonly profileLease?: Awaited<ReturnType<typeof acquireCodexProfileLaunchLease>>
  readonly nativeSubmissionBootstrap?: NativeSubmissionBootstrap
  readonly prelaunchedHost?: Readonly<{ child: ChildProcess; inspectorUrl?: Promise<string> }>
}

/** Resolve and reserve shared CLI/App launch inputs before compatibility analysis. */
export async function prepareProductionHostBootstrap(
  prepared: PreparedRunCommand,
  runtime: CordisXCliRuntime,
  input: Readonly<{
    prelaunch: boolean
    prepareNativeSubmission: boolean
    mainInspector: boolean
    markHostLaunched(pid: number, inspectorUrl?: Promise<string>): boolean | void | Promise<boolean | void>
  }>,
): Promise<ProductionHostBootstrap> {
  const { invocation, selection, adapter, stdout, environment, configPath } = prepared
  const resolved = invocation.options.attach
    ? undefined
    : await adapter.resolveLaunchPlan({
      cordisxHomeDir: rootFromConfigPath(configPath),
      profileId: selection.profileId,
      dataMode: selection.dataMode,
      ...(invocation.options.executable === undefined ? {} : { executable: invocation.options.executable }),
      ...(invocation.options.profileDir === undefined ? {} : { chromiumProfileDir: invocation.options.profileDir }),
    })
  const plan = resolved === undefined
    ? undefined
    : invocation.options.system
    ? {
      ...resolved,
      chromiumProfile: { mode: 'system' as const },
      isolatedDataRoots: resolved.isolatedDataRoots.filter(root => root.name !== 'Chromium profile'),
    }
    : resolved
  const debugPort = invocation.options.attach || invocation.options.dryRun
    ? undefined
    : invocation.options.debugPort ?? await findFreeLoopbackPort()
  if (debugPort !== undefined && invocation.options.debugPort !== undefined) {
    await assertLoopbackPortAvailable(debugPort)
  }
  const chromiumProfile = plan?.chromiumProfile
  const profile = chromiumProfile?.mode === 'independent'
    ? {
      userDataDir: chromiumProfile.path,
      cleanupOwned: plan!.isolatedDataRoots.some(root =>
        root.name === 'Chromium profile' && root.path === chromiumProfile.path && root.managed
      ),
    }
    : undefined
  if (plan === undefined || debugPort === undefined || invocation.options.dryRun) {
    return {
      ...(plan === undefined ? {} : { plan }),
      ...(debugPort === undefined ? {} : { debugPort }),
      ...(profile === undefined ? {} : { profile }),
    }
  }
  let profileLease: Awaited<ReturnType<typeof acquireCodexProfileLaunchLease>> | undefined
  let nativeSubmissionBootstrap: NativeSubmissionBootstrap | undefined
  let child: ChildProcess | undefined
  try {
    profileLease = profile === undefined ? undefined : await acquireCodexProfileLaunchLease(profile.userDataDir)
    await adapter.prepareLaunch(plan)
    if (
      input.prepareNativeSubmission
      && shouldEnableNativeSubmission({
        platform: runtime.internalNativeSubmissionPlatform ?? process.platform,
        adapterId: adapter.id,
        preference: (runtime.env ?? process.env).CORDISX_EXPERIMENTAL_NATIVE_SUBMISSION,
      })
    ) {
      const cacheDirectory = (runtime.env ?? process.env).CORDISX_INTERNAL_NATIVE_SUBMISSION_CACHE_DIRECTORY
      nativeSubmissionBootstrap = await prepareNativeSubmissionBootstrap(
        plan.executable,
        cacheDirectory === undefined ? {} : { cacheDirectory },
      )
    }
    if (!input.prelaunch) {
      return {
        plan,
        debugPort,
        ...(profile === undefined ? {} : { profile }),
        ...(profileLease === undefined ? {} : { profileLease }),
        ...(nativeSubmissionBootstrap === undefined ? {} : { nativeSubmissionBootstrap }),
      }
    }
    const mainInspector = input.mainInspector && await supportsOwnedMainInspector(plan.executable)
    stdout(`[cordisx] launching ${plan.executable} with CDP 127.0.0.1:${debugPort}`)
    child = launchCodex(
      plan.executable,
      debugPort,
      invocation.hostArgs,
      profile,
      invocation.options.onlineDevtools,
      { ...plan.environment, ...nativeSubmissionBootstrap?.environment },
      mainInspector,
    )
    if (child.pid === undefined) throw new Error('launched Host exposed no PID')
    const inspectorUrl = mainInspector ? captureMainInspectorUrl(child) : undefined
    await input.markHostLaunched(child.pid, inspectorUrl)
    return {
      plan,
      debugPort,
      ...(profile === undefined ? {} : { profile }),
      ...(profileLease === undefined ? {} : { profileLease }),
      ...(nativeSubmissionBootstrap === undefined ? {} : { nativeSubmissionBootstrap }),
      prelaunchedHost: { child, ...(inspectorUrl === undefined ? {} : { inspectorUrl }) },
    }
  } catch (error) {
    if (child !== undefined) await terminateIsolatedCodex(child, profile).catch(() => undefined)
    await nativeSubmissionBootstrap?.close().catch(() => undefined)
    await profileLease?.release().catch(() => undefined)
    throw error
  }
}
