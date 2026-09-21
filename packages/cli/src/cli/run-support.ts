import { loadManagedSourceTrustNow } from '../launcher/managed-source-trust.js'
import { resolveDevelopmentConfigIdentity } from '../launcher/development-source-identity.js'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import type { ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { resolveHostAdapter } from '../adapters/registry.js'
import type { ResolvedLaunchPlan } from '../adapters/contracts.js'
import {
  ensureCordisXHomeDirectory,
  ensureHomeConfig,
  type HomeConfigPathOptions,
  resolveHomeConfigPath,
} from '../config/home-config.js'
import type { buildRendererBundle } from '../launcher/bundle.js'
export { assertProductionGraphLaunchOwnership } from '../launcher/host-generation-graph.js'
import { CdpPluginLifecycleRuntime, watchAndInject, type WatchInjectionOptions } from '../launcher/cdp.js'
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
  acquireCodexProfileLaunchLease,
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
import { WorkUsageProfileHost, type WorkUsageProfileLocation } from '../launcher/work-usage-profile.js'
import { type ConfigBridgeHandler, createConfigBridgeHandler } from '../launcher/config-rpc.js'
import { createLauncherConfigBridgeHandler } from '../launcher/launcher-plugin-config.js'
import {
  type HostSecretState,
  HostServiceConfigNarrowApi,
  type HostServiceConfigPersistence,
} from '../launcher/service-config.js'
import type { PlatformProviderServiceReconfigureRuntime } from '../launcher/platform-provider-service-batch.js'
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
import type { IconThemePreferencePersistenceContext } from '../launcher/icon-theme-rpc.js'
import { PluginActivationStore } from '../launcher/plugin-activation.js'
import { loadActivatedPluginComposition, loadPluginComposition } from '../launcher/plugin-composition.js'
import { PluginLifecycleCoordinator } from '../launcher/plugin-lifecycle.js'
import { PluginBundleCoordinator } from '../launcher/plugin-bundle.js'
import type { PluginLifecycleBridgeHandler } from '../launcher/plugin-lifecycle-rpc.js'
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
import { loadStagedPluginPackage, stagedPluginBrowserArtifactDirectory } from '../launcher/plugin-package.js'
import {
  type PluginGenerationArtifactServer,
  startPluginGenerationArtifactServer,
} from '../launcher/plugin-generation-loader.js'
import { AgentLoopAuthority } from '../launcher/agent-loop-authority.js'
import { managedBackendRuntimeServiceAccess } from '../launcher/packages/managed-backend-service-access.js'
import { ManagedServiceRuntime } from '../launcher/managed-service-runtime.js'
import { type ManagedServiceNodeActivation, ManagedServiceNodeHost } from '../launcher/managed-service-node-host.js'
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
import type { OpenManagementCommandService } from './management-command.js'

export const HELP = `Usage:
  cordisx [app] [profile] [--data shared|host-isolated] [options] [-- host-arguments...]
  cordisx start|status|logs|stop|restart [app] [profile] [options]
  cordisx setup
  cordisx config
  cordisx doctor
  cordisx feedback <collect|inspect|export> [options]
  cordisx dev [plugin-path | --config path] [options] [-- host-arguments...]
  cordisx plugin <command> [options]
  cordisx source <command> [options]

Options:
  --attach                 Attach to an existing loopback CDP endpoint
  --system                 Use the host's system Chromium profile (escape hatch)
  --profile-dir <path>     Override this launch profile's independent Chromium directory
  --executable <path>      Override the host executable
  --debug-port <port>      Override the loopback CDP port
  --online-devtools        Allow the official online DevTools frontend
  --dry-run                Resolve and print the plan without starting the host
  --recover-startup        Replace a legacy start lock after older CordisX starts have exited
  --write-config           Enable plugin saves to an explicit dev --config file
  --work-scope-guard <scope/epoch>  Require the original dev work ledger identity on admission
  dev without a path       Discover .cordisx/config.json (or cordisx.config.json) upwards
  plugin --help            Show plugin management commands
  source --help            Show source management commands
  feedback --help          Show local, privacy-filtered feedback commands
  -h, --help               Show this help`

export interface CordisXCliRuntime {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  /** Test/integration seam for the canonical default `~/.cordisx` root. */
  readonly homedir?: string
  readonly stdout?: (line: string) => void
  readonly stdin?: Readable & { readonly isTTY?: boolean }
  readonly stderr?: Writable
  /** Repository-only seam until the shared management service is composed. */
  readonly internalOpenPluginManagementService?: OpenManagementCommandService
  /** Test-only confirmation seam. It confirms a mutation, never plugin permissions. */
  readonly internalManagementConfirm?: (prompt: string) => boolean | Promise<boolean>
  /** Test-only cancellation seam for long-lived `cordisx logs --follow`. */
  readonly internalSignal?: AbortSignal
  /** Repository-only detached-supervisor seam; production always spawns the packaged CLI. */
  readonly internalSpawnSupervisor?: (input: {
    readonly args: readonly string[]
    readonly env: NodeJS.ProcessEnv
    readonly logFd: number
  }) => Readonly<{ pid: number; unref(): void }>
  /** Repository-only seam for bounded supervisor failure-path integration tests. */
  readonly internalSupervisorReadinessTimeoutMs?: number
  /**
   * Internal-only renderer bundle closure for repository-controlled production
   * integration tests. It has no CLI/configuration/environment input and is
   * undefined for every product launch.
   */
  readonly internalBuildRendererBundle?: typeof buildRendererBundle
  /** Repository-only proof that the production composition and authority agree. */
  readonly internalObserveOwnerDocuments?: (input: {
    readonly bootstrapSource: string
    readonly source: string
    readonly handler: OwnerDocumentBridgeHandler
  }) => void | Promise<void>
  /** Repository-only source seam for built-in Skill deployment tests. */
  readonly internalBuiltinSkillSourceDir?: string
  /** Repository-only source-root seam for bundled Skills deployment tests. */
  readonly internalBuiltinSkillsSourceRootDir?: string
  /** Repository-only HOME seam that prevents launch tests from touching the user's real HOME. */
  readonly internalSharedHomeDir?: string
  /** Repository-only launch seam for proving CLI assembly without starting a native Host. */
  readonly internalRunInjectedHost?: typeof runInjectedHost
  /** Repository-only native composition seam for launcher assembly tests. */
  readonly internalCreateNativeSubmissionComposition?: typeof createNativeSubmissionComposition
  /** Repository-only installed managed-service activation seam for launcher assembly tests. */
  readonly internalCreateDevelopmentManagedServiceActivation?: typeof createDevelopmentManagedServiceActivation
  /** Repository-only platform seam for launcher assembly tests. */
  readonly internalNativeSubmissionPlatform?: NodeJS.Platform
  /** Repository-only factory seam for proving pre-handoff launch assembly failures. */
  readonly internalAgentHistoryHost?: typeof agentHistoryHost
}

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

export function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0 || signal !== null) resolve()
      else reject(new Error(`host exited with status ${String(code)}`))
    })
  })
}

export function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
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

async function createDevelopmentManagedServiceActivation(input: {
  readonly homeConfigPath: string
  readonly homeDir: string
  readonly environment: NodeJS.ProcessEnv
}): Promise<ManagedServiceNodeActivation> {
  const homeConfig = await ensureHomeConfig({ configPath: input.homeConfigPath })
  const codex = ownValue(homeConfig.apps, 'codex')
  if (codex === undefined) throw new Error('host app is not configured: codex')
  const runtimeGeneration = randomBytes(16).toString('hex')
  const store = new PluginActivationStore(input.homeDir, codex.defaultProfile, runtimeGeneration)
  const active = await store.loadActive()
  const nestedAccesses = await Promise.all(active.plugins.flatMap(item =>
    item.enabled
      ? [(async () => {
        const staged = await loadStagedPluginPackage(input.homeDir, item.digest)
        if (
          staged.manifest.id !== item.id || staged.manifest.version !== item.version
          || JSON.stringify(staged.manifest.dependencies) !== JSON.stringify(item.dependencies)
        ) throw new Error(`active plugin package metadata failed readback for ${item.id}`)
        const manifest = staged.manifest.runtimeManifest
        if (manifest.schemaVersion !== 14) return []
        return await Promise.all(manifest.services.flatMap(service =>
          service.kind === 'managed-backend'
            ? [managedBackendRuntimeServiceAccess(
              input.homeDir,
              {
                id: item.id,
                version: item.version,
                digest: item.digest,
                moduleGeneration: item.moduleGeneration,
              },
              service.id,
              runtimeGeneration,
            )]
            : []
        ))
      })()]
      : []
  ))
  const host = new ManagedServiceNodeHost(
    new ManagedServiceRuntime({ homeDir: input.homeDir, environment: input.environment }),
    'development',
    runtimeGeneration,
  )
  try {
    return await host.replace(nestedAccesses.flat())
  } catch (error) {
    await host.dispose().catch(() => undefined)
    throw error
  }
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

/** A launch is usable only after the CDP watcher has installed a renderer. */
export async function waitForHostExitAfterReadiness(input: {
  readonly childExit: Promise<void>
  readonly ready: Promise<void>
  readonly signal: AbortSignal
}): Promise<void> {
  let ready = false
  void input.ready.then(() => {
    ready = true
  })
  await Promise.race([
    input.childExit.then(() => {
      if (!ready) throw new Error('Host exited before CordisX CDP became ready')
    }),
    waitForAbort(input.signal),
  ])
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
  readonly debugPort: number
  readonly hostArgs: readonly string[]
  readonly launcher: CordisXLauncherOptions
  readonly profile?: IsolatedCodexProfile
  /** Product launch may acquire before profile preparation and hand ownership to this lifecycle. */
  readonly profileLease?: Awaited<ReturnType<typeof acquireCodexProfileLaunchLease>>
  readonly environment?: Readonly<Record<string, string>>
  readonly stdout: (line: string) => void
  readonly onReady?: () => void | Promise<void>
  readonly onHostLaunched?: (pid: number) => void | Promise<void>
}): Promise<void> {
  const controller = new AbortController()
  const stop = (): void => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
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
      await input.onReady?.()
      markReady()
      input.stdout('[cordisx] CDP renderer ready')
    },
    onStatus: message => input.stdout(`[cordisx] ${message}`),
  })
  let launched: ChildProcess | undefined
  let profileLease = input.profileLease
  let primaryError: unknown
  try {
    if (input.launcher.attach) {
      await Promise.race([waitForAbort(controller.signal), watcher])
      return
    }
    if (input.executable === undefined) throw new Error('host executable was not resolved')
    if (input.profile !== undefined && profileLease === undefined) {
      profileLease = await acquireCodexProfileLaunchLease(input.profile.userDataDir)
    }
    input.stdout(`[cordisx] launching ${input.executable} with CDP 127.0.0.1:${input.debugPort}`)
    launched = launchCodex(
      input.executable,
      input.debugPort,
      input.hostArgs,
      input.profile,
      input.launcher.onlineDevtools,
      input.environment,
    )
    if (launched.pid === undefined) throw new Error('launched Host exposed no PID')
    await input.onHostLaunched?.(launched.pid)
    await Promise.race([
      waitForHostExitAfterReadiness({
        childExit: waitForExit(launched),
        ready: rendererReady,
        signal: controller.signal,
      }),
      watcher,
    ])
  } catch (error) {
    primaryError = error
    throw error
  } finally {
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
        : { terminateHost: async () => await terminateIsolatedCodex(launchedHost, input.profile) }),
    })
    const hostTermination = launchedHost === undefined ? undefined : cleanup.at(-1)
    const leaseCleanup = hostTermination?.status === 'rejected'
      ? []
      : await Promise.allSettled([profileLease?.release() ?? Promise.resolve()])
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
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
  try {
    vite = await startNativeViteServer(config, {
      cacheRoot: dryRunCacheRoot ?? path.join(cordisxHomeDir, 'cache', 'native-vite'),
      prebundleHostDependencies: !invocation.options.dryRun,
    })
    const activeVite = vite
    if (invocation.options.dryRun) {
      const composition = await buildRendererComposition(config, stdout, {
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
    const homeConfig = await ensureHomeConfig(homeConfigOptions)
    if (invocation.options.attach) {
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
        })
        const createNativeSubmission = runtime.internalCreateNativeSubmissionComposition
          ?? createNativeSubmissionComposition
        nativeSubmission = await createNativeSubmission(managedServiceActivation, executable)
        managedServiceProjection = await createNativeViteManagedServiceProjection({
          activation: managedServiceActivation,
          profileId: 'development',
          runtimeGeneration: managedServiceActivation.hostGeneration,
        })
      } catch (error) {
        await nativeSubmission?.close().catch(() => undefined)
        nativeSubmission = undefined
        await managedServiceProjection?.dispose().catch(() => undefined)
        managedServiceProjection = undefined
        await managedServiceActivation?.dispose().catch(() => undefined)
        managedServiceActivation = undefined
        stdout(`[cordisx] native managed Desktop providers unavailable: ${String(error)}`)
      }
    }
    const entityAuthority = new EntityDirectoryAuthority(cordisxHomeDir, 'development')
    await activeVite.synchronizePluginGenerations(composeNativeVitePluginGenerationHandlers([
      createNativeViteEntityGenerationHandler(entityAuthority, 'development'),
      ...(managedServiceProjection === undefined ? [] : [managedServiceProjection.handler]),
    ]))
    const managementAppId = homeConfig.defaultApp
    const managementApp = ownValue(homeConfig.apps, managementAppId)
    if (managementApp === undefined) throw new Error(`host app is not configured: ${managementAppId}`)
    const managementProfileId = managementApp.defaultProfile
    pluginManagementService = await openPluginManagementService({
      configPath: homeConfigPath,
      homeDir: cordisxHomeDir,
      appId: managementAppId,
      profileId: managementProfileId,
    })
    const pluginManagementToken = randomBytes(32).toString('hex')
    const composition = await buildRendererComposition(config, stdout, {
      profileId: 'development',
      writable: invocation.options.writeConfig === true,
      serviceConfigWritable: false,
      permission: { profileId: 'development', policies: [], persistent: false },
      ...(managedServiceActivation === undefined ? {} : { generation: managedServiceActivation.hostGeneration }),
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
    const configBridge = composition.configBridgeToken === undefined
      ? undefined
      : createLauncherConfigBridgeHandler({
        token: composition.configBridgeToken,
        profileId: 'development',
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
    const identities = pluginIdentities(config)
    const documentLeases = new OwnerDocumentLeaseRegistry({
      stable: identities.map(identity => ({ source: identity.source, pluginId: identity.id })),
    })
    const ownerDocumentHandler = createOwnerDocumentBridgeHandler({
      onDiagnostic: event => stdout(`[cordisx] HTTP transport ${JSON.stringify(event)}`),
      localWalletHomeDir: cordisxHomeDir,
      managedSourcesNow: () => loadManagedSourceTrustNow(cordisxHomeDir, 'development'),
      managedSources: async () =>
        (await import('../launcher/managed-source-trust.js')).loadManagedSourceTrust(cordisxHomeDir, 'development'),
      plugins: config.plugins,
      secret: composition.ownerDocumentSecret,
      profileId: 'development',
      generation: composition.generation,
      store: new OwnerDocumentStore(cordisxHomeDir),
      principalAllowed: principal => documentLeases.allowed(principal),
    })
    const ownerDocuments = Object.assign(ownerDocumentHandler, {
      entities: createEntityBridgeHandler({
        secret: composition.ownerDocumentSecret,
        profileId: 'development',
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
        : await ProviderFleet.create(providerConfigs(config, environment), {
          appServer: { environment },
          agentLoopAuthority: await AgentLoopAuthority.open(cordisxHomeDir, 'development'),
        })
      resourcesHandedOff = true
      const runHost = runtime.internalRunInjectedHost ?? runInjectedHost
      await runHost({
        ...(nativeSubmission === undefined ? {} : { nativeSubmission: nativeSubmission.installation }),
        ...(managedServiceProjection === undefined
          ? {}
          : { managedServiceUI: managedServiceProjection.managedServiceUI }),
        source: composition.source,
        viteDevelopment: true,
        ...(configBridge === undefined ? {} : { configBridge }),
        hasLoopbackGraph: false,
        agentHistoryHost: historyHost,
        agentHistoryBridgeToken: composition.agentHistoryBridgeToken,
        ownerDocuments,
        pluginManagement,
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
      pluginManagementService?.close()
      await vite?.close()
    } finally {
      if (dryRunCacheRoot !== undefined) await rm(dryRunCacheRoot, { recursive: true, force: true })
    }
  }
}

/** Execute one CLI invocation. Exported for package-level integration tests. */
