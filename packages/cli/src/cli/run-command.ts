import { loadManagedSourceTrustNow } from '../launcher/managed-source-trust.js'
import path from 'node:path'
import {
  createNativeSubmissionComposition,
  type NativeSubmissionComposition,
} from '../launcher/native-submission-composition.js'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import {
  ensureCordisXHomeDirectory,
  type HomeConfigIconThemePreference,
  loadHomeConfig,
} from '../config/home-config.js'
import { buildRendererBundle, type BuildRendererBundleOptions } from '../launcher/bundle.js'
import { CdpPluginLifecycleRuntime } from '../launcher/cdp.js'
import { findPackageRoot, localDevelopmentPluginIdentity } from '../launcher/development.js'
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
  acquireCodexProfileLaunchLease,
  type IsolatedCodexProfile,
  prepareIsolatedCodexProfile,
  resolveCodexExecutable,
  terminateIsolatedCodex,
} from '../launcher/process.js'
import { settleInjectedHostCleanup } from './injected-host-cleanup.js'
import { type CordisXDevInvocation, type CordisXLauncherOptions } from './parse.js'
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
import { markServiceConfigAppRestartApplied, readServiceConfigState } from '../config/service-config.js'
import {
  CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT,
  CLI_PROXY_PROVIDER_RUNTIME_CONFIG_INITIAL,
  CLI_PROXY_PROVIDER_RUNTIME_SERVICE_ID,
  CLI_PROXY_PROVIDER_STARTUP_CONFIG_CONTRACT,
  CLI_PROXY_PROVIDER_STARTUP_CONFIG_INITIAL,
  CLI_PROXY_PROVIDER_STARTUP_SERVICE_ID,
  parseCliProxyProviderStartupConfig,
  resolveCliProxyProviderConfigs,
} from '../providers/cli-proxy-service-config.js'
import { createChannelHostServiceConfigContract } from '../launcher/channel-service.js'
import type { CordisXPluginIdentity } from '../platform-contracts.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import type { CordisXCertifiedPermissionProjectionV1 } from '../permission-contracts.js'
import { type PermissionPersistenceContext, PluginPermissionIdentityRegistry } from '../launcher/permission-rpc.js'
import { LauncherMarketplaceCertifiedAuthority } from '../launcher/marketplace-certified-authority.js'
import type { IconThemePreferencePersistenceContext } from '../launcher/icon-theme-rpc.js'
import { PluginActivationStore } from '../launcher/plugin-activation.js'
import { loadActivatedPluginComposition, loadPluginComposition } from '../launcher/plugin-composition.js'
import { PluginLifecycleCoordinator } from '../launcher/plugin-lifecycle.js'
import type { PluginLifecycleBridgeHandler } from '../launcher/plugin-lifecycle-rpc.js'
import { openPluginManagementService } from '../management/service.js'
import {
  type PluginManagementBridgeHandler,
  type PluginManagementRpcServer,
  startPluginManagementRpcServer,
} from '../launcher/management-rpc.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../plugin-lifecycle-contracts.js'
import type { CordisXPluginBundleManagerSnapshotV1 } from '../plugin-bundle-contracts.js'
import type { RollbackPlan } from '../launcher/packages/authority.js'
import { bundledPluginEntry } from '../launcher/bundled-plugin.js'
import { OwnerDocumentStore } from '../launcher/owner-document-store.js'
import { EntityDirectoryAuthority } from '../launcher/entity-directory.js'
import { createEntityBridgeHandler } from '../launcher/entity-rpc.js'
import { loadStagedPluginPackage } from '../launcher/plugin-package.js'
import {
  type PluginGenerationArtifactServer,
  startPluginGenerationArtifactServer,
} from '../launcher/plugin-generation-loader.js'
import { AgentLoopAuthority } from '../launcher/agent-loop-authority.js'
import { createCliProxyPlatformProviderBatch } from '../launcher/cli-proxy-platform-provider-batch.js'
import { PackagePluginServiceConfigStore } from '../launcher/package-plugin-service-config.js'
import { PlatformProviderPluginLifecycleRuntime } from '../launcher/platform-provider-plugin-lifecycle.js'
import { stagePluginPackageSourceV1 } from '../launcher/packages/index.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V13, normalizePluginManifestV13 } from '../runtime-exact-request-permissions.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V14, normalizePluginManifestV14 } from '../launcher/latest-runtime-manifest.js'
import { deployBundledCordisXSkill, deployBundledCordisXSkills } from '../launcher/builtin-skill.js'
import {
  createOwnerDocumentBridgeHandler,
  entityInstallationId,
  type OwnerDocumentBridgeHandler,
  OwnerDocumentLeaseRegistry,
} from '../launcher/owner-document-rpc.js'
import { managedBackendRuntimeServiceAccess } from '../launcher/packages/managed-backend-service-access.js'
import { ManagedServiceRuntime } from '../launcher/managed-service-runtime.js'
import { ManagedServiceNodeHost } from '../launcher/managed-service-node-host.js'
import { ManagedServicePluginLifecycleRuntime } from '../launcher/managed-service-plugin-lifecycle.js'

import {
  agentHistoryHost,
  assertProductionGraphLaunchOwnership,
  cliProxyServiceConfigApis,
  codexHome,
  type CordisXCliRuntime,
  deployBuiltinSkillsWithoutOverwritingUserChanges,
  deployBuiltinSkillWithoutOverwritingUserChanges,
  localDevelopmentHostConfig,
  pluginIdentities,
  printPlan,
  providerConfigs,
  recoveredActivation,
  rootFromConfigPath,
  runInjectedHost,
  waitForAbort,
  waitForExit,
  waitForHostExitAfterReadiness,
} from './run-support.js'
import {
  attachActiveBrowserGraphs,
  buildRendererComposition,
  createProductionGraphBootstrap,
  createRendererLifecycleProjection,
  type RendererComposition,
} from './renderer-composition.js'
import { prepareCliCommand } from './run-command-dispatch.js'
import { shouldEnableNativeSubmission } from './native-submission-launch-policy.js'
import { createRendererChannelComposition } from './renderer-channel-composition.js'
import { createSupervisorRuntime } from './supervisor-runtime.js'
import { processStartIdentity } from './supervisor-state.js'
import { prepareProductionHostBootstrap, type ProductionHostBootstrap } from './production-host-bootstrap.js'

export interface ProductionPluginManagementComposition {
  readonly handler: PluginManagementBridgeHandler
  close(): Promise<void>
}
export async function openProductionPluginManagementComposition(input: {
  readonly configPath: string
  readonly homeDir: string
  readonly appId: string
  readonly profileId: string
  readonly runtimeGeneration: string
  readonly token: string
  readonly coordinator: PluginLifecycleCoordinator
  readonly processStartedAt?: string
}): Promise<ProductionPluginManagementComposition> {
  const service = await openPluginManagementService({
    configPath: input.configPath,
    homeDir: input.homeDir,
    appId: input.appId,
    profileId: input.profileId,
    lifecycle: { coordinator: input.coordinator, runtimeGeneration: input.runtimeGeneration },
  })
  let server: PluginManagementRpcServer
  try {
    const processStartedAt = input.processStartedAt ?? await processStartIdentity(process.pid)
    if (processStartedAt === undefined) throw new Error('cannot identify the CordisX management owner process')
    server = await startPluginManagementRpcServer({
      homeDir: input.homeDir,
      appId: input.appId,
      profileId: input.profileId,
      configPath: input.configPath,
      generation: input.runtimeGeneration,
      processStartedAt,
      service,
    })
  } catch (error) {
    service.close()
    throw error
  }
  let closed = false
  return {
    handler: {
      token: input.token,
      profileId: input.profileId,
      generation: input.runtimeGeneration,
      service,
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      try {
        await server.close()
      } finally {
        service.close()
      }
    },
  }
}
export async function runCordisXCli(argv: readonly string[], runtime: CordisXCliRuntime = {}): Promise<void> {
  const prepared = await prepareCliCommand(argv, runtime)
  if (prepared === undefined) return
  const { invocation, stdout, environment, configPath, selection, adapter, appId } = prepared
  const supervisorRuntime = await createSupervisorRuntime(environment)
  const runHost = runtime.internalRunInjectedHost ?? runInjectedHost
  let bootstrap: ProductionHostBootstrap | undefined
  let plan: ProductionHostBootstrap['plan']
  let debugPort: ProductionHostBootstrap['debugPort']
  let profile: ProductionHostBootstrap['profile']
  let certifiedPermissionAuthority: LauncherMarketplaceCertifiedAuthority | undefined
  let certifiedPermissionChannelToken: string | undefined
  let pluginGenerationArtifactServer: PluginGenerationArtifactServer | undefined
  let managedServiceLifecycleRuntime: ManagedServicePluginLifecycleRuntime | undefined
  let nativeSubmission: NativeSubmissionComposition | undefined
  let nativeSubmissionCompletion: Promise<void> | undefined
  let nativeSubmissionBootstrap: ProductionHostBootstrap['nativeSubmissionBootstrap']
  let rendererComposition: RendererComposition | undefined
  let productionPluginManagement: ProductionPluginManagementComposition | undefined
  let profileLease: ProductionHostBootstrap['profileLease']
  let prelaunchedHost: ProductionHostBootstrap['prelaunchedHost']
  let profileLeaseHandedOff = false
  let prelaunchedHostHandedOff = false
  try {
    bootstrap = await prepareProductionHostBootstrap(prepared, runtime, {
      // The same primary window shows startup while compatibility work proceeds.
      prelaunch: runHost === runInjectedHost && supervisorRuntime.mainInspector
        && environment.CORDISX_SUPERVISOR_HOME !== undefined,
      prepareNativeSubmission: runHost === runInjectedHost,
      mainInspector: supervisorRuntime.mainInspector,
      markHostLaunched: async (pid, inspectorUrl, port) =>
        await supervisorRuntime.markHostLaunched(pid, inspectorUrl, port),
    })
    ;({
      plan,
      debugPort,
      profile,
      profileLease,
      prelaunchedHost,
      nativeSubmissionBootstrap,
    } = bootstrap)
    certifiedPermissionAuthority = await LauncherMarketplaceCertifiedAuthority.open({
      homeDir: rootFromConfigPath(configPath),
      configPath,
      profileId: selection.profileId,
    }).catch(error => {
      stdout(`[cordisx] Certified permission authority unavailable; explicit review remains required: ${String(error)}`)
      return undefined
    })
    certifiedPermissionChannelToken = certifiedPermissionAuthority === undefined
      ? undefined
      : randomBytes(32).toString('hex')
    const activeCertifiedPermissionAuthority = certifiedPermissionAuthority
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
    const platformProviderLifecycleRuntime = new PlatformProviderPluginLifecycleRuntime(lifecycleRuntime)
    managedServiceLifecycleRuntime = new ManagedServicePluginLifecycleRuntime({
      runtime: platformProviderLifecycleRuntime,
      profileId: selection.profileId,
      runtimeGeneration: lifecycleGeneration,
      activate: async activation => {
        if (invocation.options.dryRun) return undefined
        const plugins = await loadPluginComposition(lifecycleStore, activation)
        const accesses = await Promise.all(plugins.flatMap(plugin => {
          if (!plugin.enabled || plugin.package === undefined || plugin.manifest?.schemaVersion !== 14) return []
          return plugin.manifest.services.flatMap(service =>
            service.kind === 'managed-backend'
              ? [managedBackendRuntimeServiceAccess(
                rootFromConfigPath(configPath),
                {
                  id: plugin.id,
                  version: plugin.package!.version,
                  digest: plugin.package!.digest,
                  moduleGeneration: plugin.package!.moduleGeneration,
                },
                service.id,
                lifecycleGeneration,
              )]
              : []
          )
        }))
        if (accesses.length === 0) return undefined
        const host = new ManagedServiceNodeHost(
          new ManagedServiceRuntime({
            homeDir: rootFromConfigPath(configPath),
            environment: runtime.env ?? process.env,
          }),
          selection.profileId,
          lifecycleGeneration,
        )
        try {
          return await host.replace(accesses)
        } catch (error) {
          await host.dispose().catch(() => undefined)
          throw error
        }
      },
    })
    const lifecycleTransactionRuntime = managedServiceLifecycleRuntime
    const configuredIds = new Set(configuredComposition.plugins.map(plugin => plugin.id))
    const pluginLifecycleCoordinator = new PluginLifecycleCoordinator({
      homeDir: rootFromConfigPath(configPath),
      profileId: selection.profileId,
      runtimeGeneration: lifecycleGeneration,
      permissionPolicies,
      loadPermissionPolicies: async () =>
        (await loadHomeConfig(configPath)).permissions
          .filter(policy => policy.key.profileId === selection.profileId),
      runtime: lifecycleTransactionRuntime,
      pluginGenerationArtifactServer: activePluginGenerationArtifactServer,
      reservedPluginIds: [...configuredIds],
      ...(activeCertifiedPermissionAuthority === undefined ? {} : {
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
            return (await activeCertifiedPermissionAuthority.lookup(artifact)).projection as
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
    const pluginManagementToken = randomBytes(32).toString('hex')
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
    const activatedPlugins = await attachActiveBrowserGraphs({
      plugins: activatedPackagePlugins,
      homeDir: rootFromConfigPath(configPath),
      artifactServer: activePluginGenerationArtifactServer,
      lifecycleRuntime,
    })
    const activeLifecycleActivation = initialActivation ?? await lifecycleStore.loadActive()
    await managedServiceLifecycleRuntime.initialize(activeLifecycleActivation)
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
    const channel = await createRendererChannelComposition({
      composition,
      profileId: selection.profileId,
      configPath,
      homeDir: rootFromConfigPath(configPath),
      environment: runtime.env ?? process.env,
    })
    const channelPlugin = channel.plugin
    const channelService = channel.service
    const channelManager = channel.manager
    const channelCredentialBridgeToken = channel.credentialBridgeToken
    const channelActionsBridgeToken = channel.actionsBridgeToken
    const rendererLifecycle = createRendererLifecycleProjection({
      homeDir: rootFromConfigPath(configPath),
      profileId: selection.profileId,
      generation: lifecycleGeneration,
      pluginLifecycleCoordinator,
      lifecycleRuntime,
      managedServiceLifecycleRuntime,
    })
    const {
      token: pluginLifecycleBridgeToken,
      pluginBundleCoordinator,
      pluginLifecycle,
      managedServiceActivation,
      managedServiceUICapabilities,
      managedServiceUI,
    } = rendererLifecycle
    if (
      nativeSubmissionBootstrap !== undefined && plan !== undefined
      && shouldEnableNativeSubmission({
        platform: runtime.internalNativeSubmissionPlatform ?? process.platform,
        adapterId: adapter.id,
        preference: (runtime.env ?? process.env).CORDISX_EXPERIMENTAL_NATIVE_SUBMISSION,
      })
    ) {
      nativeSubmissionCompletion = nativeSubmissionBootstrap.complete(
        managedServiceActivation,
        codexHome({ ...environment, ...plan.environment }),
        selection.profile.defaultModelProvider === undefined
          ? {}
          : { defaultProviderId: selection.profile.defaultModelProvider },
      ).then(composition => {
        nativeSubmission = composition
      })
    }
    rendererComposition = await buildRendererComposition(composition, stdout, {
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
        activation: activeLifecycleActivation,
        ...(recoveryPlan === undefined ? {} : { registryEpoch: recoveryPlan.rollbackRegistryEpoch }),
      },
      pluginManagement: { token: pluginManagementToken, profileId: selection.profileId },
      pluginBundles: await pluginBundleCoordinator.snapshot(),
      ...(certifiedPermissionChannelToken === undefined ? {} : { certifiedPermissionChannelToken }),
      ...(channelManager === undefined ? {} : { channelManager }),
      ...(channelCredentialBridgeToken === undefined ? {} : { channelCredentialBridgeToken }),
      ...(channelActionsBridgeToken === undefined ? {} : { channelActionsBridgeToken }),
      managedServiceUICapabilities,
      productionGraph: !invocation.options.attach,
      ...(runtime.internalBuildRendererBundle === undefined
        ? {}
        : { internalBuildRendererBundle: runtime.internalBuildRendererBundle }),
    })
    const productionGraphBootstrap = createProductionGraphBootstrap({
      rendererComposition,
      configuredComposition,
      configPath,
      profileId: selection.profileId,
      lifecycleStore,
      lifecycleRuntime,
      pluginBundleCoordinator,
      managedServiceLifecycleRuntime,
      loadChannelManagerProjection: channel.loadManagerProjection,
    })
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
      onDiagnostic: event => stdout(`[cordisx] HTTP transport ${JSON.stringify(event)}`),
      localWalletHomeDir: rootFromConfigPath(configPath),
      managedSourcesNow: () => loadManagedSourceTrustNow(rootFromConfigPath(configPath), selection.profileId),
      managedSources: async () =>
        (await import('../launcher/managed-source-trust.js')).loadManagedSourceTrust(
          rootFromConfigPath(configPath),
          selection.profileId,
        ),
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
    await runtime.internalObserveOwnerDocuments?.({
      bootstrapSource: rendererComposition.source,
      source: rendererComposition.authoritySource(),
      handler: ownerDocuments,
    })
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
    const fleetConfigs = providerConfigs(composition, runtime.env ?? process.env)
      .filter(provider => provider.kind === 'local-codex')
    const cliProxyConfigured = composition.plugins.some(plugin => plugin.id === 'cli-proxy-api' && plugin.enabled)
    const cliProxyPackageOwned = activatedPlugins.some(plugin => plugin.id === 'cli-proxy-api' && plugin.enabled)
    const cliProxyPackageServiceConfig = cliProxyPackageOwned
      ? new PackagePluginServiceConfigStore(
        rootFromConfigPath(configPath),
        selection.profileId,
        lifecycleGeneration,
      )
      : undefined
    const markCliProxyStartupConfigApplied = async (): Promise<void> => {
      if (!cliProxyConfigured) return
      try {
        const read = cliProxyPackageServiceConfig?.persistence.read ?? readServiceConfigState
        const state = await read({
          profileId: selection.profileId,
          pluginId: 'cli-proxy-api',
          serviceId: CLI_PROXY_PROVIDER_STARTUP_SERVICE_ID,
          initialConfig: CLI_PROXY_PROVIDER_STARTUP_CONFIG_INITIAL as unknown as Parameters<
            typeof readServiceConfigState
          >[0]['initialConfig'],
        }, configPath)
        if (state.restartRequired !== true) return
        const markApplied = cliProxyPackageServiceConfig?.persistence.markAppRestartApplied
          ?? markServiceConfigAppRestartApplied
        await markApplied({
          profileId: selection.profileId,
          pluginId: 'cli-proxy-api',
          serviceId: CLI_PROXY_PROVIDER_STARTUP_SERVICE_ID,
          expectedRevision: state.revision,
          initialConfig: CLI_PROXY_PROVIDER_STARTUP_CONFIG_INITIAL as unknown as Parameters<
            typeof markServiceConfigAppRestartApplied
          >[0]['initialConfig'],
        }, configPath)
      } catch (error) {
        stdout(`[cordisx] failed to mark CLIProxy startup configuration applied: ${String(error)}`)
      }
    }
    const launcherCliProxy = cliProxyConfigured
      ? await (async () => {
        const entry = bundledPluginEntry('plugin-cli-proxy-api')
        const staged = await stagePluginPackageSourceV1({
          kind: 'local-directory',
          location: pathToFileURL(await findPackageRoot(entry)).href,
        }, {
          homeDir: rootFromConfigPath(configPath),
          runtimeValidators: {
            [CORDISX_PLUGIN_MANIFEST_SCHEMA_V13]: value => normalizePluginManifestV13(value, 'cli-proxy-api'),
            [CORDISX_PLUGIN_MANIFEST_SCHEMA_V14]: value => normalizePluginManifestV14(value, 'cli-proxy-api'),
          },
        })
        return {
          id: staged.manifest.id,
          version: staged.manifest.version,
          digest: staged.digest,
          moduleGeneration: `launcher-cli-proxy:${lifecycleGeneration}`,
          enabled: true,
          dependencies: staged.manifest.dependencies,
          ...(staged.manifest.canonicalSource === undefined
            ? {}
            : { canonicalSource: staged.manifest.canonicalSource }),
        }
      })()
      : undefined
    const providerFleet = rendererComposition.providerBridgeToken === undefined
      ? undefined
      : await ProviderFleet.create(fleetConfigs, {
        appServer: { environment: runtime.env ?? process.env },
        agentLoopAuthority: await AgentLoopAuthority.open(rootFromConfigPath(configPath), selection.profileId),
      })
    const platformProviderServices = providerFleet === undefined
      ? undefined
      : createCliProxyPlatformProviderBatch({
        homeDir: rootFromConfigPath(configPath),
        profileId: selection.profileId,
        hostGeneration: lifecycleGeneration,
        configPath,
        rootDir: rootFromConfigPath(configPath),
        environment: runtime.env ?? process.env,
        activation: async () => await lifecycleStore.bindRuntimeGeneration(),
        ...(launcherCliProxy === undefined ? {} : { launcherCandidates: [launcherCliProxy] }),
        ...(cliProxyPackageServiceConfig === undefined
          ? {}
          : { serviceConfigPersistence: cliProxyPackageServiceConfig.persistence }),
      })
    if (providerFleet !== undefined && platformProviderServices !== undefined) {
      platformProviderLifecycleRuntime.connect(async activation =>
        await platformProviderServices.reconfigure(
          providerFleet,
          fleetConfigs,
          undefined,
          activation,
        )
      )
      try {
        if (await platformProviderServices.hasCandidates()) {
          const initialProviders = await platformProviderServices.reconfigure(
            providerFleet,
            fleetConfigs,
          )
          await initialProviders.finalize()
        }
      } catch (error) {
        await platformProviderServices.close()
        await providerFleet.close()
        throw error
      }
    }
    const closeProviderFleet = async (): Promise<void> => {
      await platformProviderServices?.close()
      await providerFleet?.close()
    }
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
        ...(platformProviderServices === undefined ? {} : { platformProviderServices }),
        ...(cliProxyPackageServiceConfig === undefined
          ? {}
          : { persistence: cliProxyPackageServiceConfig.persistence }),
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
        ownerDocuments.walletSpend?.dispose()
        await ownerDocuments.http.dispose()
        await ownerDocuments.agentTools?.close()
        await channelService?.dispose()
        await closeProviderFleet()
        throw error
      }
      const debugPort = invocation.options.debugPort ?? composition.codex.debugPort
      if (invocation.options.dryRun) {
        stdout(JSON.stringify({ status: 'ready', mode: 'attach', appId, debugPort }, null, 2))
        ownerDocuments.walletSpend?.dispose()
        await ownerDocuments.http.dispose()
        await ownerDocuments.agentTools?.close()
        await channelService?.dispose()
        await closeProviderFleet()
        return
      }
      productionPluginManagement = await openProductionPluginManagementComposition({
        configPath,
        homeDir: rootFromConfigPath(configPath),
        appId,
        profileId: selection.profileId,
        runtimeGeneration: lifecycleGeneration,
        token: pluginManagementToken,
        coordinator: pluginLifecycleCoordinator,
      })
      stdout('[cordisx] built-in Skill deployment skipped for --attach because the Host HOME is unknown')
      try {
        await runHost({
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
          managedServiceUI,
          ...(permissionPersistence === undefined ? {} : { permissionPersistence }),
          ...(iconThemePreferencePersistence === undefined ? {} : { iconThemePreferencePersistence }),
          pluginLifecycle,
          pluginManagement: productionPluginManagement.handler,
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
          onReady: async () => {
            await markCliProxyStartupConfigApplied()
            await supervisorRuntime.markReady(debugPort, nativeSubmission?.installation.accountCapability)
          },
          onHostLaunched: async (pid, inspectorUrl) =>
            await supervisorRuntime.markHostLaunched(pid, inspectorUrl, debugPort),
          mainInspector: supervisorRuntime.mainInspector,
          stdout,
        })
      } finally {
        ownerDocuments.walletSpend?.dispose()
        await ownerDocuments.http.dispose()
        await ownerDocuments.agentTools?.close()
        await channelService?.dispose()
        await closeProviderFleet()
      }
      return
    }
    if (plan === undefined) throw new Error('host launch plan was not resolved')
    if (selection.created) stdout(`[cordisx] created ${appId}/${selection.profileId} (${selection.profile.dataMode})`)
    printPlan(plan, stdout, invocation.options.dryRun ? 'ready' : 'launching')
    if (invocation.options.dryRun) {
      stdout(`[cordisx] loopback CDP port: ${invocation.options.debugPort ?? 'automatic'}`)
      ownerDocuments.walletSpend?.dispose()
      await ownerDocuments.http.dispose()
      await ownerDocuments.agentTools?.close()
      await channelService?.dispose()
      await closeProviderFleet()
      return
    }
    if (debugPort === undefined) throw new Error('loopback CDP port was not resolved')
    const resolvedDebugPort = debugPort
    await nativeSubmissionCompletion
    if (profile !== undefined && profileLease === undefined && runHost === runInjectedHost) {
      profileLease = await acquireCodexProfileLaunchLease(profile.userDataDir)
    }
    try {
      if (
        shouldEnableNativeSubmission({
          platform: runtime.internalNativeSubmissionPlatform ?? process.platform,
          adapterId: adapter.id,
          preference: (runtime.env ?? process.env).CORDISX_EXPERIMENTAL_NATIVE_SUBMISSION,
        })
      ) {
        try {
          if (nativeSubmissionBootstrap === undefined) {
            nativeSubmission =
              await (runtime.internalCreateNativeSubmissionComposition ?? createNativeSubmissionComposition)(
                managedServiceActivation,
                plan.executable,
                codexHome({ ...environment, ...plan.environment }),
                selection.profile.defaultModelProvider === undefined
                  ? {}
                  : { defaultProviderId: selection.profile.defaultModelProvider },
              )
          }
        } catch (error) {
          stdout(`[cordisx] native Desktop model providers unavailable: ${String(error)}`)
        }
      }
      if (
        runtime.internalBuiltinSkillSourceDir !== undefined
        && runtime.internalBuiltinSkillsSourceRootDir === undefined
      ) {
        await deployBuiltinSkillWithoutOverwritingUserChanges(
          deployBundledCordisXSkill(plan, {
            sourceDir: runtime.internalBuiltinSkillSourceDir,
            ...(runtime.internalSharedHomeDir === undefined
              ? {}
              : { sharedHomeOverride: runtime.internalSharedHomeDir }),
          }),
          stdout,
        )
      } else {
        await deployBuiltinSkillsWithoutOverwritingUserChanges(
          deployBundledCordisXSkills(plan, {
            ...(runtime.internalBuiltinSkillsSourceRootDir === undefined
              ? {}
              : { sourceRootDir: runtime.internalBuiltinSkillsSourceRootDir }),
            ...(runtime.internalSharedHomeDir === undefined
              ? {}
              : { sharedHomeOverride: runtime.internalSharedHomeDir }),
          }),
          stdout,
        )
      }
      productionPluginManagement = await openProductionPluginManagementComposition({
        configPath,
        homeDir: rootFromConfigPath(configPath),
        appId,
        profileId: selection.profileId,
        runtimeGeneration: lifecycleGeneration,
        token: pluginManagementToken,
        coordinator: pluginLifecycleCoordinator,
      })
      stdout(`[cordisx] loopback CDP port: ${resolvedDebugPort}`)
      const createAgentHistoryHost = runtime.internalAgentHistoryHost ?? agentHistoryHost
      const runHostInput: Parameters<typeof runHost>[0] = {
        ...(nativeSubmission === undefined ? {} : { nativeSubmission: nativeSubmission.installation }),
        source: rendererComposition.source,
        hasLoopbackGraph: rendererComposition.hasLoopbackGraph,
        pluginArtifactOrigin: activePluginGenerationArtifactServer.origin,
        productionGraphBootstrap,
        ...(rendererComposition.newDocumentSource === undefined ? {} : {
          newDocumentSource: rendererComposition.newDocumentSource,
        }),
        agentHistoryHost: createAgentHistoryHost(
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
        managedServiceUI,
        ...(permissionPersistence === undefined ? {} : { permissionPersistence }),
        ...(iconThemePreferencePersistence === undefined ? {} : { iconThemePreferencePersistence }),
        pluginLifecycle,
        pluginManagement: productionPluginManagement.handler,
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
        ...(prelaunchedHost === undefined ? {} : { prelaunchedHost }),
        debugPort: resolvedDebugPort,
        hostArgs: invocation.hostArgs,
        launcher: invocation.options,
        onReady: async () => {
          await markCliProxyStartupConfigApplied()
          await supervisorRuntime.markReady(resolvedDebugPort, nativeSubmission?.installation.accountCapability)
        },
        onHostLaunched: async (pid, inspectorUrl) =>
          await supervisorRuntime.markHostLaunched(pid, inspectorUrl, resolvedDebugPort),
        mainInspector: supervisorRuntime.mainInspector,
        ...(profile === undefined ? {} : { profile }),
        ...(profileLease === undefined ? {} : { profileLease }),
        ...((Object.keys(plan.environment).length === 0 && nativeSubmission === undefined)
          ? {}
          : { environment: { ...plan.environment, ...nativeSubmission?.environment } }),
        stdout,
      }
      profileLeaseHandedOff = profileLease !== undefined
      prelaunchedHostHandedOff = prelaunchedHost !== undefined
      await runHost(runHostInput)
    } finally {
      ownerDocuments.walletSpend?.dispose()
      await ownerDocuments.http.dispose()
      await ownerDocuments.agentTools?.close()
      await channelService?.dispose()
      await closeProviderFleet()
    }
  } finally {
    if (prelaunchedHost !== undefined && !prelaunchedHostHandedOff) {
      await terminateIsolatedCodex(prelaunchedHost.child, profile).catch(() => undefined)
    }
    if (profileLease !== undefined && !profileLeaseHandedOff) await profileLease.release().catch(() => undefined)
    await productionPluginManagement?.close().catch(() => undefined)
    await rendererComposition?.close().catch(() => undefined)
    await supervisorRuntime.close()
    await nativeSubmissionCompletion
    await nativeSubmission?.close().catch(() => undefined)
    await nativeSubmissionBootstrap?.close().catch(() => undefined)
    await managedServiceLifecycleRuntime?.dispose().catch(() => undefined)
    await pluginGenerationArtifactServer?.close()
    await certifiedPermissionAuthority?.dispose()
  }
}
