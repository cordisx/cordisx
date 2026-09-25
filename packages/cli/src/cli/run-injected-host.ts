import type { ChildProcess } from 'node:child_process'
import type { ConfigBridgeHandler } from '../launcher/config-rpc.js'
import { CdpPluginLifecycleRuntime, watchAndInject, type WatchInjectionOptions } from '../launcher/cdp.js'
import type { ChannelActionsBridgeHandler } from '../launcher/channel-actions-rpc.js'
import type { ChannelCredentialBridgeHandler } from '../launcher/channel-credential-rpc.js'
import type { IconThemePreferencePersistenceContext } from '../launcher/icon-theme-rpc.js'
import { LauncherMarketplaceCertifiedAuthority } from '../launcher/marketplace-certified-authority.js'
import type { PluginLifecycleBridgeHandler } from '../launcher/plugin-lifecycle-rpc.js'
import type { PluginManagementBridgeHandler } from '../launcher/management-rpc.js'
import type { OwnerDocumentBridgeHandler } from '../launcher/owner-document-rpc.js'
import {
  acquireCodexProfileLaunchLease,
  confirmHiddenCodexOwnership,
  findFreeLoopbackPort,
  type IsolatedCodexProfile,
  launchCodex,
  launchCodexHidden,
  retainProfileLeaseAfterHiddenHostFailure,
  terminateIsolatedCodex,
} from '../launcher/process.js'
import type { PublisherGrantBridgeHandler } from '../launcher/publisher-grant-rpc.js'
import type { ServiceConfigBridgeHandler } from '../launcher/service-config-rpc.js'
import { supportsOwnedMainInspector } from '../shortcuts/dock.js'
import type { ProviderFleet } from '../providers/fleet.js'
import type { CodexAgentHistoryHost } from '../launcher/agent-history.js'
import type { PermissionPersistenceContext } from '../launcher/permission-rpc.js'
import type { CordisXLauncherOptions } from './parse.js'
import { settleInjectedHostCleanup } from './injected-host-cleanup.js'
import {
  logHostLifecycle,
  observeHostExit,
  waitForAbort,
  waitForExit,
  waitForHostExitAfterReadiness,
} from './host-lifecycle.js'

/** Capture only the ephemeral loopback inspector address from our own Host stderr. */
export function captureMainInspectorUrl(child: ChildProcess): Promise<string> {
  const stream = child.stderr
  if (!stream) return Promise.reject(new Error('Owned Host inspector stderr unavailable'))
  const operation = new Promise<string>((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('Owned Host inspector did not start')), 8_000)
    stream.on('data', chunk => {
      buffer = (buffer + String(chunk)).slice(-8_192)
      const match = /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+)/u.exec(buffer)
      if (match?.[1]) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    stream.once('error', reject)
    stream.once('end', () => reject(new Error('Owned Host main inspector exited')))
  })
  void operation.catch(() => undefined)
  return operation
}

/** A rejected startup UI callback is terminal, including the user's Close action. */
export async function completeHostReadiness(
  controller: AbortController,
  ready?: (signal?: AbortSignal) => void | Promise<void>,
): Promise<void> {
  try {
    await ready?.(controller.signal)
  } catch (error) {
    controller.abort()
    throw error
  }
}

export async function runInjectedHost(input: {
  readonly nativeSubmission?: WatchInjectionOptions['nativeSubmission']
  readonly source: string | (() => string)
  readonly newDocumentSource?: string | (() => string)
  readonly providerFleet?: ProviderFleet
  readonly providerBridgeToken?: string
  readonly agentHistoryHost: CodexAgentHistoryHost
  readonly agentHistoryBridgeToken: string
  readonly configBridge?: ConfigBridgeHandler
  readonly ownerDocuments?: OwnerDocumentBridgeHandler
  readonly serviceConfigBridge?: ServiceConfigBridgeHandler
  readonly channelCredentialBridge?: ChannelCredentialBridgeHandler
  readonly channelActionsBridge?: ChannelActionsBridgeHandler
  readonly permissionPersistence?: PermissionPersistenceContext
  readonly iconThemePreferencePersistence?: IconThemePreferencePersistenceContext
  readonly pluginLifecycle?: {
    readonly handler: PluginLifecycleBridgeHandler
    readonly runtime: CdpPluginLifecycleRuntime
  }
  readonly pluginManagement?: PluginManagementBridgeHandler
  readonly developmentRuntime?: CdpPluginLifecycleRuntime
  readonly viteDevelopment?: boolean
  readonly hasLoopbackGraph: boolean
  readonly pluginArtifactOrigin?: string
  readonly productionGraphBootstrap?: WatchInjectionOptions['productionGraphBootstrap']
  readonly publisherGrant?: PublisherGrantBridgeHandler
  readonly certifiedPermission?: Readonly<{
    authority: LauncherMarketplaceCertifiedAuthority
    token: string
    profileId: string
    runtimeGeneration: string
  }>
  readonly managedServiceUI?: WatchInjectionOptions['managedServiceUI']
  readonly executable?: string
  readonly prelaunchedHost?: Readonly<{
    child: ChildProcess
    hostPid?: number
    inspectorUrl?: Promise<string>
  }>
  readonly debugPort: number
  readonly hostArgs: readonly string[]
  readonly launcher: CordisXLauncherOptions
  readonly profile?: IsolatedCodexProfile
  readonly profileLease?: Awaited<ReturnType<typeof acquireCodexProfileLaunchLease>>
  readonly environment?: Readonly<Record<string, string>>
  readonly stdout: (line: string) => void
  readonly onReady?: (signal?: AbortSignal) => void | Promise<void>
  readonly onHostLaunched?: import('../launcher/process.js').HostLaunchIdentityObserver
  readonly mainInspector?: boolean
  readonly hiddenUntilReady?: boolean
  readonly startupNavigation?: WatchInjectionOptions['startupNavigation']
}): Promise<void> {
  const controller = new AbortController()
  let rendererIsReady = false
  let launched = input.prelaunchedHost?.child
  let removeHostObserver = launched === undefined
    ? undefined
    : observeHostExit(launched, input.stdout, () => rendererIsReady)
  const hostPid = (): number | undefined => input.prelaunchedHost?.hostPid ?? launched?.pid
  const lifecycle = (event: Parameters<typeof logHostLifecycle>[1]): void =>
    logHostLifecycle(input.stdout, event, { hostPid: hostPid(), ready: rendererIsReady })
  const stop = (signal: 'SIGINT' | 'SIGTERM'): void => {
    lifecycle({ event: 'launcher-signal', signal })
    controller.abort()
  }
  const interrupt = (): void => stop('SIGINT')
  const terminate = (): void => stop('SIGTERM')
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  let markReady!: () => void
  const rendererReady = new Promise<void>(resolve => {
    markReady = resolve
  })
  let reportedReady = false
  const watcher = watchAndInject({
    ...(input.nativeSubmission === undefined ? {} : { nativeSubmission: input.nativeSubmission }),
    port: input.debugPort,
    source: input.source,
    ...(input.newDocumentSource === undefined ? {} : { newDocumentSource: input.newDocumentSource }),
    signal: controller.signal,
    ...(input.providerFleet === undefined || input.providerBridgeToken === undefined ? {} : {
      providerFleet: input.providerFleet,
      providerBridgeToken: input.providerBridgeToken,
    }),
    agentHistoryHost: input.agentHistoryHost,
    agentHistoryBridgeToken: input.agentHistoryBridgeToken,
    ...(input.configBridge === undefined ? {} : { configBridge: input.configBridge }),
    ...(input.ownerDocuments === undefined ? {} : { ownerDocuments: input.ownerDocuments }),
    ...(input.serviceConfigBridge === undefined ? {} : { serviceConfigBridge: input.serviceConfigBridge }),
    ...(input.channelCredentialBridge === undefined ? {} : { channelCredentialBridge: input.channelCredentialBridge }),
    ...(input.channelActionsBridge === undefined ? {} : { channelActionsBridge: input.channelActionsBridge }),
    ...(input.permissionPersistence === undefined ? {} : { permissionPersistence: input.permissionPersistence }),
    ...(input.iconThemePreferencePersistence === undefined
      ? {}
      : { iconThemePreferencePersistence: input.iconThemePreferencePersistence }),
    ...(input.pluginLifecycle === undefined ? {} : { pluginLifecycle: input.pluginLifecycle }),
    ...(input.pluginManagement === undefined ? {} : { pluginManagement: input.pluginManagement }),
    ...(input.developmentRuntime === undefined ? {} : { developmentRuntime: input.developmentRuntime }),
    ...(input.viteDevelopment === true ? { viteDevelopment: true } : {}),
    hasLoopbackGraph: input.hasLoopbackGraph,
    launcherOwnedNativeTarget: !input.launcher.attach,
    ...(input.startupNavigation === undefined ? {} : { startupNavigation: input.startupNavigation }),
    ...(input.pluginArtifactOrigin === undefined ? {} : { pluginArtifactOrigin: input.pluginArtifactOrigin }),
    ...(input.productionGraphBootstrap === undefined
      ? {}
      : { productionGraphBootstrap: input.productionGraphBootstrap }),
    ...(input.publisherGrant === undefined ? {} : { publisherGrant: input.publisherGrant }),
    ...(input.certifiedPermission === undefined ? {} : { certifiedPermission: input.certifiedPermission }),
    ...(input.managedServiceUI === undefined ? {} : { managedServiceUI: input.managedServiceUI }),
    onReady: async () => {
      if (reportedReady) return
      reportedReady = true
      await completeHostReadiness(controller, async signal => {
        try {
          await input.onReady?.(signal)
        } catch (error) {
          lifecycle({ event: 'readiness-failed' })
          throw error
        }
      })
      rendererIsReady = true
      markReady()
      input.stdout('[cordisx] CDP renderer ready')
    },
    onStatus: message => input.stdout(`[cordisx] ${message}`),
  })
  let profileLease = input.profileLease
  let primaryError: unknown
  let retainProfileLease = false
  try {
    if (input.launcher.attach) {
      await Promise.race([waitForAbort(controller.signal), watcher])
      return
    }
    if (input.executable === undefined) throw new Error('host executable was not resolved')
    if (input.profile !== undefined && profileLease === undefined) {
      profileLease = await acquireCodexProfileLaunchLease(input.profile.userDataDir, { stdout: input.stdout })
    }
    if (input.prelaunchedHost === undefined) {
      const hidden = input.hiddenUntilReady === true
      const mainInspector = input.mainInspector === true && await supportsOwnedMainInspector(input.executable)
      if (hidden && !mainInspector) throw new Error('Hidden Host launch requires an owned main inspector')
      input.stdout(`[cordisx] launching ${input.executable} with CDP 127.0.0.1:${input.debugPort}`)
      const hiddenLaunch = hidden
        ? await launchCodexHidden(
          input.executable,
          input.debugPort,
          input.hostArgs,
          input.profile,
          input.launcher.onlineDevtools,
          input.environment,
          mainInspector ? await findFreeLoopbackPort() : undefined,
        )
        : undefined
      launched = hiddenLaunch?.child ?? launchCodex(
        input.executable,
        input.debugPort,
        input.hostArgs,
        input.profile,
        input.launcher.onlineDevtools,
        input.environment,
        mainInspector,
      )
      if (launched.pid === undefined) throw new Error('launched Host exposed no PID')
      removeHostObserver = observeHostExit(launched, input.stdout, () => rendererIsReady)
      const inspectorUrl = hiddenLaunch?.inspectorUrl ?? (mainInspector ? captureMainInspectorUrl(launched) : undefined)
      const ownershipVerified = await input.onHostLaunched?.(hiddenLaunch?.hostPid ?? launched.pid, inspectorUrl)
      if (hiddenLaunch) {
        if (ownershipVerified !== true) throw new Error('Hidden Host inspector identity was not confirmed')
        confirmHiddenCodexOwnership(hiddenLaunch)
      }
    } else {
      launched = input.prelaunchedHost.child
      if (launched.pid === undefined) throw new Error('prelaunched Host exposed no PID')
    }
    await Promise.race([
      waitForHostExitAfterReadiness({
        childExit: waitForExit(launched),
        ready: rendererReady,
        signal: controller.signal,
      }),
      watcher,
    ])
  } catch (error) {
    lifecycle({ event: 'lifecycle-failed' })
    primaryError = error
    retainProfileLease = retainProfileLeaseAfterHiddenHostFailure(error)
    if (retainProfileLease) {
      input.stdout('[cordisx] hidden Host identity is unresolved; profile launch lease retained to block unsafe retry')
    }
    throw error
  } finally {
    lifecycle({ event: 'cleanup-started' })
    controller.abort()
    const launchedHost = launched
    const cleanup = await settleInjectedHostCleanup({
      beforeHostTermination: [
        watcher,
        ...(input.providerFleet === undefined ? [] : [input.providerFleet.close()]),
        Promise.resolve(input.agentHistoryHost.dispose()),
      ],
      ...(launchedHost === undefined
        ? {}
        : {
          terminateHost: async () => {
            lifecycle({
              event: 'host-termination-requested',
              alreadyExited: launchedHost.exitCode !== null || launchedHost.signalCode !== null,
            })
            await terminateIsolatedCodex(launchedHost, input.profile)
          },
        }),
    })
    const hostTermination = launchedHost === undefined ? undefined : cleanup.at(-1)
    const leaseCleanup = hostTermination?.status === 'rejected' || retainProfileLease
      ? []
      : await Promise.allSettled([profileLease?.release() ?? Promise.resolve()])
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
    removeHostObserver?.()
    if (primaryError !== undefined) {
      for (const result of [...cleanup, ...leaseCleanup]) {
        if (result.status === 'rejected') {
          input.stdout(`[cordisx] cleanup failed: ${String((result as PromiseRejectedResult).reason)}`)
        }
      }
    }
    if (primaryError === undefined) {
      const rejected = cleanup.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (rejected !== undefined) throw rejected.reason
      for (const result of leaseCleanup) {
        if (result.status === 'rejected') throw result.reason
      }
    }
  }
}
