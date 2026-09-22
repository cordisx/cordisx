import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { HomeConfigIconThemePreference } from '../config/home-config.js'
import { loadHomeConfig } from '../config/home-config.js'
import { buildRendererBundle, type BuildRendererBundleOptions } from '../launcher/bundle.js'
import type { CdpPluginLifecycleRuntime, WatchInjectionOptions } from '../launcher/cdp.js'
import { type CordisXConfig, loadConfig } from '../launcher/config.js'
import { HostGenerationGraphOwner, type HostGenerationGraphSource } from '../launcher/host-generation-graph.js'
import { equivalentPluginActivation, type PluginActivationStore } from '../launcher/plugin-activation.js'
import { PluginBundleCoordinator } from '../launcher/plugin-bundle.js'
import { loadPluginComposition } from '../launcher/plugin-composition.js'
import type { PluginGenerationArtifactServer } from '../launcher/plugin-generation-loader.js'
import type { PluginLifecycleCoordinator } from '../launcher/plugin-lifecycle.js'
import type { ManagedServicePluginLifecycleRuntime } from '../launcher/managed-service-plugin-lifecycle.js'
import { loadStagedPluginPackage, stagedPluginBrowserArtifactDirectory } from '../launcher/plugin-package.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import type { CordisXPluginBundleManagerSnapshotV1 } from '../plugin-bundle-contracts.js'
import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'

export type ChannelManagerBundleProjection = NonNullable<Parameters<typeof buildRendererBundle>[1]>['channelManager']

export interface RendererComposition {
  readonly source: string
  /** Exact production graph source used only by repository authority integration probes. */
  readonly authoritySource: () => string
  readonly newDocumentSource?: string
  readonly hasLoopbackGraph: boolean
  readonly providerBridgeToken?: string
  readonly agentHistoryBridgeToken: string
  readonly configBridgeToken?: string
  readonly ownerDocumentSecret: string
  readonly serviceConfigBridgeToken?: string
  readonly generation: string
  readonly permissionBridgeToken?: string
  readonly iconThemePreferenceBridgeToken?: string
  readonly pluginLifecycleBridgeToken?: string
  readonly pluginManagementBridgeToken?: string
  readonly managedServiceUICapabilities?: readonly {
    readonly pluginId: string
    readonly pluginGeneration: string
    readonly token: string
  }[]
  readonly rebuild: (
    config: CordisXConfig,
    pluginActivation: CordisXPluginActivationRecordV1,
    initialRegistryEpoch: number,
    current?: Readonly<{
      permissionPolicies: readonly CordisXPersistedPermissionPolicyRecord[]
      pluginBundles: CordisXPluginBundleManagerSnapshotV1
      channelManager?: ChannelManagerBundleProjection
      managedServiceUICapabilities?: readonly {
        readonly pluginId: string
        readonly pluginGeneration: string
        readonly token: string
      }[]
    }>,
  ) => Promise<Readonly<{ source: string; newDocumentSource?: string }>>
  /** Releases every launch-scoped Host graph after the launcher drains CDP. */
  close(): Promise<void>
}

export interface BuildRendererCompositionOptions {
  readonly profileId?: string
  readonly appId?: string
  readonly iconThemePreference?: HomeConfigIconThemePreference
  readonly writable?: boolean
  readonly serviceConfigWritable?: boolean
  readonly permission?: {
    readonly profileId: string
    readonly policies: readonly CordisXPersistedPermissionPolicyRecord[]
    readonly persistent: boolean
  }
  readonly generation?: string
  readonly pluginLifecycle?: {
    readonly token: string
    readonly activation: CordisXPluginActivationRecordV1
    readonly registryEpoch?: number
  }
  readonly pluginManagement?: { readonly token: string; readonly profileId: string }
  readonly pluginBundles?: CordisXPluginBundleManagerSnapshotV1
  readonly certifiedPermissionChannelToken?: string
  readonly pluginActivation?: CordisXPluginActivationRecordV1
  readonly initialRegistryEpoch?: number
  readonly channelManager?: ChannelManagerBundleProjection
  /** Transient, launcher-created tokens. They are published only in the injected runtime metadata. */
  readonly channelCredentialBridgeToken?: string
  readonly channelActionsBridgeToken?: string
  readonly managedServiceUICapabilities?: readonly {
    readonly pluginId: string
    readonly pluginGeneration: string
    readonly token: string
  }[]
  readonly internalBuildRendererBundle?: typeof buildRendererBundle
  /** Launcher-owned native production uses the immutable Host graph. */
  readonly productionGraph?: boolean
  /** Test or embedder override for the persistent stable Host graph cache. */
  readonly productionGraphCacheRoot?: string
  /** Opt-in development transport; normal launches keep immutable package delivery. */
  readonly developmentBuild?: typeof buildRendererBundle
}

/** Build the exact renderer composition that the launcher will inject through CDP. */
export async function buildRendererComposition(
  config: CordisXConfig,
  stdout: (line: string) => void,
  options: BuildRendererCompositionOptions = {},
): Promise<RendererComposition> {
  const providerBridgeToken = (config.codex.agentLoopBackend === 'local-cli'
      || config.providers.some(provider => provider.enabled)
      || config.plugins.some(plugin => plugin.enabled && plugin.id === 'cli-proxy-api'))
    ? randomBytes(32).toString('hex')
    : undefined
  const agentHistoryBridgeToken = randomBytes(32).toString('hex')
  const configBridgeToken = options.writable === true ? randomBytes(32).toString('hex') : undefined
  const ownerDocumentSecret = randomBytes(32).toString('hex')
  const serviceConfigBridgeToken = (options.serviceConfigWritable ?? options.writable) === true
    ? randomBytes(32).toString('hex')
    : undefined
  const permissionBridgeToken = options.permission?.persistent === true ? randomBytes(32).toString('hex') : undefined
  const iconThemePreferenceBridgeToken = options.writable === true && options.appId !== undefined
    ? randomBytes(32).toString('hex')
    : undefined
  const generation = options.generation ?? randomBytes(16).toString('hex')
  const profileId = options.permission?.profileId ?? options.profileId ?? 'development'
  const bundleOptions: BuildRendererBundleOptions = {
    ...(providerBridgeToken === undefined ? {} : { providerBridgeToken }),
    agentHistoryBridgeToken,
    ...(configBridgeToken === undefined ? {} : { configBridgeToken }),
    ownerDocumentAuthority: { secret: ownerDocumentSecret, profileId, generation },
    ...(serviceConfigBridgeToken === undefined ? {} : { serviceConfigBridgeToken }),
    ...(options.appId === undefined ? {} : { appId: options.appId }),
    ...(options.iconThemePreference === undefined ? {} : { iconThemePreference: options.iconThemePreference }),
    ...(iconThemePreferenceBridgeToken === undefined ? {} : { iconThemePreferenceBridgeToken }),
    ...(options.channelCredentialBridgeToken === undefined
      ? {}
      : { channelCredentialBridgeToken: options.channelCredentialBridgeToken }),
    ...(options.channelActionsBridgeToken === undefined
      ? {}
      : { channelActionsBridgeToken: options.channelActionsBridgeToken }),
    ...(options.managedServiceUICapabilities === undefined
      ? {}
      : { managedServiceUICapabilities: options.managedServiceUICapabilities }),
    ...(options.permission === undefined
      ? (options.profileId === undefined ? {} : { profileId: options.profileId })
      : {
        profileId: options.permission.profileId,
        permission: {
          profileId: options.permission.profileId,
          policies: options.permission.policies,
          ...(permissionBridgeToken === undefined ? {} : { bridgeToken: permissionBridgeToken }),
        },
      }),
    generation,
    ...(options.pluginLifecycle === undefined ? {} : { pluginLifecycleBridgeToken: options.pluginLifecycle.token }),
    ...(options.pluginManagement === undefined ? {} : { pluginManagement: options.pluginManagement }),
    ...(options.pluginBundles === undefined ? {} : { pluginBundleSnapshot: options.pluginBundles }),
    ...((options.pluginActivation ?? options.pluginLifecycle?.activation) === undefined
      ? {}
      : { pluginActivation: options.pluginActivation ?? options.pluginLifecycle!.activation }),
    ...((options.initialRegistryEpoch ?? options.pluginLifecycle?.registryEpoch) === undefined
      ? {}
      : { initialRegistryEpoch: options.initialRegistryEpoch ?? options.pluginLifecycle!.registryEpoch }),
    ...(options.channelManager === undefined ? {} : { channelManager: options.channelManager }),
  }
  const buildBundle = options.developmentBuild ?? options.internalBuildRendererBundle ?? buildRendererBundle
  const hostGraphs = new HostGenerationGraphOwner(options.productionGraphCacheRoot)
  const buildProductionSource = async (
    nextConfig: CordisXConfig,
    nextOptions: BuildRendererBundleOptions,
  ): Promise<HostGenerationGraphSource> => {
    if (
      options.productionGraph !== true || options.developmentBuild !== undefined
      || options.internalBuildRendererBundle !== undefined
    ) {
      const source = await buildBundle(nextConfig, nextOptions)
      return { source, authoritySource: () => source }
    }
    return await hostGraphs.build(nextConfig, nextOptions)
  }
  const { built, newDocumentBuild } = await hostGraphs.transaction(async () => {
    const builds = await Promise.allSettled([
      buildProductionSource(config, bundleOptions),
      ...(options.certifiedPermissionChannelToken === undefined
        ? []
        : [buildProductionSource(config, {
          ...bundleOptions,
          certifiedPermissionChannelToken: options.certifiedPermissionChannelToken,
        })]),
    ])
    const rejected = builds.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (rejected !== undefined) throw rejected.reason
    return {
      built: (builds[0] as PromiseFulfilledResult<HostGenerationGraphSource>).value,
      ...(builds[1] === undefined
        ? {}
        : { newDocumentBuild: (builds[1] as PromiseFulfilledResult<HostGenerationGraphSource>).value }),
    }
  })
  const source = built.source
  const newDocumentSource = newDocumentBuild?.source
  const enabled = config.plugins.filter(plugin => plugin.enabled).map(plugin => plugin.id)
  const hasLoopbackGraph = options.productionGraph === true && options.developmentBuild === undefined
      && options.internalBuildRendererBundle === undefined
    || config.plugins.some(plugin => plugin.enabled && plugin.runtimeGraph !== undefined)
  stdout(
    `[cordisx] ${
      options.developmentBuild === undefined ? 'bundle' : 'Vite entry'
    } ready: ${source.length} bytes, plugins: ${enabled.join(', ') || '(none)'}`,
  )
  return {
    source,
    authoritySource: built.authoritySource,
    ...(newDocumentSource === undefined ? {} : { newDocumentSource }),
    hasLoopbackGraph,
    ...(providerBridgeToken === undefined ? {} : { providerBridgeToken }),
    agentHistoryBridgeToken,
    ...(configBridgeToken === undefined ? {} : { configBridgeToken }),
    ownerDocumentSecret,
    ...(serviceConfigBridgeToken === undefined ? {} : { serviceConfigBridgeToken }),
    generation,
    ...(permissionBridgeToken === undefined ? {} : { permissionBridgeToken }),
    ...(iconThemePreferenceBridgeToken === undefined ? {} : { iconThemePreferenceBridgeToken }),
    ...(options.pluginLifecycle === undefined ? {} : { pluginLifecycleBridgeToken: options.pluginLifecycle.token }),
    ...(options.pluginManagement === undefined ? {} : { pluginManagementBridgeToken: options.pluginManagement.token }),
    ...(options.managedServiceUICapabilities === undefined
      ? {}
      : { managedServiceUICapabilities: options.managedServiceUICapabilities }),
    rebuild: async (nextConfig, pluginActivation, initialRegistryEpoch, current) => {
      const currentBundleOptions: BuildRendererBundleOptions = current === undefined
        ? bundleOptions
        : (() => {
          const {
            channelManager: _channelManager,
            managedServiceUICapabilities: _managedServiceUICapabilities,
            pluginBundleSnapshot: _pluginBundleSnapshot,
            ...stable
          } = bundleOptions
          void _channelManager
          void _managedServiceUICapabilities
          void _pluginBundleSnapshot
          return {
            ...stable,
            pluginBundleSnapshot: current.pluginBundles,
            ...(current.channelManager === undefined ? {} : { channelManager: current.channelManager }),
            ...(current.managedServiceUICapabilities === undefined
              ? {}
              : { managedServiceUICapabilities: current.managedServiceUICapabilities }),
          }
        })()
      const rebuildOptions: BuildRendererBundleOptions = {
        ...currentBundleOptions,
        ...(
          current === undefined || bundleOptions.permission === undefined
            ? {}
            : { permission: { ...bundleOptions.permission, policies: current.permissionPolicies } }
        ),
        ownerDocumentAuthority: { secret: ownerDocumentSecret, profileId, generation },
        pluginActivation,
        initialRegistryEpoch,
      }
      const { rebuilt, rebuiltNewDocument } = await hostGraphs.transaction(async () => {
        const builds = await Promise.allSettled([
          buildProductionSource(nextConfig, rebuildOptions),
          ...(options.certifiedPermissionChannelToken === undefined
            ? []
            : [buildProductionSource(nextConfig, {
              ...rebuildOptions,
              certifiedPermissionChannelToken: options.certifiedPermissionChannelToken,
            })]),
        ])
        const rejected = builds.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (rejected !== undefined) throw rejected.reason
        return {
          rebuilt: (builds[0] as PromiseFulfilledResult<HostGenerationGraphSource>).value,
          ...(builds[1] === undefined
            ? {}
            : { rebuiltNewDocument: (builds[1] as PromiseFulfilledResult<HostGenerationGraphSource>).value }),
        }
      })
      return {
        source: rebuilt.source,
        ...(rebuiltNewDocument === undefined ? {} : { newDocumentSource: rebuiltNewDocument.source }),
      }
    },
    async close() {
      await hostGraphs.close()
    },
  }
}

export function assertProductionGraphBootstrapSnapshot(
  expectedActive: CordisXPluginActivationRecordV1,
  expectedRegistryEpoch: number,
  current: Readonly<{
    active: CordisXPluginActivationRecordV1
    registryEpoch: number
  }>,
): void {
  if (
    !equivalentPluginActivation(current.active, expectedActive)
    || current.registryEpoch !== expectedRegistryEpoch
  ) throw new Error('browser graph admission activation snapshot is stale')
}

function configuredPluginTopology(config: CordisXConfig): string {
  return JSON.stringify(config.plugins.map(plugin => ({
    id: plugin.id,
    entry: plugin.entry,
    source: plugin.source,
    enabled: plugin.enabled,
  })))
}

function usesIsolatedPackageWorker(plugin: CordisXConfig['plugins'][number]): boolean {
  const manifest = plugin.manifest
  return manifest?.schemaVersion === 7
    || ((manifest?.schemaVersion === 5 || manifest?.schemaVersion === 6)
      && manifest.capabilities.some(capability => (
        capability.name === 'ui.host-dom.read' || capability.name === 'ui.host-dom.modify'
      )))
}

export async function attachActiveBrowserGraphs(input: {
  readonly plugins: CordisXConfig['plugins']
  readonly homeDir: string
  readonly artifactServer: PluginGenerationArtifactServer
  readonly lifecycleRuntime: CdpPluginLifecycleRuntime
}): Promise<CordisXConfig['plugins']> {
  return await Promise.all(input.plugins.map(async plugin => {
    if (!plugin.enabled || plugin.package === undefined || usesIsolatedPackageWorker(plugin)) return plugin
    const staged = await loadStagedPluginPackage(input.homeDir, plugin.package.digest)
    if (staged.browserArtifact === undefined) return plugin
    const lease = await input.artifactServer.lease(
      {
        packageIdentity: {
          pluginId: plugin.id,
          version: plugin.package.version,
          integrity: plugin.package.digest,
        },
        artifactDirectory: stagedPluginBrowserArtifactDirectory(input.homeDir, plugin.package.digest),
        runtimeEntry: staged.browserArtifact.manifest.entry,
      },
      plugin.package.moduleGeneration,
      staged.browserArtifact.manifest,
    )
    input.lifecycleRuntime.registerActivePluginGenerationLease(lease)
    return {
      ...plugin,
      runtimeGraph: {
        moduleGeneration: lease.moduleGeneration,
        loadSource: lease.importSource,
        publishSource: lease.publishSource,
        retireSource: lease.retireSource,
      },
    }
  }))
}

/** Bind plugin-bundle claims and managed-service projections to one renderer lifecycle generation. */
export function createRendererLifecycleProjection(input: {
  readonly homeDir: string
  readonly profileId: string
  readonly generation: string
  readonly pluginLifecycleCoordinator: PluginLifecycleCoordinator
  readonly lifecycleRuntime: CdpPluginLifecycleRuntime
  readonly managedServiceLifecycleRuntime: ManagedServicePluginLifecycleRuntime
}) {
  const token = randomBytes(32).toString('hex')
  const pluginBundleCoordinator = new PluginBundleCoordinator({
    homeDir: input.homeDir,
    profileId: input.profileId,
    runtimeGeneration: input.generation,
    pluginLifecycle: input.pluginLifecycleCoordinator,
  })
  input.pluginLifecycleCoordinator.setBundleClaimGuard(async pluginId =>
    await pluginBundleCoordinator.bundleClaims(pluginId)
  )
  return {
    token,
    pluginBundleCoordinator,
    pluginLifecycle: {
      handler: {
        token,
        profileId: input.profileId,
        generation: input.generation,
        coordinator: input.pluginLifecycleCoordinator,
        bundleCoordinator: pluginBundleCoordinator,
      },
      runtime: input.lifecycleRuntime,
    },
    managedServiceActivation: input.managedServiceLifecycleRuntime.nativeActivation(),
    managedServiceUICapabilities: input.managedServiceLifecycleRuntime.capabilities(),
    managedServiceUI: input.managedServiceLifecycleRuntime.managedServiceUI,
  }
}

export function createProductionGraphBootstrap(input: {
  readonly rendererComposition: RendererComposition
  readonly configuredComposition: CordisXConfig
  readonly configPath: string
  readonly profileId: string
  readonly lifecycleStore: PluginActivationStore
  readonly lifecycleRuntime: CdpPluginLifecycleRuntime
  readonly pluginBundleCoordinator: PluginBundleCoordinator
  readonly managedServiceLifecycleRuntime: ManagedServicePluginLifecycleRuntime
  readonly loadChannelManagerProjection: () => Promise<ChannelManagerBundleProjection | undefined>
}): NonNullable<WatchInjectionOptions['productionGraphBootstrap']> {
  const initialConfiguredTopology = configuredPluginTopology(input.configuredComposition)
  const loadCurrentProjection = async () => {
    const active = await input.lifecycleStore.loadActive()
    const registryEpoch = input.lifecycleRuntime.currentRegistryEpoch()
    const [freshConfigured, packagePlugins, freshHomeConfig, pluginBundles, channelManager] = await Promise.all([
      loadConfig(input.configPath, { profileId: input.profileId, projectRoot: path.dirname(input.configPath) }),
      loadPluginComposition(input.lifecycleStore, active),
      loadHomeConfig(input.configPath),
      input.pluginBundleCoordinator.snapshot(),
      input.loadChannelManagerProjection(),
    ])
    if (configuredPluginTopology(freshConfigured) !== initialConfiguredTopology) {
      throw new Error('launcher-configured plugin topology changed during browser graph admission')
    }
    if (pluginBundles.pluginRevision !== active.revision) {
      throw new Error('plugin bundle projection does not match the active plugin revision')
    }
    const currentPackagePlugins = await Promise.all(packagePlugins.map(async plugin => {
      if (!plugin.enabled || plugin.package === undefined || usesIsolatedPackageWorker(plugin)) return plugin
      const staged = await loadStagedPluginPackage(path.dirname(input.configPath), plugin.package.digest)
      if (staged.browserArtifact === undefined) return plugin
      const runtimeGraph = input.lifecycleRuntime.activeBrowserGraph(plugin.id, plugin.package.moduleGeneration)
      if (runtimeGraph === undefined) {
        throw new Error(`active browser graph lease is unavailable for plugin ${plugin.id}`)
      }
      return { ...plugin, runtimeGraph }
    }))
    const permissionPolicies = freshHomeConfig.permissions.filter(policy => policy.key.profileId === input.profileId)
    const managedServiceUICapabilities = input.managedServiceLifecycleRuntime.capabilities()
    const currentComposition: CordisXConfig = {
      ...freshConfigured,
      plugins: [...freshConfigured.plugins, ...currentPackagePlugins],
    }
    return {
      active,
      registryEpoch,
      currentComposition,
      permissionPolicies,
      pluginBundles,
      channelManager,
      managedServiceUICapabilities,
      fingerprint: JSON.stringify({
        active,
        registryEpoch,
        currentComposition,
        permissionPolicies,
        pluginBundles,
        channelManager,
        managedServiceUICapabilities,
      }),
    }
  }
  return async (expectedActive, expectedRegistryEpoch) => {
    const before = await loadCurrentProjection()
    assertProductionGraphBootstrapSnapshot(expectedActive, expectedRegistryEpoch, before)
    const rebuilt = await input.rendererComposition.rebuild(
      before.currentComposition,
      before.active,
      expectedRegistryEpoch,
      {
        permissionPolicies: before.permissionPolicies,
        pluginBundles: before.pluginBundles,
        managedServiceUICapabilities: before.managedServiceUICapabilities,
        ...(before.channelManager === undefined ? {} : { channelManager: before.channelManager }),
      },
    )
    const after = await loadCurrentProjection()
    if (after.fingerprint !== before.fingerprint) {
      throw new Error('browser graph admission projection changed during source rebuild')
    }
    return rebuilt
  }
}
