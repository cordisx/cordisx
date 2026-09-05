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
import { CdpPluginLifecycleRuntime, watchAndInject } from '../launcher/cdp.js'
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

const HELP = `Usage:
  cordisx [app] [profile] [--data shared|host-isolated] [options] [-- host-arguments...]
  cordisx setup
  cordisx config
  cordisx doctor
  cordisx dev [plugin-path | --config path] [options] [-- host-arguments...]

Options:
  --attach                 Attach to an existing loopback CDP endpoint
  --system                 Use the host's system Chromium profile (escape hatch)
  --profile-dir <path>     Override this launch profile's independent Chromium directory
  --executable <path>      Override the host executable
  --debug-port <port>      Override the loopback CDP port
  --online-devtools        Allow the official online DevTools frontend
  --dry-run                Resolve and print the plan without starting the host
  dev without a path       Discover .cordisx/config.json (or cordisx.config.json) upwards
  -h, --help               Show this help`

export interface CordisXCliRuntime {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  /** Test/integration seam for the canonical default `~/.cordisx` root. */
  readonly homedir?: string
  readonly stdout?: (line: string) => void
  /**
   * Internal-only renderer bundle closure for repository-controlled production
   * integration tests. It has no CLI/configuration/environment input and is
   * undefined for every product launch.
   */
  readonly internalBuildRendererBundle?: typeof buildRendererBundle
  /** Repository-only proof that the production composition and authority agree. */
  readonly internalObserveOwnerDocuments?: (input: {
    readonly source: string
    readonly handler: OwnerDocumentBridgeHandler
  }) => void | Promise<void>
  /** Repository-only source seam for built-in Skill deployment tests. */
  readonly internalBuiltinSkillSourceDir?: string
  /** Repository-only HOME seam that prevents launch tests from touching the user's real HOME. */
  readonly internalSharedHomeDir?: string
}

async function deployBuiltinSkillWithoutOverwritingUserChanges(
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

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0 || signal !== null) resolve()
      else reject(new Error(`host exited with status ${String(code)}`))
    })
  })
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
}

function rootFromConfigPath(configPath: string): string {
  return path.dirname(configPath)
}

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function localDevelopmentHostConfig(cwd: string): CordisXConfig {
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

function providerConfigs(config: CordisXConfig, environment: NodeJS.ProcessEnv): readonly CodexProviderConfig[] {
  const local = resolveLocalCodexProviderConfig(config.codex, environment)
  return local === undefined ? config.providers : [...config.providers, local]
}

interface RendererComposition {
  readonly source: string
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
  readonly rebuild: (
    config: CordisXConfig,
    pluginActivation: CordisXPluginActivationRecordV1,
    initialRegistryEpoch: number,
  ) => Promise<string>
}

export function assertProductionGraphLaunchOwnership(attach: boolean, hasLoopbackGraph: boolean): void {
  if (attach && hasLoopbackGraph) {
    throw new Error('production browser graphs require a launcher-owned native Host; --attach is unsupported')
  }
}

type ChannelManagerBundleProjection = NonNullable<Parameters<typeof buildRendererBundle>[1]>['channelManager']

/** Build the exact renderer composition that the launcher will inject through CDP. */
export async function buildRendererComposition(
  config: CordisXConfig,
  stdout: (line: string) => void,
  options: {
    readonly profileId?: string
    readonly appId?: string
    readonly iconThemePreference?: HomeConfigIconThemePreference
    readonly writable?: boolean
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
    readonly pluginBundles?: CordisXPluginBundleManagerSnapshotV1
    readonly certifiedPermissionChannelToken?: string
    readonly pluginActivation?: CordisXPluginActivationRecordV1
    readonly initialRegistryEpoch?: number
    readonly channelManager?: ChannelManagerBundleProjection
    /** Transient, launcher-created tokens. They are published only in the injected runtime metadata. */
    readonly channelCredentialBridgeToken?: string
    readonly channelActionsBridgeToken?: string
    readonly internalBuildRendererBundle?: typeof buildRendererBundle
    /** Opt-in development transport; normal launches keep immutable package delivery. */
    readonly developmentBuild?: typeof buildRendererBundle
  } = {},
): Promise<RendererComposition> {
  const providerBridgeToken = (config.codex.agentLoopBackend === 'local-cli'
      || config.providers.some(provider => provider.enabled)
      || config.plugins.some(plugin => plugin.enabled && plugin.id === 'cli-proxy-api'))
    ? randomBytes(32).toString('hex')
    : undefined
  const agentHistoryBridgeToken = randomBytes(32).toString('hex')
  const configBridgeToken = options.writable === true ? randomBytes(32).toString('hex') : undefined
  const ownerDocumentSecret = randomBytes(32).toString('hex')
  const serviceConfigBridgeToken = options.writable === true ? randomBytes(32).toString('hex') : undefined
  const permissionBridgeToken = options.permission?.persistent === true ? randomBytes(32).toString('hex') : undefined
  const iconThemePreferenceBridgeToken = options.writable === true && options.appId !== undefined
    ? randomBytes(32).toString('hex')
    : undefined
  const generation = options.generation ?? randomBytes(16).toString('hex')
  const profileId = options.permission?.profileId ?? options.profileId ?? 'development'
  const bundleOptions = {
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
    ...(options.pluginBundles === undefined ? {} : { pluginBundleSnapshot: options.pluginBundles }),
    ...((options.pluginActivation ?? options.pluginLifecycle?.activation) === undefined
      ? {}
      : { pluginActivation: options.pluginActivation ?? options.pluginLifecycle!.activation }),
    ...((options.initialRegistryEpoch ?? options.pluginLifecycle?.registryEpoch) === undefined
      ? {}
      : { initialRegistryEpoch: options.initialRegistryEpoch ?? options.pluginLifecycle!.registryEpoch }),
    ...(options.channelManager === undefined ? {} : { channelManager: options.channelManager }),
  } satisfies NonNullable<Parameters<typeof buildRendererBundle>[1]>
  const buildBundle = options.developmentBuild ?? options.internalBuildRendererBundle ?? buildRendererBundle
  const source = await buildBundle(config, bundleOptions)
  const newDocumentSource = options.certifiedPermissionChannelToken === undefined
    ? undefined
    : await buildBundle(config, {
      ...bundleOptions,
      certifiedPermissionChannelToken: options.certifiedPermissionChannelToken,
    })
  const enabled = config.plugins.filter(plugin => plugin.enabled).map(plugin => plugin.id)
  const hasLoopbackGraph = config.plugins.some(plugin => plugin.enabled && plugin.runtimeGraph !== undefined)
  stdout(
    `[cordisx] ${
      options.developmentBuild === undefined ? 'bundle' : 'Vite entry'
    } ready: ${source.length} bytes, plugins: ${enabled.join(', ') || '(none)'}`,
  )
  return {
    source,
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
    rebuild: async (nextConfig, pluginActivation, initialRegistryEpoch) =>
      await buildBundle(nextConfig, {
        ...bundleOptions,
        ownerDocumentAuthority: { secret: ownerDocumentSecret, profileId, generation },
        pluginActivation,
        initialRegistryEpoch,
      }),
  }
}

function codexHome(environment: Readonly<Record<string, string>> | NodeJS.ProcessEnv): string {
  const explicit = environment.CODEX_HOME
  if (typeof explicit === 'string' && explicit.length > 0) return path.resolve(explicit)
  const home = typeof environment.HOME === 'string' && environment.HOME.length > 0 ? environment.HOME : os.homedir()
  return path.join(home, '.codex')
}

function agentHistoryHost(
  environment: Readonly<Record<string, string>> | NodeJS.ProcessEnv,
  configPath: string,
  profileName: string,
): CodexAgentHistoryHost {
  return new CodexAgentHistoryHost({
    codexHome: codexHome(environment),
    cacheDir: path.join(path.dirname(configPath), 'cache', 'agent-history'),
    profileName,
  })
}

function pluginIdentities(config: CordisXConfig): readonly CordisXPluginIdentity[] {
  return config.plugins.map(plugin => ({ source: plugin.source ?? pathToFileURL(plugin.entry).href, id: plugin.id }))
}

function cliProxyServiceConfigApis(input: {
  readonly token: string
  readonly profileId: string
  readonly generation: string
  readonly configPath: string
  readonly rootDir: string
  readonly environment: NodeJS.ProcessEnv
  readonly fleet: ProviderFleet
}): readonly { readonly pluginId: string; readonly serviceId: string; readonly api: HostServiceConfigNarrowApi }[] {
  const secretState = (reference: string | undefined): HostSecretState => {
    if (reference === undefined || reference === '') return 'missing'
    const environmentName = /^host-secret:env\/([A-Z_][A-Z0-9_]*)$/u.exec(reference)?.[1]
    if (environmentName !== undefined) return input.environment[environmentName] === undefined ? 'missing' : 'ready'
    return 'unavailable'
  }
  const startup = new HostServiceConfigNarrowApi({
    contract: CLI_PROXY_PROVIDER_STARTUP_CONFIG_CONTRACT,
    profileId: input.profileId,
    generation: input.generation,
    ownerToken: input.token,
    configPath: input.configPath,
    writable: true,
    authorize: () => true,
    secretState,
  })
  const runtime = new HostServiceConfigNarrowApi({
    contract: CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT,
    profileId: input.profileId,
    generation: input.generation,
    ownerToken: input.token,
    configPath: input.configPath,
    writable: true,
    authorize: () => true,
    secretState,
    restartService: async candidate => {
      const startupState = await readServiceConfigState({
        profileId: input.profileId,
        pluginId: 'cli-proxy-api',
        serviceId: CLI_PROXY_PROVIDER_STARTUP_SERVICE_ID,
        initialConfig: CLI_PROXY_PROVIDER_STARTUP_CONFIG_INITIAL as unknown as Parameters<
          typeof readServiceConfigState
        >[0]['initialConfig'],
      }, input.configPath)
      const providers = resolveCliProxyProviderConfigs(
        CLI_PROXY_PROVIDER_RUNTIME_CONFIG_CONTRACT.parseStored(
          candidate,
        ) as unknown as typeof CLI_PROXY_PROVIDER_RUNTIME_CONFIG_INITIAL,
        parseCliProxyProviderStartupConfig(startupState.config as unknown),
        { rootDir: input.rootDir },
      )
      return await input.fleet.reconfigure(providers)
    },
  })
  return [
    { pluginId: 'cli-proxy-api', serviceId: CLI_PROXY_PROVIDER_RUNTIME_SERVICE_ID, api: runtime },
    { pluginId: 'cli-proxy-api', serviceId: CLI_PROXY_PROVIDER_STARTUP_SERVICE_ID, api: startup },
  ]
}

function recoveredActivation(plan: RollbackPlan, runtimeGeneration: string): CordisXPluginActivationRecordV1 {
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

function printPlan(
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

async function runInjectedHost(input: {
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
  readonly developmentRuntime?: CdpPluginLifecycleRuntime
  readonly viteDevelopment?: boolean
  readonly hasLoopbackGraph: boolean
  readonly pluginArtifactOrigin?: string
  readonly publisherGrant?: PublisherGrantBridgeHandler
  readonly certifiedPermission?: Readonly<{
    authority: LauncherMarketplaceCertifiedAuthority
    token: string
    profileId: string
    runtimeGeneration: string
  }>
  readonly executable?: string
  readonly debugPort: number
  readonly hostArgs: readonly string[]
  readonly launcher: CordisXLauncherOptions
  readonly profile?: IsolatedCodexProfile
  readonly environment?: Readonly<Record<string, string>>
  readonly stdout: (line: string) => void
  readonly onReady?: () => void
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
    ...(input.developmentRuntime === undefined ? {} : { developmentRuntime: input.developmentRuntime }),
    ...(input.viteDevelopment === true ? { viteDevelopment: true } : {}),
    hasLoopbackGraph: input.hasLoopbackGraph,
    ...(input.hasLoopbackGraph ? { launcherOwnedNativeTarget: !input.launcher.attach } : {}),
    ...(input.pluginArtifactOrigin === undefined ? {} : { pluginArtifactOrigin: input.pluginArtifactOrigin }),
    ...(input.publisherGrant === undefined ? {} : { publisherGrant: input.publisherGrant }),
    ...(input.certifiedPermission === undefined ? {} : { certifiedPermission: input.certifiedPermission }),
    onReady: () => {
      if (reportedReady) return
      reportedReady = true
      markReady()
      input.stdout('[cordisx] CDP renderer ready')
      input.onReady?.()
    },
    onStatus: message => input.stdout(`[cordisx] ${message}`),
  })
  let launched: ChildProcess | undefined
  let primaryError: unknown
  try {
    if (input.launcher.attach) {
      await Promise.race([waitForAbort(controller.signal), watcher])
      return
    }
    if (input.executable === undefined) throw new Error('host executable was not resolved')
    input.stdout(`[cordisx] launching ${input.executable} with CDP 127.0.0.1:${input.debugPort}`)
    launched = launchCodex(
      input.executable,
      input.debugPort,
      input.hostArgs,
      input.profile,
      input.launcher.onlineDevtools,
      input.environment,
    )
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
    const cleanup = await Promise.allSettled([
      watcher,
      ...(input.providerFleet === undefined ? [] : [input.providerFleet.close()]),
      Promise.resolve(input.agentHistoryHost.dispose()),
      ...(launched === undefined ? [] : [terminateIsolatedCodex(launched, input.profile)]),
    ])
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    if (primaryError === undefined) {
      const rejected = cleanup.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (rejected !== undefined) throw rejected.reason
    }
  }
}

async function runDevelopment(
  invocation: CordisXDevInvocation,
  cwd: string,
  stdout: (line: string) => void,
  environment: NodeJS.ProcessEnv,
  homeConfigPath: string,
  homeConfigOptions: HomeConfigPathOptions,
  runtime: CordisXCliRuntime,
): Promise<void> {
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
  const config: CordisXConfig = entry === undefined
    ? await loadConfig(location!.configPath, { projectRoot: location!.projectRoot })
    : {
      ...localDevelopmentHostConfig(cwd),
      plugins: [{ id: localIdentity!.id, source: localIdentity!.source, entry, enabled: true, config: {} }],
    }
  if (!invocation.options.dryRun) await ensureCordisXHomeDirectory(homeConfigOptions)
  const dryRunCacheRoot = invocation.options.dryRun
    ? await mkdtemp(path.join(os.tmpdir(), 'cordisx-vite-dry-run-'))
    : undefined
  let vite: Awaited<ReturnType<typeof startNativeViteServer>> | undefined
  try {
    vite = await startNativeViteServer(config, {
      cacheRoot: dryRunCacheRoot ?? path.join(cordisxHomeDir, 'cache', 'native-vite'),
      prebundleHostDependencies: !invocation.options.dryRun,
    })
    const activeVite = vite
    const composition = await buildRendererComposition(config, stdout, {
      profileId: 'development',
      permission: { profileId: 'development', policies: [], persistent: false },
      developmentBuild: (nextConfig, options = {}) => activeVite.buildBootstrap(nextConfig, options),
    })
    if (invocation.options.dryRun) {
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
    if (invocation.options.attach) {
      stdout('[cordisx] built-in Skill deployment skipped for --attach because the Host HOME is unknown')
    } else {
      await deployBuiltinSkillWithoutOverwritingUserChanges(
        deployBundledCordisXSkillToHome(
          runtime.internalSharedHomeDir ?? environment.HOME ?? runtime.homedir ?? os.homedir(),
          runtime.internalBuiltinSkillSourceDir === undefined
            ? {}
            : { sourceDir: runtime.internalBuiltinSkillSourceDir },
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
      secret: composition.ownerDocumentSecret,
      profileId: 'development',
      generation: composition.generation,
      store: new OwnerDocumentStore(cordisxHomeDir),
      principalAllowed: principal => documentLeases.allowed(principal),
    })
    const entityAuthority = new EntityDirectoryAuthority(cordisxHomeDir, 'development')
    await activeVite.synchronizePluginGenerations(
      createNativeViteEntityGenerationHandler(entityAuthority, 'development'),
    )
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
      historyHost = agentHistoryHost(environment, homeConfigPath, `development:${config.rootDir}`)
      providerFleet = composition.providerBridgeToken === undefined
        ? undefined
        : await ProviderFleet.create(providerConfigs(config, environment), {
          appServer: { environment },
          agentLoopAuthority: await AgentLoopAuthority.open(cordisxHomeDir, 'development'),
        })
      resourcesHandedOff = true
      await runInjectedHost({
        source: composition.source,
        viteDevelopment: true,
        hasLoopbackGraph: false,
        agentHistoryHost: historyHost,
        agentHistoryBridgeToken: composition.agentHistoryBridgeToken,
        ownerDocuments,
        ...(providerFleet === undefined || composition.providerBridgeToken === undefined ? {} : {
          providerFleet,
          providerBridgeToken: composition.providerBridgeToken,
        }),
        ...(executable === undefined ? {} : { executable }),
        debugPort,
        hostArgs: invocation.hostArgs,
        launcher: invocation.options,
        ...(profile === undefined ? {} : { profile }),
        ...(entry === undefined ? {} : {
          environment: {
            CORDISX_DEV_ENTRY: entry,
            CORDISX_DEV_MODE: 'explicit-entry',
          },
        }),
        publisherGrant,
        stdout,
      })
    } finally {
      if (!resourcesHandedOff) {
        historyHost?.dispose()
        await providerFleet?.close()
      }
    }
  } finally {
    try {
      await vite?.close()
    } finally {
      if (dryRunCacheRoot !== undefined) await rm(dryRunCacheRoot, { recursive: true, force: true })
    }
  }
}

/** Execute one CLI invocation. Exported for package-level integration tests. */
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
      channelManager = projectLocalChannelManager({
        configuration: state.config,
        revision: state.revision,
        lastGoodRevision: state.lastGoodRevision,
        writable: true,
        ...(channelService.snapshot() === undefined ? {} : { runtime: channelService.snapshot()! }),
        audit: channelService.auditSnapshot(),
      })
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
        await channelService?.dispose()
        await providerFleet?.close()
        throw error
      }
      const debugPort = invocation.options.debugPort ?? composition.codex.debugPort
      if (invocation.options.dryRun) {
        stdout(JSON.stringify({ status: 'ready', mode: 'attach', appId, debugPort }, null, 2))
        await channelService?.dispose()
        await providerFleet?.close()
        return
      }
      stdout('[cordisx] built-in Skill deployment skipped for --attach because the Host HOME is unknown')
      try {
        await runInjectedHost({
          source: rendererComposition.source,
          hasLoopbackGraph: rendererComposition.hasLoopbackGraph,
          ...(rendererComposition.hasLoopbackGraph
            ? {
              pluginArtifactOrigin: activePluginGenerationArtifactServer.origin,
            }
            : {}),
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
        ...(rendererComposition.hasLoopbackGraph
          ? {
            pluginArtifactOrigin: activePluginGenerationArtifactServer.origin,
          }
          : {}),
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
      await channelService?.dispose()
      await providerFleet?.close()
    }
  } finally {
    await pluginGenerationArtifactServer?.close()
    await certifiedPermissionAuthority?.dispose()
  }
}
