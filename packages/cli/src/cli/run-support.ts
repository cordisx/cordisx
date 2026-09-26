import { loadManagedSourceTrustNow } from '../launcher/managed-source-trust.js'
import { resolveDevelopmentConfigIdentity } from '../launcher/development-source-identity.js'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { resolveHostAdapter } from '../adapters/registry.js'
import type { ResolvedLaunchPlan } from '../adapters/contracts.js'
import {
  ensureCordisXHomeDirectory,
  ensureHomeConfig,
  type HomeConfigPathOptions,
  resolveHomeConfigPath,
} from '../config/home-config.js'
export { assertProductionGraphLaunchOwnership } from '../launcher/host-generation-graph.js'
import { localDevelopmentPluginIdentity } from '../launcher/development.js'
import {
  createNativeSubmissionComposition,
  type NativeSubmissionComposition,
} from '../launcher/native-submission-composition.js'
import {
  composeNativeVitePluginGenerationHandlers,
  createNativeViteEntityGenerationHandler,
  createNativeViteManagedServiceProjection,
  startNativeViteServer,
} from '../launcher/vite-development.js'
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
  prepareIsolatedCodexProfile,
  resolveCodexExecutable,
} from '../launcher/process.js'
export { waitForAbort, waitForExit, waitForHostExitAfterReadiness } from './host-lifecycle.js'
import { type CordisXDevInvocation, parseCordisXCli } from './parse.js'
import { resolveProfileSelection } from './profiles.js'
import { ProviderFleet } from '../providers/fleet.js'
import { resolveLocalCodexProviderConfig } from '../providers/config.js'
import type { CodexProviderConfig } from '../providers/contracts.js'
import { CodexAgentHistoryHost } from '../launcher/agent-history.js'
import { WorkUsageProfileHost, type WorkUsageProfileLocation } from '../launcher/work-usage-profile.js'
import { createConfigBridgeHandler } from '../launcher/config-rpc.js'
import { createLauncherConfigBridgeHandler } from '../launcher/launcher-plugin-config.js'
import {
  type HostSecretState,
  HostServiceConfigNarrowApi,
  type HostServiceConfigPersistence,
} from '../launcher/service-config.js'
import type { PlatformProviderServiceReconfigureRuntime } from '../launcher/platform-provider-service-batch.js'
import { createServiceConfigBridgeHandler } from '../launcher/service-config-rpc.js'
import { createChannelCredentialBridgeHandler } from '../launcher/channel-credential-rpc.js'
import { createChannelActionsBridgeHandler } from '../launcher/channel-actions-rpc.js'
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
} from '../providers/cli-proxy-service-config.js'
import {
  CHANNEL_SERVICE_CONFIG_INITIAL,
  createChannelHostServiceConfigContract,
  createLocalChannelService,
  type LocalChannelService,
  projectLocalChannelManager,
} from '../launcher/channel-service.js'
import type { CordisXPluginIdentity } from '../platform-contracts.js'
import type { CordisXCertifiedPermissionProjectionV1 } from '../permission-contracts.js'
import { type PermissionPersistenceContext, PluginPermissionIdentityRegistry } from '../launcher/permission-rpc.js'
import { LauncherMarketplaceCertifiedAuthority } from '../launcher/marketplace-certified-authority.js'
import { PluginActivationStore } from '../launcher/plugin-activation.js'
import { loadPluginComposition } from '../launcher/plugin-composition.js'
import { PluginLifecycleCoordinator } from '../launcher/plugin-lifecycle.js'
import { PluginBundleCoordinator } from '../launcher/plugin-bundle.js'
import type { PluginManagementBridgeHandler } from '../launcher/management-rpc.js'
import { openPluginManagementService, type PluginManagementService } from '../management/service.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../plugin-lifecycle-contracts.js'
import { buildRendererComposition } from './renderer-composition.js'
export {
  assertProductionGraphBootstrapSnapshot,
  buildRendererComposition,
  type ChannelManagerBundleProjection,
  type RendererComposition,
} from './renderer-composition.js'
import type { RollbackPlan } from '../launcher/packages/authority.js'
import { OwnerDocumentStore } from '../launcher/owner-document-store.js'
import { EntityDirectoryAuthority } from '../launcher/entity-directory.js'
import { createEntityBridgeHandler } from '../launcher/entity-rpc.js'
import { stagedPluginBrowserArtifactDirectory } from '../launcher/plugin-package.js'
import {
  type PluginGenerationArtifactServer,
  startPluginGenerationArtifactServer,
} from '../launcher/plugin-generation-loader.js'
import { AgentLoopAuthority } from '../launcher/agent-loop-authority.js'
import type { ManagedServiceNodeActivation } from '../launcher/managed-service-node-host.js'
import {
  CordisXSkillConflictError,
  type CordisXSkillDeploymentResult,
  type CordisXSkillsDeploymentResult,
  deployBundledCordisXSkillsToHome,
  deployBundledCordisXSkillToHome,
} from '../launcher/builtin-skill.js'
import {
  createOwnerDocumentBridgeHandler,
  entityInstallationId,
  type OwnerDocumentBridgeHandler,
  OwnerDocumentLeaseRegistry,
} from '../launcher/owner-document-rpc.js'
import { shouldEnableNativeSubmission } from './native-submission-launch-policy.js'
import { nativeSubmissionCatalogOptions } from './native-submission-catalog-options.js'
import { runInjectedHost } from './run-injected-host.js'
import { type CordisXCliRuntime, createDevelopmentManagedServiceActivation } from './run-runtime.js'
export { captureMainInspectorUrl, completeHostReadiness, runInjectedHost } from './run-injected-host.js'
export type { CordisXCliRuntime } from './run-runtime.js'
export { HELP } from './help.js'

export async function deployBuiltinSkillWithoutOverwritingUserChanges(
  deployment: Promise<CordisXSkillDeploymentResult>,
  stdout: (line: string) => void,
): Promise<void> {
  try {
    const result = await deployment
    if (result.status !== 'unchanged') {
      stdout(`[cordisx] built-in Skill ${result.status}: ${result.targetDir}`)
    }
  } catch (error) {
    if (!(error instanceof CordisXSkillConflictError)) throw error
    stdout(`[cordisx] built-in Skill preserved: ${error.message}`)
  }
}

export async function deployBuiltinSkillsWithoutOverwritingUserChanges(
  deployment: Promise<CordisXSkillsDeploymentResult>,
  stdout: (line: string) => void,
): Promise<void> {
  const result = await deployment
  for (const installed of result.deployments) {
    if (installed.status !== 'unchanged') {
      stdout(`[cordisx] built-in Skill ${installed.status}: ${installed.targetDir}`)
    }
  }
  for (const conflict of result.conflicts) {
    stdout(`[cordisx] built-in Skill preserved: ${conflict.message}`)
  }
}

export function shouldSkipBuiltinSkillDeployment(environment: NodeJS.ProcessEnv): boolean {
  return environment.CORDISX_SKIP_BUILTIN_SKILL_DEPLOYMENT === '1'
}

export function rootFromConfigPath(configPath: string): string {
  return path.dirname(configPath)
}

export function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

export function localDevelopmentHostConfig(cwd: string): CordisXConfig {
  return {
    version: 1,
    rootDir: cwd,
    projectRoot: cwd,
    configRoot: cwd,
    codex: { debugPort: 9229 },
    providers: [],
    plugins: [],
  }
}

export function providerConfigs(config: CordisXConfig, environment: NodeJS.ProcessEnv): readonly CodexProviderConfig[] {
  const local = resolveLocalCodexProviderConfig(config.codex, environment)
  return local === undefined ? config.providers : [...config.providers, local]
}

export function codexHome(environment: Readonly<Record<string, string>> | NodeJS.ProcessEnv): string {
  const explicit = environment.CODEX_HOME
  if (typeof explicit === 'string' && explicit.length > 0) return path.resolve(explicit)
  const home = typeof environment.HOME === 'string' && environment.HOME.length > 0 ? environment.HOME : os.homedir()
  return path.join(home, '.codex')
}

function historyLocation(
  environment: Readonly<Record<string, string>> | NodeJS.ProcessEnv,
  configPath: string,
  profileName: string,
) {
  return {
    codexHome: codexHome(environment),
    cacheDir: path.join(path.dirname(configPath), 'cache', 'agent-history'),
    profileName,
  }
}
export function agentHistoryHost(
  environment: Readonly<Record<string, string>> | NodeJS.ProcessEnv,
  configPath: string,
  profileName: string,
  workProfile?: WorkUsageProfileLocation,
): CodexAgentHistoryHost {
  return new CodexAgentHistoryHost({
    ...historyLocation(environment, configPath, profileName),
    ...(workProfile === undefined ? {} : { workProfile }),
  })
}

export function pluginIdentities(config: CordisXConfig): readonly CordisXPluginIdentity[] {
  return config.plugins.map(plugin => ({ source: plugin.source ?? pathToFileURL(plugin.entry).href, id: plugin.id }))
}

export { cliProxyServiceConfigApis } from './provider-config-apis.js'

export function recoveredActivation(plan: RollbackPlan, runtimeGeneration: string): CordisXPluginActivationRecordV1 {
  return {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: 'active',
    profileId: plan.rollbackTarget.profileId,
    revision: plan.rollbackTarget.revision,
    lastGoodRevision: plan.rollbackTarget.lastGoodRevision,
    runtimeGeneration,
    plugins: plan.rollbackTarget.plugins,
  }
}

export function printPlan(
  plan: ResolvedLaunchPlan,
  stdout: (line: string) => void,
  status: 'ready' | 'launching' = 'ready',
): void {
  stdout(JSON.stringify({ status, plan }, null, 2))
}

export async function runDevelopment(
  invocation: CordisXDevInvocation,
  cwd: string,
  stdout: (line: string) => void,
  environment: NodeJS.ProcessEnv,
  homeConfigPath: string,
  homeConfigOptions: HomeConfigPathOptions,
  runtime: CordisXCliRuntime,
): Promise<void> {
  if (
    invocation.options.writeConfig === true
    && (invocation.configPath === undefined || invocation.pluginPath !== undefined)
  ) {
    throw new Error('--write-config requires cordisx dev --config <path>')
  }
  const cordisxHomeDir = rootFromConfigPath(homeConfigPath)
  const entry = invocation.pluginPath === undefined ? undefined : path.resolve(cwd, invocation.pluginPath)
  const localIdentity = entry === undefined ? undefined : await localDevelopmentPluginIdentity(entry)
  const location = entry !== undefined
    ? undefined
    : invocation.configPath === undefined
    ? await findCordisXProjectConfig(cwd, { excludeConfigPaths: [homeConfigPath] })
    : resolveCordisXProjectConfig(invocation.configPath, cwd)
  if (entry === undefined && location === undefined) {
    throw new Error(
      `CordisX project config not found from ${cwd}; create .cordisx/config.json or pass a plugin path/--config`,
    )
  }
  const suppliedConfig: CordisXConfig = entry === undefined
    ? await loadConfig(location!.configPath, { projectRoot: location!.projectRoot, profileId: 'development' })
    : {
      ...localDevelopmentHostConfig(cwd),
      plugins: [{ id: localIdentity!.id, source: localIdentity!.source, entry, enabled: true, config: {} }],
    }
  const config = await resolveDevelopmentConfigIdentity(suppliedConfig)
  if (!invocation.options.dryRun && invocation.options.workScopeGuard === undefined) {
    await ensureCordisXHomeDirectory(homeConfigOptions)
  }
  const workProfile = {
    homeDir: cordisxHomeDir,
    profileId: 'development',
    ...(invocation.options.workScopeGuard === undefined ? {} : {
      bootstrapGuard: {
        scopeId: invocation.options.workScopeGuard.split('/')[0]!,
        epoch: invocation.options.workScopeGuard.split('/')[1]!,
      },
    }),
  }
  const historyPreflight = new WorkUsageProfileHost(
    workProfile,
    historyLocation(environment, homeConfigPath, `development:${config.rootDir}`),
  )
  try {
    await historyPreflight.preflight()
  } finally {
    historyPreflight.dispose()
  }
  if (!invocation.options.dryRun && invocation.options.workScopeGuard !== undefined) {
    await ensureCordisXHomeDirectory(homeConfigOptions)
  }
  const dryRunCacheRoot = invocation.options.dryRun
    ? await mkdtemp(path.join(os.tmpdir(), 'cordisx-vite-dry-run-'))
    : undefined
  let vite: Awaited<ReturnType<typeof startNativeViteServer>> | undefined
  let managedServiceActivation: ManagedServiceNodeActivation | undefined
  let managedServiceProjection: Awaited<ReturnType<typeof createNativeViteManagedServiceProjection>> | undefined
  let nativeSubmission: NativeSubmissionComposition | undefined
  let pluginManagementService: PluginManagementService | undefined
  let certifiedPermissionAuthority: LauncherMarketplaceCertifiedAuthority | undefined
  try {
    const developmentHome = invocation.options.dryRun
      ? undefined
      : await (async () => {
        const homeConfig = await ensureHomeConfig(homeConfigOptions)
        const nativeApp = ownValue(homeConfig.apps, 'codex')
        if (nativeApp === undefined) throw new Error('host app is not configured: codex')
        const nativeProfileId = nativeApp.defaultProfile
        const nativeProfile = ownValue(nativeApp.profiles, nativeProfileId)
        if (nativeProfile === undefined) {
          throw new Error(`default profile is not configured for codex: ${nativeProfileId}`)
        }
        const managementAppId = homeConfig.defaultApp
        const managementApp = ownValue(homeConfig.apps, managementAppId)
        if (managementApp === undefined) throw new Error(`host app is not configured: ${managementAppId}`)
        const managementProfileId = managementApp.defaultProfile
        const managementProfile = ownValue(managementApp.profiles, managementProfileId)
        if (managementProfile === undefined) {
          throw new Error(`default profile is not configured for ${managementAppId}: ${managementProfileId}`)
        }
        const runtimeGeneration = randomBytes(16).toString('hex')
        const store = new PluginActivationStore(cordisxHomeDir, nativeProfileId, runtimeGeneration)
        const activation = await store.loadActive()
        return {
          homeConfig,
          nativeProfileId,
          nativeProfile,
          managementAppId,
          managementProfileId,
          runtimeGeneration,
          store,
          activation,
          plugins: await loadPluginComposition(store, activation),
        }
      })()
    const configuredIds = new Set(config.plugins.map(plugin => plugin.id))
    const collision = developmentHome?.plugins.find(plugin => configuredIds.has(plugin.id))
    if (collision !== undefined) throw new Error(`development plugin already owns package id ${collision.id}`)
    const rendererConfig: CordisXConfig = {
      ...config,
      plugins: [...config.plugins, ...developmentHome?.plugins ?? []],
    }
    vite = await startNativeViteServer(rendererConfig, {
      cacheRoot: dryRunCacheRoot ?? path.join(cordisxHomeDir, 'cache', 'native-vite'),
      prebundleHostDependencies: !invocation.options.dryRun,
    })
    const activeVite = vite
    if (invocation.options.dryRun) {
      const composition = await buildRendererComposition(rendererConfig, stdout, {
        ...(environment.CORDISX_EXPERIMENTAL_MANAGER_WORKSPACE === '1'
          ? { managerPresentationMode: 'workspace' as const }
          : {}),
        profileId: 'development',
        writable: invocation.options.writeConfig === true,
        serviceConfigWritable: false,
        permission: { profileId: 'development', policies: [], persistent: false },
        developmentBuild: (nextConfig, options = {}) => activeVite.buildBootstrap(nextConfig, options),
      })
      stdout(JSON.stringify(
        {
          status: 'ready',
          mode: 'development',
          transport: 'vite',
          ...(entry === undefined
            ? {
              config: location!.configPath,
              configPath: location!.configPath,
              projectRoot: location!.projectRoot,
              configRoot: location!.configRoot,
              configurationWrite: composition.configBridgeToken === undefined ? 'read-only' : 'enabled',
              pluginIds: config.plugins.map(plugin => plugin.id),
            }
            : { origin: 'local-dev', pluginId: localIdentity!.id, sourcePath: entry }),
          debugPort: invocation.options.debugPort
            ?? (invocation.options.attach || invocation.options.system ? config.codex.debugPort : 'automatic'),
          hostArgs: invocation.hostArgs,
        },
        null,
        2,
      ))
      return
    }
    if (developmentHome === undefined) throw new Error('development home composition is unavailable')
    const {
      homeConfig,
      nativeProfileId,
      nativeProfile,
      managementAppId,
      managementProfileId,
      runtimeGeneration: developmentRuntimeGeneration,
      store: developmentStore,
      activation: activeLifecycleActivation,
    } = developmentHome
    const permissionPolicies = homeConfig.permissions.filter(policy => policy.key.profileId === nativeProfileId)
    const permissionIdentities = new PluginPermissionIdentityRegistry(pluginIdentities(rendererConfig))
    certifiedPermissionAuthority = await LauncherMarketplaceCertifiedAuthority.open({
      homeDir: cordisxHomeDir,
      configPath: homeConfigPath,
      profileId: nativeProfileId,
    }).catch(error => {
      stdout(`[cordisx] Certified permission authority unavailable; explicit review remains required: ${String(error)}`)
      return undefined
    })
    const certifiedPermissionChannelToken = certifiedPermissionAuthority === undefined
      ? undefined
      : randomBytes(32).toString('hex')
    if (shouldSkipBuiltinSkillDeployment(environment)) {
      stdout('[cordisx] built-in Skill deployment skipped by the local acceptance runner')
    } else if (invocation.options.attach) {
      stdout('[cordisx] built-in Skill deployment skipped for --attach because the Host HOME is unknown')
    } else if (
      runtime.internalBuiltinSkillSourceDir !== undefined
      && runtime.internalBuiltinSkillsSourceRootDir === undefined
    ) {
      await deployBuiltinSkillWithoutOverwritingUserChanges(
        deployBundledCordisXSkillToHome(
          runtime.internalSharedHomeDir ?? environment.HOME ?? runtime.homedir ?? os.homedir(),
          { sourceDir: runtime.internalBuiltinSkillSourceDir },
        ),
        stdout,
      )
    } else {
      await deployBuiltinSkillsWithoutOverwritingUserChanges(
        deployBundledCordisXSkillsToHome(
          runtime.internalSharedHomeDir ?? environment.HOME ?? runtime.homedir ?? os.homedir(),
          runtime.internalBuiltinSkillsSourceRootDir === undefined
            ? {}
            : { sourceRootDir: runtime.internalBuiltinSkillsSourceRootDir },
        ),
        stdout,
      )
    }
    const debugPort = invocation.options.debugPort ?? (
      invocation.options.attach || invocation.options.system ? config.codex.debugPort : await findFreeLoopbackPort()
    )
    if (!invocation.options.attach && (invocation.options.debugPort !== undefined || invocation.options.system)) {
      await assertLoopbackPortAvailable(debugPort)
    }
    const executable = invocation.options.attach
      ? undefined
      : await resolveCodexExecutable(invocation.options.executable ?? config.codex.executable)
    if (
      executable !== undefined
      && shouldEnableNativeSubmission({
        platform: runtime.internalNativeSubmissionPlatform ?? process.platform,
        adapterId: 'codex',
        preference: environment.CORDISX_EXPERIMENTAL_NATIVE_SUBMISSION,
      })
    ) {
      try {
        const createActivation = runtime.internalCreateDevelopmentManagedServiceActivation
          ?? createDevelopmentManagedServiceActivation
        managedServiceActivation = await createActivation({
          homeConfigPath,
          homeDir: cordisxHomeDir,
          environment,
          profileId: nativeProfileId,
          runtimeGeneration: developmentRuntimeGeneration,
        })
        const createNativeSubmission = runtime.internalCreateNativeSubmissionComposition
          ?? createNativeSubmissionComposition
        nativeSubmission = await createNativeSubmission(
          managedServiceActivation,
          executable,
          codexHome(environment),
          nativeSubmissionCatalogOptions(
            cordisxHomeDir,
            nativeProfileId,
            nativeProfile,
            environment,
            undefined,
            runtime.internalNativeSubmissionLegacyLockRecovery,
          ),
        )
        managedServiceProjection = await createNativeViteManagedServiceProjection({
          activation: managedServiceActivation,
          profileId: nativeProfileId,
          runtimeGeneration: managedServiceActivation.hostGeneration,
          initialActivation: activeLifecycleActivation,
        })
      } catch (error) {
        await nativeSubmission?.close().catch(() => undefined)
        nativeSubmission = undefined
        await managedServiceProjection?.dispose().catch(() => undefined)
        managedServiceProjection = undefined
        await managedServiceActivation?.dispose().catch(() => undefined)
        managedServiceActivation = undefined
        stdout(`[cordisx] native Desktop model providers unavailable: ${String(error)}`)
      }
    }
    const entityAuthority = new EntityDirectoryAuthority(cordisxHomeDir, nativeProfileId)
    await activeVite.synchronizePluginGenerations(composeNativeVitePluginGenerationHandlers([
      createNativeViteEntityGenerationHandler(entityAuthority, nativeProfileId),
      ...(managedServiceProjection === undefined ? [] : [managedServiceProjection.handler]),
    ]))
    pluginManagementService = await openPluginManagementService({
      configPath: homeConfigPath,
      homeDir: cordisxHomeDir,
      appId: managementAppId,
      profileId: managementProfileId,
    })
    const pluginManagementToken = randomBytes(32).toString('hex')
    const composition = await buildRendererComposition(rendererConfig, stdout, {
      ...(environment.CORDISX_EXPERIMENTAL_MANAGER_WORKSPACE === '1'
        ? { managerPresentationMode: 'workspace' as const }
        : {}),
      profileId: nativeProfileId,
      writable: invocation.options.writeConfig === true,
      serviceConfigWritable: false,
      permission: { profileId: nativeProfileId, policies: permissionPolicies, persistent: true },
      ...(managedServiceActivation === undefined ? {} : { generation: managedServiceActivation.hostGeneration }),
      ...(certifiedPermissionChannelToken === undefined ? {} : { certifiedPermissionChannelToken }),
      ...(managedServiceProjection === undefined
        ? {}
        : { managedServiceUICapabilities: managedServiceProjection.capabilities() }),
      pluginManagement: { token: pluginManagementToken, profileId: managementProfileId },
      developmentBuild: (nextConfig, options = {}) => activeVite.buildBootstrap(nextConfig, options),
    })
    const pluginManagement: PluginManagementBridgeHandler = {
      token: pluginManagementToken,
      profileId: managementProfileId,
      generation: composition.generation,
      service: pluginManagementService,
    }
    const permissionPersistence = composition.permissionBridgeToken === undefined ? undefined : {
      configPath: homeConfigPath,
      profileId: nativeProfileId,
      token: composition.permissionBridgeToken,
      identities: pluginIdentities(rendererConfig),
      identityAllowed: (identity: CordisXPluginIdentity) => permissionIdentities.allowed(identity),
    }
    const configBridge = composition.configBridgeToken === undefined
      ? undefined
      : createLauncherConfigBridgeHandler({
        token: composition.configBridgeToken,
        profileId: nativeProfileId,
        generation: composition.generation,
        configPath: location!.configPath,
        composition: config,
        preserveComposition: true,
      })
    const profile = invocation.options.attach || invocation.options.system
      ? undefined
      : await prepareIsolatedCodexProfile(config.rootDir, {
        cordisxHomeDir,
        ...(invocation.options.profileDir === undefined ? {} : { explicitProfileDir: invocation.options.profileDir }),
      })
    const identities = pluginIdentities(rendererConfig)
    const documentLeases = new OwnerDocumentLeaseRegistry({
      stable: identities.map(identity => ({ source: identity.source, pluginId: identity.id })),
    })
    const ownerDocumentHandler = createOwnerDocumentBridgeHandler({
      onDiagnostic: event => stdout(`[cordisx] HTTP transport ${JSON.stringify(event)}`),
      localWalletHomeDir: cordisxHomeDir,
      managedSourcesNow: () => loadManagedSourceTrustNow(cordisxHomeDir, nativeProfileId),
      managedSources: async () =>
        (await import('../launcher/managed-source-trust.js')).loadManagedSourceTrust(cordisxHomeDir, nativeProfileId),
      plugins: rendererConfig.plugins,
      secret: composition.ownerDocumentSecret,
      profileId: nativeProfileId,
      generation: composition.generation,
      store: new OwnerDocumentStore(cordisxHomeDir),
      principalAllowed: principal => documentLeases.allowed(principal),
    })
    const ownerDocuments = Object.assign(ownerDocumentHandler, {
      entities: createEntityBridgeHandler({
        secret: composition.ownerDocumentSecret,
        profileId: nativeProfileId,
        generation: composition.generation,
        authority: entityAuthority,
        principalAllowed: principal => documentLeases.allowed(principal),
      }),
    })
    stdout(`[cordisx] Vite development server: ${activeVite.url}`)
    const publisherGrant = createPublisherGrantBridgeHandler(
      new DirectPublisherGrantAuthority(
        new StaticPublisherKeyRegistry([]),
        new MacOSMachineIdentityProvider(),
        await DirectPublisherGrantStore.open(cordisxHomeDir),
      ),
    )
    let historyHost: CodexAgentHistoryHost | undefined
    let providerFleet: ProviderFleet | undefined
    let resourcesHandedOff = false
    try {
      historyHost = agentHistoryHost(environment, homeConfigPath, `development:${config.rootDir}`, workProfile)
      providerFleet = composition.providerBridgeToken === undefined
        ? undefined
        : await ProviderFleet.create(providerConfigs(rendererConfig, environment), {
          appServer: { environment },
          agentLoopAuthority: await AgentLoopAuthority.open(cordisxHomeDir, nativeProfileId),
        })
      resourcesHandedOff = true
      const runHost = runtime.internalRunInjectedHost ?? runInjectedHost
      await runHost({
        ...(nativeSubmission === undefined ? {} : { nativeSubmission: nativeSubmission.installation }),
        ...(managedServiceProjection === undefined
          ? {}
          : { managedServiceUI: managedServiceProjection.managedServiceUI }),
        source: composition.source,
        ...(composition.newDocumentSource === undefined ? {} : {
          newDocumentSource: composition.newDocumentSource,
        }),
        viteDevelopment: true,
        ...(configBridge === undefined ? {} : { configBridge }),
        hasLoopbackGraph: false,
        agentHistoryHost: historyHost,
        agentHistoryBridgeToken: composition.agentHistoryBridgeToken,
        ownerDocuments,
        pluginManagement,
        ...(permissionPersistence === undefined ? {} : { permissionPersistence }),
        ...(certifiedPermissionAuthority === undefined || certifiedPermissionChannelToken === undefined ? {} : {
          certifiedPermission: {
            authority: certifiedPermissionAuthority,
            token: certifiedPermissionChannelToken,
            profileId: nativeProfileId,
            runtimeGeneration: composition.generation,
          },
        }),
        ...(providerFleet === undefined || composition.providerBridgeToken === undefined ? {} : {
          providerFleet,
          providerBridgeToken: composition.providerBridgeToken,
        }),
        ...(executable === undefined ? {} : { executable }),
        debugPort,
        hostArgs: invocation.hostArgs,
        launcher: invocation.options,
        ...(profile === undefined ? {} : { profile }),
        ...((entry === undefined && nativeSubmission === undefined)
          ? {}
          : {
            environment: {
              ...(entry === undefined
                ? {}
                : {
                  CORDISX_DEV_ENTRY: entry,
                  CORDISX_DEV_MODE: 'explicit-entry',
                }),
              ...nativeSubmission?.environment,
            },
          }),
        publisherGrant,
        stdout,
      })
    } finally {
      ownerDocuments.walletSpend?.dispose()
      await ownerDocuments.http.dispose()
      await ownerDocuments.agentTools?.close()
      if (!resourcesHandedOff) {
        historyHost?.dispose()
        await providerFleet?.close()
      }
    }
  } finally {
    try {
      await nativeSubmission?.close().catch(() => undefined)
      await managedServiceProjection?.dispose().catch(() => undefined)
      await managedServiceActivation?.dispose().catch(() => undefined)
      await certifiedPermissionAuthority?.dispose().catch(() => undefined)
      pluginManagementService?.close()
      await vite?.close()
    } finally {
      if (dryRunCacheRoot !== undefined) await rm(dryRunCacheRoot, { recursive: true, force: true })
    }
  }
}
