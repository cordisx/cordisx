import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import type { ChildProcess } from 'node:child_process'
import { resolveHostAdapter } from '../adapters/registry.js'
import type { ResolvedLaunchPlan } from '../adapters/contracts.js'
import {
  ensureCordisXHomeDirectory,
  ensureHomeConfig,
  type HomeConfigIconThemePreference,
  type HomeConfigPathOptions,
  loadHomeConfig,
  resolveHomeConfigPath,
} from '../config/home-config.js'
import { buildRendererBundle, type BuildRendererBundleOptions } from '../launcher/bundle.js'
import { CdpPluginLifecycleRuntime, watchAndInject, type WatchInjectionOptions } from '../launcher/cdp.js'
import { localDevelopmentPluginIdentity } from '../launcher/development.js'
import { createNativeViteEntityGenerationHandler, startNativeViteServer } from '../launcher/vite-development.js'
import {
  DirectPublisherGrantAuthority,
  DirectPublisherGrantStore,
  MacOSMachineIdentityProvider,
  StaticPublisherKeyRegistry,
} from '../launcher/publisher-grants.js'
import { createPublisherGrantBridgeHandler, type PublisherGrantBridgeHandler } from '../launcher/publisher-grant-rpc.js'
import {
  type CordisXConfig,
  findCordisXProjectConfig,
  loadConfig,
  resolveCordisXProjectConfig,
} from '../launcher/config.js'
import {
  assertLoopbackPortAvailable,
  findFreeLoopbackPort,
  type IsolatedCodexProfile,
  launchCodex,
  prepareIsolatedCodexProfile,
  resolveCodexExecutable,
  terminateIsolatedCodex,
} from '../launcher/process.js'
import { settleInjectedHostCleanup } from './injected-host-cleanup.js'
import { type CordisXDevInvocation, type CordisXLauncherOptions, parseCordisXCli } from './parse.js'
import { resolveProfileSelection } from './profiles.js'
import { ProviderFleet } from '../providers/fleet.js'
import { resolveLocalCodexProviderConfig } from '../providers/config.js'
import type { CodexProviderConfig } from '../providers/contracts.js'
import { CodexAgentHistoryHost } from '../launcher/agent-history.js'
import { type ConfigBridgeHandler, createConfigBridgeHandler } from '../launcher/config-rpc.js'
import { type HostSecretState, HostServiceConfigNarrowApi } from '../launcher/service-config.js'
import { createServiceConfigBridgeHandler, type ServiceConfigBridgeHandler } from '../launcher/service-config-rpc.js'
import {
  type ChannelCredentialBridgeHandler,
  createChannelCredentialBridgeHandler,
} from '../launcher/channel-credential-rpc.js'
import { type ChannelActionsBridgeHandler, createChannelActionsBridgeHandler } from '../launcher/channel-actions-rpc.js'
import { LauncherSecretStore } from '../launcher/secret-store.js'
import { readServiceConfigState } from '../config/service-config.js'
import {
  CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT,
  CLI_PROXY_PROVIDER_RUNTIME_CONFIG_INITIAL,
  CLI_PROXY_PROVIDER_RUNTIME_SERVICE_ID,
  CLI_PROXY_PROVIDER_STARTUP_CONFIG_CONTRACT,
  CLI_PROXY_PROVIDER_STARTUP_CONFIG_INITIAL,
  CLI_PROXY_PROVIDER_STARTUP_SERVICE_ID,
  parseCliProxyProviderStartupConfig,
  resolveCliProxyProviderConfigs,
} from '../plugins/cli-proxy-api/service-config.js'
import {
  CHANNEL_SERVICE_CONFIG_INITIAL,
  createChannelHostServiceConfigContract,
  createLocalChannelService,
  type LocalChannelService,
  projectLocalChannelManager,
} from '../launcher/channel-service.js'
import type { CordisXPluginIdentity } from '../platform-contracts.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import type { CordisXCertifiedPermissionProjectionV1 } from '../permission-contracts.js'
import { type PermissionPersistenceContext, PluginPermissionIdentityRegistry } from '../launcher/permission-rpc.js'
import { LauncherMarketplaceCertifiedAuthority } from '../launcher/marketplace-certified-authority.js'
import type { IconThemePreferencePersistenceContext } from '../launcher/icon-theme-rpc.js'
import { PluginActivationStore } from '../launcher/plugin-activation.js'
import { loadActivatedPluginComposition, loadPluginComposition } from '../launcher/plugin-composition.js'
import { PluginLifecycleCoordinator } from '../launcher/plugin-lifecycle.js'
import { PluginBundleCoordinator } from '../launcher/plugin-bundle.js'
import type { PluginLifecycleBridgeHandler } from '../launcher/plugin-lifecycle-rpc.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../plugin-lifecycle-contracts.js'
import type { CordisXPluginBundleManagerSnapshotV1 } from '../plugin-bundle-contracts.js'
import type { RollbackPlan } from '../launcher/packages/authority.js'
import { OwnerDocumentStore } from '../launcher/owner-document-store.js'
import { EntityDirectoryAuthority } from '../launcher/entity-directory.js'
import { createEntityBridgeHandler } from '../launcher/entity-rpc.js'
import { loadStagedPluginPackage, stagedPluginBrowserArtifactDirectory } from '../launcher/plugin-package.js'
import {
  type PluginGenerationArtifactServer,
  startPluginGenerationArtifactServer,
} from '../launcher/plugin-generation-loader.js'
import { AgentLoopAuthority } from '../launcher/agent-loop-authority.js'
import {
  CordisXSkillConflictError,
  type CordisXSkillDeploymentResult,
  deployBundledCordisXSkill,
  deployBundledCordisXSkillToHome,
} from '../launcher/builtin-skill.js'
import {
  createOwnerDocumentBridgeHandler,
  entityInstallationId,
  type OwnerDocumentBridgeHandler,
  OwnerDocumentLeaseRegistry,
} from '../launcher/owner-document-rpc.js'

import {
  agentHistoryHost,
  assertProductionGraphLaunchOwnership,
  buildRendererComposition,
  type ChannelManagerBundleProjection,
  cliProxyServiceConfigApis,
  codexHome,
  configuredPluginTopology,
  type CordisXCliRuntime,
  deployBuiltinSkillWithoutOverwritingUserChanges,
  HELP,
  localDevelopmentHostConfig,
  ownValue,
  pluginIdentities,
  printPlan,
  providerConfigs,
  recoveredActivation,
  type RendererComposition,
  rootFromConfigPath,
  runDevelopment,
  runInjectedHost,
  usesIsolatedPackageWorker,
  waitForAbort,
  waitForExit,
  waitForHostExitAfterReadiness,
} from './run-support.js'

export async function runCordisXCli(argv: readonly string[], runtime: CordisXCliRuntime = {}): Promise<void> {
  const invocation = parseCordisXCli(argv)
  const stdout = runtime.stdout ?? console.log
  const cwd = runtime.cwd ?? process.cwd()
  const environment = runtime.env ?? process.env
  const homeConfigOptions: HomeConfigPathOptions = {
    env: environment,
    ...(runtime.homedir === undefined ? {} : { homedir: runtime.homedir }),
  }
  const configPath = resolveHomeConfigPath(homeConfigOptions)

  if (invocation.action === 'help') {
    stdout(HELP)
    return
  }
  if (invocation.action === 'setup') {
    const config = await ensureHomeConfig(homeConfigOptions)
    stdout(`[cordisx] configuration ready: ${configPath}`)
    stdout(JSON.stringify(config, null, 2))
    return
  }
  if (invocation.action === 'config') {
    const config = await ensureHomeConfig(homeConfigOptions)
    stdout(`[cordisx] configuration: ${configPath}`)
    stdout(JSON.stringify(config, null, 2))
    return
  }
  if (invocation.action === 'dev') {
    await runDevelopment(invocation, cwd, stdout, environment, configPath, homeConfigOptions, runtime)
    return
  }

  const config = await ensureHomeConfig(homeConfigOptions)
  const appId = invocation.action === 'launch' ? invocation.app ?? config.defaultApp : config.defaultApp
  const adapter = resolveHostAdapter(appId)
  if (
    invocation.action === 'launch' && invocation.options.attach && (
      invocation.profile !== undefined || invocation.dataMode !== undefined
    )
  ) {
    throw new Error('--attach cannot select or override a named profile')
  }
  if (invocation.action === 'launch' && invocation.options.system) {
    const app = ownValue(config.apps, appId)
    if (app === undefined) throw new Error(`host app is not configured: ${appId}`)
    const profileId = invocation.profile ?? app.defaultProfile
    const mode = invocation.dataMode ?? ownValue(app.profiles, profileId)?.dataMode ?? 'shared'
    if (mode === 'host-isolated') throw new Error('--system cannot enforce a host-isolated profile')
  }
  const selection = await resolveProfileSelection({
    config,
    configPath,
    appId,
    ...(invocation.action === 'launch' && invocation.profile !== undefined
      ? { profileId: invocation.profile }
      : {}),
    ...(invocation.action === 'launch' && invocation.dataMode !== undefined
      ? { dataMode: invocation.dataMode }
      : {}),
  })

  if (invocation.action === 'doctor') {
    try {
      const plan = await adapter.resolveLaunchPlan({
        cordisxHomeDir: rootFromConfigPath(configPath),
        profileId: selection.profileId,
        dataMode: selection.dataMode,
      })
      printPlan(plan, stdout)
    } catch (error) {
      stdout(JSON.stringify(
        {
          status: 'unavailable',
          appId,
          profileId: selection.profileId,
          dataMode: selection.dataMode,
          diagnostic: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ))
    }
    return
  }

  const certifiedPermissionAuthority = await LauncherMarketplaceCertifiedAuthority.open({
    homeDir: rootFromConfigPath(configPath),
    configPath,
    profileId: selection.profileId,
  }).catch(error => {
    stdout(`[cordisx] Certified permission authority unavailable; explicit review remains required: ${String(error)}`)
    return undefined
  })
  const certifiedPermissionChannelToken = certifiedPermissionAuthority === undefined
    ? undefined
    : randomBytes(32).toString('hex')
  let pluginGenerationArtifactServer: PluginGenerationArtifactServer | undefined
  try {
    pluginGenerationArtifactServer = await startPluginGenerationArtifactServer()
    const activePluginGenerationArtifactServer = pluginGenerationArtifactServer
    const configuredComposition = await loadConfig(configPath, {
      profileId: selection.profileId,
      projectRoot: rootFromConfigPath(configPath),
    })
    const currentHomeConfig = await loadHomeConfig(configPath)
    const publisherGrant = createPublisherGrantBridgeHandler(
      new DirectPublisherGrantAuthority(
        new StaticPublisherKeyRegistry(currentHomeConfig.publisherGrantIssuers),
        new MacOSMachineIdentityProvider(),
        await DirectPublisherGrantStore.open(rootFromConfigPath(configPath)),
      ),
    )
    const permissionPolicies = currentHomeConfig.permissions.filter(policy =>
      policy.key.profileId === selection.profileId
    )
    const lifecycleGeneration = randomBytes(16).toString('hex')
    const lifecycleStore = new PluginActivationStore(
      rootFromConfigPath(configPath),
      selection.profileId,
      lifecycleGeneration,
    )
    const lifecycleRuntime = new CdpPluginLifecycleRuntime()
    const configuredIds = new Set(configuredComposition.plugins.map(plugin => plugin.id))
    const pluginLifecycleCoordinator = new PluginLifecycleCoordinator({
      homeDir: rootFromConfigPath(configPath),
      profileId: selection.profileId,
      runtimeGeneration: lifecycleGeneration,
      permissionPolicies,
      loadPermissionPolicies: async () =>
        (await loadHomeConfig(configPath)).permissions
          .filter(policy => policy.key.profileId === selection.profileId),
      runtime: lifecycleRuntime,
      pluginGenerationArtifactServer: activePluginGenerationArtifactServer,
      reservedPluginIds: [...configuredIds],
      ...(certifiedPermissionAuthority === undefined ? {} : {
        certifiedPermissionForArtifact: async (
          artifact: Readonly<{
            source: string
            pluginId: string
            version: string
            integrity: `sha256:${string}`
          }>,
        ) => {
          try {
            // The formal Marketplace projection validates sha256 integrity at its
            // Launcher boundary; its public type is intentionally wider (`string`).
            return (await certifiedPermissionAuthority.lookup(artifact)).projection as
              | CordisXCertifiedPermissionProjectionV1
              | undefined
          } catch (error) {
            stdout(
              `[cordisx] Certified permission lookup unavailable; explicit review remains required: ${String(error)}`,
            )
            return undefined
          }
        },
      }),
    })
    const recoveryPlans = await pluginLifecycleCoordinator.prepareRecovery()
    if (recoveryPlans.length > 1) {
      throw new Error('multiple shared registry rollback recoveries require separate launcher runs')
    }
    const recoveryPlan = recoveryPlans[0]
    const initialActivation = recoveryPlan === undefined
      ? undefined
      : recoveredActivation(recoveryPlan, lifecycleGeneration)
    const activatedPackagePlugins = initialActivation === undefined
      ? await loadActivatedPluginComposition(lifecycleStore)
      : await loadPluginComposition(lifecycleStore, initialActivation)
    const activatedPlugins = await Promise.all(activatedPackagePlugins.map(async plugin => {
      const manifest = plugin.manifest
      const isolatedWorker = manifest?.schemaVersion === 7
        || ((manifest?.schemaVersion === 5 || manifest?.schemaVersion === 6)
          && manifest.capabilities.some(capability => (
            capability.name === 'ui.host-dom.read' || capability.name === 'ui.host-dom.modify'
          )))
      if (!plugin.enabled || plugin.package === undefined || isolatedWorker) return plugin
      const staged = await loadStagedPluginPackage(rootFromConfigPath(configPath), plugin.package.digest)
      if (staged.browserArtifact === undefined) return plugin
      const lease = await activePluginGenerationArtifactServer.lease(
        {
          packageIdentity: {
            pluginId: plugin.id,
            version: plugin.package.version,
            integrity: plugin.package.digest,
          },
          artifactDirectory: stagedPluginBrowserArtifactDirectory(
            rootFromConfigPath(configPath),
            plugin.package.digest,
          ),
          runtimeEntry: staged.browserArtifact.manifest.entry,
        },
        plugin.package.moduleGeneration,
        staged.browserArtifact.manifest,
      )
      lifecycleRuntime.registerActivePluginGenerationLease(lease)
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
    const permissionIdentities = new PluginPermissionIdentityRegistry([
      ...pluginIdentities(configuredComposition),
      ...pluginIdentities({ ...configuredComposition, plugins: activatedPlugins }),
    ])
    lifecycleRuntime.setPermissionIdentities(permissionIdentities)
    const collision = activatedPlugins.find(plugin => configuredIds.has(plugin.id))
    if (collision !== undefined) throw new Error(`launcher-configured plugin already owns package id ${collision.id}`)
    const composition: CordisXConfig = {
      ...configuredComposition,
      plugins: [...configuredComposition.plugins, ...activatedPlugins],
    }
    const channelPlugin = composition.plugins.find(plugin => plugin.enabled && plugin.id === 'channel')
    const channelCredentialBridgeToken = channelPlugin === undefined ? undefined : randomBytes(32).toString('hex')
    const channelActionsBridgeToken = channelPlugin === undefined ? undefined : randomBytes(32).toString('hex')
    let channelService: LocalChannelService | undefined
    let channelManager: ChannelManagerBundleProjection | undefined
    const loadChannelManagerProjection = async (): Promise<ChannelManagerBundleProjection | undefined> => {
      if (channelPlugin === undefined || channelService === undefined) return undefined
      const state = await readServiceConfigState({
        profileId: selection.profileId,
        pluginId: 'channel',
        serviceId: 'runtime',
        initialConfig: CHANNEL_SERVICE_CONFIG_INITIAL as unknown as Parameters<
          typeof readServiceConfigState
        >[0]['initialConfig'],
      }, configPath)
      return projectLocalChannelManager({
        configuration: state.config,
        revision: state.revision,
        lastGoodRevision: state.lastGoodRevision,
        writable: true,
        ...(channelService.snapshot() === undefined ? {} : { runtime: channelService.snapshot()! }),
        audit: channelService.auditSnapshot(),
      })
    }
    if (channelPlugin !== undefined) {
      const state = await readServiceConfigState({
        profileId: selection.profileId,
        pluginId: 'channel',
        serviceId: 'runtime',
        initialConfig: CHANNEL_SERVICE_CONFIG_INITIAL as unknown as Parameters<
          typeof readServiceConfigState
        >[0]['initialConfig'],
      }, configPath)
      channelService = createLocalChannelService({
        artifactDirectory: path.dirname(channelPlugin.entry),
        dataDir: path.join(rootFromConfigPath(configPath), 'cache', 'channel-runtime'),
        source: channelPlugin.source ?? pathToFileURL(channelPlugin.entry).href,
        environment: runtime.env ?? process.env,
      })
      await channelService.start(state.config)
      channelManager = await loadChannelManagerProjection()
    }
    const pluginLifecycleBridgeToken = randomBytes(32).toString('hex')
    const pluginBundleCoordinator = new PluginBundleCoordinator({
      homeDir: rootFromConfigPath(configPath),
      profileId: selection.profileId,
      runtimeGeneration: lifecycleGeneration,
      pluginLifecycle: pluginLifecycleCoordinator,
    })
    pluginLifecycleCoordinator.setBundleClaimGuard(async pluginId =>
      await pluginBundleCoordinator.bundleClaims(pluginId)
    )
    const pluginLifecycle = {
      handler: {
        token: pluginLifecycleBridgeToken,
        profileId: selection.profileId,
        generation: lifecycleGeneration,
        coordinator: pluginLifecycleCoordinator,
        bundleCoordinator: pluginBundleCoordinator,
      },
      runtime: lifecycleRuntime,
    }
    const rendererComposition = await buildRendererComposition(composition, stdout, {
      appId,
      profileId: selection.profileId,
      ...(selection.profile.iconTheme === undefined ? {} : { iconThemePreference: selection.profile.iconTheme }),
      writable: true,
      permission: {
        profileId: selection.profileId,
        policies: permissionPolicies,
        persistent: true,
      },
      generation: lifecycleGeneration,
      pluginLifecycle: {
        token: pluginLifecycleBridgeToken,
        activation: initialActivation ?? await lifecycleStore.loadActive(),
        ...(recoveryPlan === undefined ? {} : { registryEpoch: recoveryPlan.rollbackRegistryEpoch }),
      },
      pluginBundles: await pluginBundleCoordinator.snapshot(),
      ...(certifiedPermissionChannelToken === undefined ? {} : { certifiedPermissionChannelToken }),
      ...(channelManager === undefined ? {} : { channelManager }),
      ...(channelCredentialBridgeToken === undefined ? {} : { channelCredentialBridgeToken }),
      ...(channelActionsBridgeToken === undefined ? {} : { channelActionsBridgeToken }),
      ...(runtime.internalBuildRendererBundle === undefined
        ? {}
        : { internalBuildRendererBundle: runtime.internalBuildRendererBundle }),
    })
    const initialConfiguredTopology = configuredPluginTopology(configuredComposition)
    const loadCurrentProductionProjection = async () => {
      const active = await lifecycleStore.loadActive()
      const registryEpoch = lifecycleRuntime.currentRegistryEpoch()
      const [freshConfigured, packagePlugins, freshHomeConfig, pluginBundles, freshChannelManager] = await Promise.all([
        loadConfig(configPath, {
          profileId: selection.profileId,
          projectRoot: rootFromConfigPath(configPath),
        }),
        loadPluginComposition(lifecycleStore, active),
        loadHomeConfig(configPath),
        pluginBundleCoordinator.snapshot(),
        loadChannelManagerProjection(),
      ])
      if (configuredPluginTopology(freshConfigured) !== initialConfiguredTopology) {
        throw new Error('launcher-configured plugin topology changed during browser graph admission')
      }
      if (pluginBundles.pluginRevision !== active.revision) {
        throw new Error('plugin bundle projection does not match the active plugin revision')
      }
      const currentPackagePlugins = await Promise.all(packagePlugins.map(async plugin => {
        if (!plugin.enabled || plugin.package === undefined || usesIsolatedPackageWorker(plugin)) return plugin
        const staged = await loadStagedPluginPackage(rootFromConfigPath(configPath), plugin.package.digest)
        if (staged.browserArtifact === undefined) return plugin
        const runtimeGraph = lifecycleRuntime.activeBrowserGraph(plugin.id, plugin.package.moduleGeneration)
        if (runtimeGraph === undefined) {
          throw new Error(`active browser graph lease is unavailable for plugin ${plugin.id}`)
        }
        return { ...plugin, runtimeGraph }
      }))
      const permissionPolicies = freshHomeConfig.permissions.filter(policy =>
        policy.key.profileId === selection.profileId
      )
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
        freshChannelManager,
        fingerprint: JSON.stringify({
          active,
          registryEpoch,
          currentComposition,
          permissionPolicies,
          pluginBundles,
          freshChannelManager,
        }),
      }
    }
    const productionGraphBootstrap: NonNullable<WatchInjectionOptions['productionGraphBootstrap']> = async (
      expectedActive,
      expectedRegistryEpoch,
    ) => {
      const before = await loadCurrentProductionProjection()
      if (
        JSON.stringify(before.active) !== JSON.stringify(expectedActive)
        || before.registryEpoch !== expectedRegistryEpoch
      ) throw new Error('browser graph admission activation snapshot is stale')
      const rebuilt = await rendererComposition.rebuild(
        before.currentComposition,
        before.active,
        expectedRegistryEpoch,
        {
          permissionPolicies: before.permissionPolicies,
          pluginBundles: before.pluginBundles,
          ...(before.freshChannelManager === undefined ? {} : { channelManager: before.freshChannelManager }),
        },
      )
      const after = await loadCurrentProductionProjection()
      if (after.fingerprint !== before.fingerprint) {
        throw new Error('browser graph admission projection changed during source rebuild')
      }
      return rebuilt
    }
    const documentLeases = new OwnerDocumentLeaseRegistry({
      stable: pluginIdentities(configuredComposition).map(identity => ({
        source: identity.source,
        pluginId: identity.id,
      })),
      active: activatedPlugins.flatMap(plugin =>
        plugin.enabled && plugin.package !== undefined
          ? [{
            source: plugin.source ?? pathToFileURL(plugin.entry).href,
            pluginId: plugin.id,
            moduleGeneration: plugin.package.moduleGeneration,
          }]
          : []
      ),
    })
    const configBridge = rendererComposition.configBridgeToken === undefined
      ? undefined
      : createConfigBridgeHandler({
        token: rendererComposition.configBridgeToken,
        profileId: selection.profileId,
        generation: rendererComposition.generation,
        configPath,
        composition,
        packagePlugins: {
          homeDir: rootFromConfigPath(configPath),
          runtimeGeneration: lifecycleGeneration,
        },
      })
    const ownerDocumentHandler = createOwnerDocumentBridgeHandler({
      plugins: composition.plugins,
      secret: rendererComposition.ownerDocumentSecret,
      profileId: selection.profileId,
      generation: rendererComposition.generation,
      store: new OwnerDocumentStore(rootFromConfigPath(configPath)),
      principalAllowed: principal => documentLeases.allowed(principal),
    })
    const entityAuthority = new EntityDirectoryAuthority(rootFromConfigPath(configPath), selection.profileId)
    for (const plugin of composition.plugins.filter(item => item.enabled)) {
      const installationId = entityInstallationId(selection.profileId, plugin.id)
      const binding = { profileId: selection.profileId, installationId, pluginId: plugin.id, pluginGeneration: 1 }
      if (plugin.package === undefined) {
        entityAuthority.register(binding, [])
        continue
      }
      const staged = await loadStagedPluginPackage(rootFromConfigPath(configPath), plugin.package.digest)
      const declarations = staged.entityTemplates.map(template => template.declaration)
      entityAuthority.register(binding, declarations)
      const materialized = await entityAuthority.materialize(
        binding,
        staged.manifest.version,
        staged.digest,
        staged.entityTemplates,
      )
      const rejected = materialized.find(result => result.status === 'rejected')
      if (rejected !== undefined) throw new Error(`entity template ${rejected.agentId} was rejected: ${rejected.code}`)
    }
    const entityBridge = createEntityBridgeHandler({
      secret: rendererComposition.ownerDocumentSecret,
      profileId: selection.profileId,
      generation: rendererComposition.generation,
      authority: entityAuthority,
      principalAllowed: principal => documentLeases.allowed(principal),
    })
    const ownerDocuments = Object.assign(ownerDocumentHandler, { entities: entityBridge })
    lifecycleRuntime.setOwnerDocumentAuthority({ leases: documentLeases, issue: ownerDocuments.issue })
    lifecycleRuntime.setEntityAuthority(selection.profileId, entityAuthority)
    await runtime.internalObserveOwnerDocuments?.({ source: rendererComposition.source, handler: ownerDocuments })
    const permissionPersistence = rendererComposition.permissionBridgeToken === undefined ? undefined : {
      configPath,
      profileId: selection.profileId,
      token: rendererComposition.permissionBridgeToken,
      identities: pluginIdentities(configuredComposition),
      identityAllowed: (identity: CordisXPluginIdentity) => permissionIdentities.allowed(identity),
    }
    const iconThemePreferencePersistence = rendererComposition.iconThemePreferenceBridgeToken === undefined
      ? undefined
      : {
        configPath,
        appId,
        profileId: selection.profileId,
        hostGeneration: rendererComposition.generation,
        token: rendererComposition.iconThemePreferenceBridgeToken,
      } satisfies IconThemePreferencePersistenceContext
    const providerFleet = rendererComposition.providerBridgeToken === undefined
      ? undefined
      : await ProviderFleet.create(providerConfigs(composition, runtime.env ?? process.env), {
        appServer: { environment: runtime.env ?? process.env },
        agentLoopAuthority: await AgentLoopAuthority.open(rootFromConfigPath(configPath), selection.profileId),
      })
    const serviceConfigToken = rendererComposition.serviceConfigBridgeToken
    const services: Array<
      { readonly pluginId: string; readonly serviceId: string; readonly api: HostServiceConfigNarrowApi }
    > = []
    let channelConfigApi: HostServiceConfigNarrowApi | undefined
    if (serviceConfigToken !== undefined && providerFleet !== undefined) {
      services.push(...cliProxyServiceConfigApis({
        token: serviceConfigToken,
        profileId: selection.profileId,
        generation: rendererComposition.generation,
        configPath,
        rootDir: rootFromConfigPath(configPath),
        environment: runtime.env ?? process.env,
        fleet: providerFleet,
      }))
    }
    if (serviceConfigToken !== undefined && channelPlugin !== undefined && channelService !== undefined) {
      const contract = createChannelHostServiceConfigContract({
        source: channelPlugin.source ?? pathToFileURL(channelPlugin.entry).href,
        pluginId: 'channel',
        serviceId: 'runtime',
      })
      channelConfigApi = new HostServiceConfigNarrowApi({
        contract: contract as unknown as ConstructorParameters<typeof HostServiceConfigNarrowApi>[0]['contract'],
        profileId: selection.profileId,
        generation: rendererComposition.generation,
        ownerToken: serviceConfigToken,
        configPath,
        writable: true,
        authorize: () => true,
        restartService: async candidate => await channelService!.restart(candidate),
      })
      services.push({
        pluginId: 'channel',
        serviceId: 'runtime',
        api: channelConfigApi,
      })
    }
    const serviceConfigBridge = serviceConfigToken === undefined || services.length === 0
      ? undefined
      : createServiceConfigBridgeHandler({
        token: serviceConfigToken,
        profileId: selection.profileId,
        generation: rendererComposition.generation,
        services,
      })
    const channelCredentialBridge = channelCredentialBridgeToken === undefined || channelConfigApi === undefined
      ? undefined
      : createChannelCredentialBridgeHandler({
        token: channelCredentialBridgeToken,
        profileId: selection.profileId,
        store: new LauncherSecretStore(),
        service: channelConfigApi,
      })
    const channelActionsBridge = channelActionsBridgeToken === undefined || channelService === undefined
      ? undefined
      : createChannelActionsBridgeHandler({ token: channelActionsBridgeToken, api: channelService.manager })
    if (invocation.options.attach) {
      try {
        assertProductionGraphLaunchOwnership(true, rendererComposition.hasLoopbackGraph)
      } catch (error) {
        await ownerDocuments.agentTools?.close()
        await channelService?.dispose()
        await providerFleet?.close()
        throw error
      }
      const debugPort = invocation.options.debugPort ?? composition.codex.debugPort
      if (invocation.options.dryRun) {
        stdout(JSON.stringify({ status: 'ready', mode: 'attach', appId, debugPort }, null, 2))
        await ownerDocuments.agentTools?.close()
        await channelService?.dispose()
        await providerFleet?.close()
        return
      }
      stdout('[cordisx] built-in Skill deployment skipped for --attach because the Host HOME is unknown')
      try {
        await runInjectedHost({
          source: rendererComposition.source,
          hasLoopbackGraph: rendererComposition.hasLoopbackGraph,
          pluginArtifactOrigin: activePluginGenerationArtifactServer.origin,
          productionGraphBootstrap,
          ...(rendererComposition.newDocumentSource === undefined ? {} : {
            newDocumentSource: rendererComposition.newDocumentSource,
          }),
          agentHistoryHost: agentHistoryHost(
            runtime.env ?? process.env,
            configPath,
            `${appId}:${selection.profileId}:attach`,
          ),
          agentHistoryBridgeToken: rendererComposition.agentHistoryBridgeToken,
          ...(rendererComposition.providerBridgeToken === undefined ? {} : {
            providerFleet: providerFleet!,
            providerBridgeToken: rendererComposition.providerBridgeToken,
          }),
          ...(configBridge === undefined ? {} : { configBridge }),
          ownerDocuments,
          ...(serviceConfigBridge === undefined ? {} : { serviceConfigBridge }),
          ...(channelCredentialBridge === undefined ? {} : { channelCredentialBridge }),
          ...(channelActionsBridge === undefined ? {} : { channelActionsBridge }),
          ...(permissionPersistence === undefined ? {} : { permissionPersistence }),
          ...(iconThemePreferencePersistence === undefined ? {} : { iconThemePreferencePersistence }),
          pluginLifecycle,
          ...(certifiedPermissionAuthority === undefined || certifiedPermissionChannelToken === undefined ? {} : {
            certifiedPermission: {
              authority: certifiedPermissionAuthority,
              token: certifiedPermissionChannelToken,
              profileId: selection.profileId,
              runtimeGeneration: lifecycleGeneration,
            },
          }),
          debugPort,
          hostArgs: invocation.hostArgs,
          launcher: invocation.options,
          stdout,
        })
      } finally {
        await ownerDocuments.agentTools?.close()
        await channelService?.dispose()
        await providerFleet?.close()
      }
      return
    }

    const resolvedPlan = await adapter.resolveLaunchPlan({
      cordisxHomeDir: rootFromConfigPath(configPath),
      profileId: selection.profileId,
      dataMode: selection.dataMode,
      ...(invocation.options.executable === undefined ? {} : { executable: invocation.options.executable }),
      ...(invocation.options.profileDir === undefined ? {} : { chromiumProfileDir: invocation.options.profileDir }),
    })
    const plan: ResolvedLaunchPlan = invocation.options.system
      ? {
        ...resolvedPlan,
        chromiumProfile: { mode: 'system' },
        isolatedDataRoots: resolvedPlan.isolatedDataRoots.filter(root => root.name !== 'Chromium profile'),
      }
      : resolvedPlan
    if (selection.created) stdout(`[cordisx] created ${appId}/${selection.profileId} (${selection.profile.dataMode})`)
    printPlan(plan, stdout, invocation.options.dryRun ? 'ready' : 'launching')
    if (invocation.options.dryRun) {
      stdout(`[cordisx] loopback CDP port: ${invocation.options.debugPort ?? 'automatic'}`)
      await ownerDocuments.agentTools?.close()
      await channelService?.dispose()
      await providerFleet?.close()
      return
    }

    const debugPort = invocation.options.debugPort ?? await findFreeLoopbackPort()
    if (invocation.options.debugPort !== undefined) await assertLoopbackPortAvailable(debugPort)
    await adapter.prepareLaunch(plan)
    await deployBuiltinSkillWithoutOverwritingUserChanges(
      deployBundledCordisXSkill(plan, {
        ...(runtime.internalBuiltinSkillSourceDir === undefined
          ? {}
          : { sourceDir: runtime.internalBuiltinSkillSourceDir }),
        ...(runtime.internalSharedHomeDir === undefined
          ? {}
          : { sharedHomeOverride: runtime.internalSharedHomeDir }),
      }),
      stdout,
    )
    stdout(`[cordisx] loopback CDP port: ${debugPort}`)
    const chromiumProfile = plan.chromiumProfile
    const profile = chromiumProfile.mode === 'independent'
      ? {
        userDataDir: chromiumProfile.path,
        cleanupOwned: plan.isolatedDataRoots.some(root =>
          root.name === 'Chromium profile'
          && root.path === chromiumProfile.path && root.managed
        ),
      }
      : undefined
    try {
      await runInjectedHost({
        source: rendererComposition.source,
        hasLoopbackGraph: rendererComposition.hasLoopbackGraph,
        pluginArtifactOrigin: activePluginGenerationArtifactServer.origin,
        productionGraphBootstrap,
        ...(rendererComposition.newDocumentSource === undefined ? {} : {
          newDocumentSource: rendererComposition.newDocumentSource,
        }),
        agentHistoryHost: agentHistoryHost(
          { ...(runtime.env ?? process.env), ...plan.environment },
          configPath,
          `${appId}:${selection.profileId}:${selection.dataMode}`,
        ),
        agentHistoryBridgeToken: rendererComposition.agentHistoryBridgeToken,
        ...(rendererComposition.providerBridgeToken === undefined ? {} : {
          providerFleet: providerFleet!,
          providerBridgeToken: rendererComposition.providerBridgeToken,
        }),
        ...(configBridge === undefined ? {} : { configBridge }),
        ownerDocuments,
        ...(serviceConfigBridge === undefined ? {} : { serviceConfigBridge }),
        ...(channelCredentialBridge === undefined ? {} : { channelCredentialBridge }),
        ...(channelActionsBridge === undefined ? {} : { channelActionsBridge }),
        ...(permissionPersistence === undefined ? {} : { permissionPersistence }),
        ...(iconThemePreferencePersistence === undefined ? {} : { iconThemePreferencePersistence }),
        pluginLifecycle,
        ...(certifiedPermissionAuthority === undefined || certifiedPermissionChannelToken === undefined ? {} : {
          certifiedPermission: {
            authority: certifiedPermissionAuthority,
            token: certifiedPermissionChannelToken,
            profileId: selection.profileId,
            runtimeGeneration: lifecycleGeneration,
          },
        }),
        publisherGrant,
        executable: plan.executable,
        debugPort,
        hostArgs: invocation.hostArgs,
        launcher: invocation.options,
        ...(profile === undefined ? {} : { profile }),
        ...(Object.keys(plan.environment).length === 0 ? {} : { environment: plan.environment }),
        stdout,
      })
    } finally {
      await ownerDocuments.agentTools?.close()
      await channelService?.dispose()
      await providerFleet?.close()
    }
  } finally {
    await pluginGenerationArtifactServer?.close()
    await certifiedPermissionAuthority?.dispose()
  }
}
