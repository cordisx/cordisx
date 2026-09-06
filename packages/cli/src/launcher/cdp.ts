import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import { CdpPluginLifecycleRuntime } from './cdp-plugin-lifecycle-runtime.js'
import { install } from './cdp-installation.js'
import * as support from './cdp-installation-support.js'
import {
  type ProductionGraphBootstrap,
  type ProductionGraphOperations,
  promoteProductionGraph,
  refreshProductionGraphBootstraps,
} from './production-graph-admission.js'

export { CdpPluginLifecycleRuntime } from './cdp-plugin-lifecycle-runtime.js'
export { CdpLifecycleRequestGate } from './production-graph-admission.js'
export {
  iconThemePreferenceDeliveryEvaluation,
  RENDERER_DISPOSE_EXPRESSION,
  resolveCdpInjectionTimeoutMs,
  serviceConfigResponseEvaluation,
} from './cdp-installation-support.js'
export { runtimeEvaluationException } from './cdp-session.js'

export interface CdpTarget {
  readonly id: string
  readonly type: string
  readonly title: string
  readonly url: string
  readonly webSocketDebuggerUrl?: string
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    signal?.addEventListener('abort', finish, { once: true })
    if (signal?.aborted === true) finish()
  })
}

/** Read the current Electron target table from the loopback debugging endpoint. */
export async function listTargets(port: number): Promise<CdpTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) })
  if (!response.ok) throw new Error(`CDP target list returned HTTP ${response.status}`)
  const value = await response.json() as unknown
  if (!Array.isArray(value)) throw new Error('CDP target list is not an array')
  return value.filter((item): item is CdpTarget => {
    return item !== null && typeof item === 'object' && typeof (item as CdpTarget).id === 'string'
  })
}

function injectable(target: CdpTarget): boolean {
  return target.type === 'page'
    && typeof target.webSocketDebuggerUrl === 'string'
    && !target.url.startsWith('devtools://')
    && !target.url.includes('initialRoute=%2Favatar-overlay')
}

function targetScore(target: CdpTarget): number {
  const label = `${target.title} ${target.url}`.toLowerCase()
  return label.includes('codex') ? 10 : label.includes('chatgpt') ? 5 : 0
}

/** Select only renderer pages visibly associated with Codex/ChatGPT. */
export function injectableTargets(targets: readonly CdpTarget[]): CdpTarget[] {
  const pages = targets.filter(injectable).sort((left, right) => targetScore(right) - targetScore(left))
  return pages.filter(target => targetScore(target) > 0)
}

function nativeAppTarget(target: CdpTarget): boolean {
  return target.url === 'app://-' || target.url.startsWith('app://-/')
}

export interface WatchInjectionOptions {
  /** Opt-in Vite development only: allow loopback modules, await boot, restore on exit. */
  readonly viteDevelopment?: boolean
  /** Host-owned launch-scoped immutable plugin module origin. */
  readonly pluginArtifactOrigin?: string
  /** Production composition contains at least one immutable loopback module graph. */
  readonly hasLoopbackGraph?: boolean
  /** Production compatibility reload is restricted to a Host process launched by this watcher. */
  readonly launcherOwnedNativeTarget?: boolean
  /** Rebuild the exact current last-good renderer before the first production browser graph is admitted. */
  readonly productionGraphBootstrap?: (
    active: CordisXPluginActivationRecordV1,
    registryEpoch: number,
  ) => Promise<ProductionGraphBootstrap>
  readonly port: number
  /** Latest immutable bootstrap. Existing renderers are never reinjected when it changes. */
  readonly source: string | (() => string)
  /** Bootstrap for future fresh documents; current live documents use `source`. */
  readonly newDocumentSource?: string | (() => string)
  readonly signal: AbortSignal
  readonly onStatus?: (message: string) => void
  /** Called after the first renderer accepts the CordisX bootstrap. */
  readonly onReady?: () => void
  readonly providerFleet?: support.ProviderFleet
  readonly providerBridgeToken?: string
  readonly agentHistoryHost?: support.CodexAgentHistoryHost
  readonly agentHistoryBridgeToken?: string
  readonly configBridge?: support.ConfigBridgeHandler
  readonly ownerDocuments?: support.OwnerDocumentBridgeHandler
  readonly serviceConfigBridge?: support.ServiceConfigBridgeHandler
  readonly channelCredentialBridge?: support.ChannelCredentialBridgeHandler
  readonly channelActionsBridge?: support.ChannelActionsBridgeHandler
  readonly permissionPersistence?: support.PermissionPersistenceContext
  readonly iconThemePreferencePersistence?: support.IconThemePreferencePersistenceContext
  /** Host-private injection seam for profile-wide launcher integration tests. */
  readonly iconThemePreferenceBroadcastHub?: support.IconThemePreferenceBroadcastHub
  readonly pluginLifecycle?: {
    readonly handler: support.PluginLifecycleBridgeHandler
    readonly runtime: CdpPluginLifecycleRuntime
  }
  /** Host-private generation plane used by `cordisx dev`; it installs no public lifecycle binding. */
  readonly developmentRuntime?: CdpPluginLifecycleRuntime
  readonly publisherGrant?: support.PublisherGrantBridgeHandler
  readonly certifiedPermission?: Readonly<{
    authority: support.LauncherMarketplaceCertifiedAuthority
    token: string
    profileId: string
    runtimeGeneration: string
  }>
}

/** Track every current Codex page and keep one removable bootstrap installed per target. */
export async function watchAndInject(options: WatchInjectionOptions): Promise<void> {
  if (options.hasLoopbackGraph === true && options.pluginArtifactOrigin === undefined) {
    throw new Error('production loopback graph requires its exact artifact origin')
  }
  if (options.hasLoopbackGraph === true && options.launcherOwnedNativeTarget !== true) {
    throw new Error('production loopback graph compatibility requires a launcher-owned native target')
  }
  if (options.pluginArtifactOrigin !== undefined) {
    const artifactOrigin = new URL(options.pluginArtifactOrigin)
    if (
      artifactOrigin.protocol !== 'http:' || artifactOrigin.hostname !== '127.0.0.1'
      || artifactOrigin.pathname !== '/' || artifactOrigin.search !== '' || artifactOrigin.hash !== ''
    ) {
      throw new Error('plugin artifact origin must be an exact IPv4 loopback HTTP origin')
    }
  }
  const installed = new Map<string, support.InstalledScript>()
  const viteLoopbackPermissions = new support.ViteLoopbackPermissionCoordinator(options.port)
  const hostMutationGate = new support.CdpLifecycleRequestGate()
  let fatalProductionGraphError: unknown
  let latestProductionBootstrap: ProductionGraphBootstrap | undefined
  const latchProductionGraphError = (error: unknown): void => {
    fatalProductionGraphError ??= error
  }
  const productionGraphOperations: ProductionGraphOperations<support.InstalledScript> = {
    injectionTimeoutMs: support.CDP_INJECTION_TIMEOUT_MS,
    permissions: viteLoopbackPermissions,
    signal: options.signal,
    mutateDocumentScript: async (session, method, params, signal) =>
      await support.abortable(session.send(method, params, support.CDP_INJECTION_TIMEOUT_MS), signal),
    isNativeTarget: target => nativeAppTarget(target as CdpTarget),
    replace: (current, replacement) => {
      installed.set(current.target.id, { ...current, ...replacement })
    },
    disposeRenderer: async record => {
      await support.evaluateRuntimeOperation(
        record.session,
        support.RENDERER_DISPOSE_EXPRESSION,
        support.CDP_INJECTION_TIMEOUT_MS,
      )
    },
    waitForBootstrap: async (record, installId, deadline, signal) => {
      await support.waitForProductionBootstrap(record.session, installId, deadline, signal)
    },
  }
  const iconThemePreferenceBroadcast = options.iconThemePreferencePersistence === undefined
    ? undefined
    : options.iconThemePreferenceBroadcastHub ?? new support.IconThemePreferenceBroadcastHub(
      options.iconThemePreferencePersistence.appId,
      options.iconThemePreferencePersistence.profileId,
    )
  if (iconThemePreferenceBroadcast !== undefined && options.iconThemePreferencePersistence !== undefined) {
    iconThemePreferenceBroadcast.assertScope(options.iconThemePreferencePersistence)
  }
  if (options.pluginLifecycle !== undefined) {
    if (options.hasLoopbackGraph === true) options.pluginLifecycle.runtime.markBrowserGraphTransportReady()
    options.pluginLifecycle.runtime.setBrowserGraphTerminalError(latchProductionGraphError)
    options.pluginLifecycle.runtime.setBrowserGraphAdmission(
      options.launcherOwnedNativeTarget !== true
        || options.pluginArtifactOrigin === undefined
        || options.productionGraphBootstrap === undefined
        ? undefined
        : async input =>
          await hostMutationGate.exclusive(async () => {
            const records = input.sessions.map(session =>
              [...installed.values()].find(record => record.session === session)
            )
            if (records.some(record => record === undefined)) {
              throw new Error('browser graph admission renderer set is stale')
            }
            const bootstrap = await options.productionGraphBootstrap!(input.active, input.expectedRegistryEpoch)
            try {
              const promotion = await promoteProductionGraph(
                records as support.InstalledScript[],
                bootstrap,
                productionGraphOperations,
              )
              return {
                commit: () => {
                  latestProductionBootstrap = bootstrap
                },
                rollback: async () => {
                  try {
                    await promotion.rollback()
                  } catch (error) {
                    latchProductionGraphError(error)
                    throw error
                  }
                },
              }
            } catch (error) {
              if (
                error instanceof AggregateError
                && error.message.includes('compensation was incomplete')
              ) latchProductionGraphError(error)
              throw error
            }
          }),
    )
    options.pluginLifecycle.runtime.setBrowserGraphBootstrapRefresh(
      options.launcherOwnedNativeTarget !== true
        || options.pluginArtifactOrigin === undefined
        || options.productionGraphBootstrap === undefined
        ? undefined
        : async (active, registryEpoch) =>
          await hostMutationGate.exclusive(async () => {
            const bootstrap = await options.productionGraphBootstrap!(active, registryEpoch)
            try {
              await refreshProductionGraphBootstraps(
                [...installed.values()],
                bootstrap,
                productionGraphOperations,
              )
              latestProductionBootstrap = bootstrap
            } catch (error) {
              if (
                error instanceof AggregateError
                && error.message.includes('compensation was incomplete')
              ) latchProductionGraphError(error)
              throw error
            }
          }),
    )
  }
  let watcherFailure: unknown
  try {
    while (!options.signal.aborted) {
      let attemptedReloadTarget: 'Vite' | 'production' | undefined
      try {
        await hostMutationGate.exclusive(async () => {
          if (fatalProductionGraphError !== undefined) {
            attemptedReloadTarget = 'production'
            throw fatalProductionGraphError
          }
          const candidates = injectableTargets(await listTargets(options.port))
          const browserGraphTransport = options.hasLoopbackGraph === true
            || options.pluginLifecycle?.runtime.requiresBrowserGraphTransport() === true
          const targets = options.viteDevelopment === true || browserGraphTransport
            ? candidates.filter(nativeAppTarget)
            : candidates
          if (browserGraphTransport && candidates.length > 0 && targets.length === 0) {
            attemptedReloadTarget = 'production'
            throw new Error('production loopback graph requires a native app:// renderer target')
          }
          const live = new Set(targets.map(target => target.id))
          for (const [id, record] of installed) {
            if (live.has(id)) continue
            await support.uninstall(record, viteLoopbackPermissions)
            installed.delete(id)
          }
          for (const target of targets) {
            const current = installed.get(target.id)
            if (
              current !== undefined
              && current.target.webSocketDebuggerUrl === target.webSocketDebuggerUrl
              && !current.session.isClosed()
            ) continue
            let stale: support.InstalledScript | undefined
            if (current !== undefined) {
              await support.uninstall(current, viteLoopbackPermissions)
              installed.delete(target.id)
              stale = current
            }
            const provider = options.providerFleet === undefined || options.providerBridgeToken === undefined
              ? undefined
              : { fleet: options.providerFleet, token: options.providerBridgeToken }
            const history = options.agentHistoryHost === undefined || options.agentHistoryBridgeToken === undefined
              ? undefined
              : { host: options.agentHistoryHost, token: options.agentHistoryBridgeToken }
            const selectedSource = latestProductionBootstrap?.source
              ?? (typeof options.source === 'string'
                ? options.source
                : options.source())
            const selectedNewDocumentSource = latestProductionBootstrap === undefined
              ? options.newDocumentSource === undefined
                ? undefined
                : typeof options.newDocumentSource === 'string'
                ? options.newDocumentSource
                : options.newDocumentSource()
              : latestProductionBootstrap.newDocumentSource
            if (selectedSource === undefined) {
              throw new Error('current production browser graph bootstrap is unavailable')
            }
            attemptedReloadTarget = options.viteDevelopment === true
              ? 'Vite'
              : browserGraphTransport
              ? 'production'
              : undefined
            const record = await install(
              target,
              selectedSource,
              provider,
              history,
              options.configBridge,
              options.ownerDocuments,
              options.serviceConfigBridge,
              options.channelCredentialBridge,
              options.channelActionsBridge,
              options.permissionPersistence,
              options.iconThemePreferencePersistence,
              iconThemePreferenceBroadcast,
              options.pluginLifecycle,
              options.developmentRuntime,
              options.publisherGrant,
              options.certifiedPermission,
              selectedNewDocumentSource,
              stale,
              options.viteDevelopment,
              options.viteDevelopment === true || browserGraphTransport,
              viteLoopbackPermissions,
              options.signal,
              hostMutationGate,
            )
            installed.set(target.id, record)
            options.onReady?.()
            options.onStatus?.(`injected target ${target.id} (${target.title || target.url})`)
          }
        })
      } catch (error) {
        if (options.signal.aborted) {
          if (error instanceof support.CdpInstallationAbortedError) break
          throw error
        }
        if (attemptedReloadTarget !== undefined) {
          throw new AggregateError(
            [error],
            `CordisX ${attemptedReloadTarget} renderer installation failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }
        options.onStatus?.(`waiting for Codex CDP on 127.0.0.1:${options.port}: ${String(error)}`)
      }
      await delay(750, options.signal)
    }
  } catch (error) {
    watcherFailure = error
  } finally {
    const cleanup = await hostMutationGate.closeAndDrain(async () =>
      await Promise.allSettled(
        [...installed.values()].map(record => support.uninstall(record, viteLoopbackPermissions)),
      )
    )
    const failures = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) {
      throw new AggregateError(
        watcherFailure === undefined ? failures : [watcherFailure, ...failures],
        `CordisX renderer cleanup failed: ${
          failures.map(error => error instanceof Error ? error.message : String(error)).join('; ')
        }`,
      )
    }
  }
  if (watcherFailure !== undefined) throw watcherFailure
}
