import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import type { ChildProcess } from 'node:child_process'
import { resolveHostAdapter } from '../adapters/registry.js'
import type { ResolvedLaunchPlan } from '../adapters/contracts.js'
import { ensureHomeConfig, loadHomeConfig, resolveHomeConfigPath } from '../config/home-config.js'
import { buildRendererBundle } from '../launcher/bundle.js'
import { CdpPluginLifecycleRuntime, watchAndInject } from '../launcher/cdp.js'
import { loadConfig, type CordisXConfig } from '../launcher/config.js'
import {
  assertLoopbackPortAvailable,
  findFreeLoopbackPort,
  launchCodex,
  prepareIsolatedCodexProfile,
  resolveCodexExecutable,
  terminateIsolatedCodex,
  type IsolatedCodexProfile,
} from '../launcher/process.js'
import { parseCordisXCli, type CordisXDevInvocation, type CordisXLauncherOptions } from './parse.js'
import { resolveProfileSelection } from './profiles.js'
import { ProviderFleet } from '../providers/fleet.js'
import { CodexAgentHistoryHost } from '../launcher/agent-history.js'
import { createConfigBridgeHandler, type ConfigBridgeHandler } from '../launcher/config-rpc.js'
import type { CordisXPluginIdentity } from '../platform-contracts.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import { PluginPermissionIdentityRegistry, type PermissionPersistenceContext } from '../launcher/permission-rpc.js'
import { PluginActivationStore } from '../launcher/plugin-activation.js'
import { loadActivatedPluginComposition, loadPluginComposition } from '../launcher/plugin-composition.js'
import { PluginLifecycleCoordinator } from '../launcher/plugin-lifecycle.js'
import type { PluginLifecycleBridgeHandler } from '../launcher/plugin-lifecycle-rpc.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../plugin-lifecycle-contracts.js'
import type { RollbackPlan } from '../launcher/packages/authority.js'

const HELP = `Usage:
  cordisx [app] [profile] [--data shared|isolated] [options] [-- host-arguments...]
  cordisx setup
  cordisx config
  cordisx doctor
  cordisx dev [plugin-path] [--config path] [options] [-- host-arguments...]

Options:
  --attach                 Attach to an existing loopback CDP endpoint
  --system                 Use the host's system Chromium profile
  --profile-dir <path>     Override the independent Chromium profile directory
  --executable <path>      Override the host executable
  --debug-port <port>      Override the loopback CDP port
  --online-devtools        Allow the official online DevTools frontend
  --dry-run                Resolve and print the plan without starting the host
  -h, --help               Show this help`

export interface CordisXCliRuntime {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly stdout?: (line: string) => void
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

function pluginId(pluginPath: string): string {
  const name = path.basename(pluginPath, path.extname(pluginPath))
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 96)
  return name === '' || name === 'host' || name.startsWith('cordisx.') ? 'local-plugin' : name
}

function developmentPluginConfig(pluginPath: string, cwd: string): CordisXConfig {
  const entry = path.resolve(cwd, pluginPath)
  return {
    version: 1,
    rootDir: cwd,
    codex: { debugPort: 9229 },
    providers: [],
    plugins: [{ id: pluginId(entry), entry, enabled: true, config: {}, revision: 0 }],
  }
}

interface RendererComposition {
  readonly source: string
  readonly providerBridgeToken?: string
  readonly agentHistoryBridgeToken: string
  readonly configBridgeToken?: string
  readonly generation: string
  readonly permissionBridgeToken?: string
  readonly pluginLifecycleBridgeToken?: string
}

async function bundle(
  config: CordisXConfig,
  stdout: (line: string) => void,
  options: {
    readonly profileId?: string
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
  } = {},
): Promise<RendererComposition> {
  const providerBridgeToken = config.providers.some(provider => provider.enabled) ? randomBytes(32).toString('hex') : undefined
  const agentHistoryBridgeToken = randomBytes(32).toString('hex')
  const configBridgeToken = options.writable === true ? randomBytes(32).toString('hex') : undefined
  const permissionBridgeToken = options.permission?.persistent === true ? randomBytes(32).toString('hex') : undefined
  const generation = options.generation ?? randomBytes(16).toString('hex')
  const source = await buildRendererBundle(config, {
    ...(providerBridgeToken === undefined ? {} : { providerBridgeToken }),
    agentHistoryBridgeToken,
    ...(configBridgeToken === undefined ? {} : { configBridgeToken }),
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
    ...(options.pluginLifecycle === undefined ? {} : {
      pluginLifecycleBridgeToken: options.pluginLifecycle.token,
      pluginActivation: options.pluginLifecycle.activation,
      ...(options.pluginLifecycle.registryEpoch === undefined
        ? {}
        : { initialRegistryEpoch: options.pluginLifecycle.registryEpoch }),
    }),
  })
  const enabled = config.plugins.filter(plugin => plugin.enabled).map(plugin => plugin.id)
  stdout(`[cordisx] bundle ready: ${source.length} bytes, plugins: ${enabled.join(', ') || '(none)'}`)
  return {
    source,
    ...(providerBridgeToken === undefined ? {} : { providerBridgeToken }),
    agentHistoryBridgeToken,
    ...(configBridgeToken === undefined ? {} : { configBridgeToken }),
    generation,
    ...(permissionBridgeToken === undefined ? {} : { permissionBridgeToken }),
    ...(options.pluginLifecycle === undefined ? {} : { pluginLifecycleBridgeToken: options.pluginLifecycle.token }),
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

function printPlan(plan: ResolvedLaunchPlan, stdout: (line: string) => void): void {
  stdout(JSON.stringify({ status: 'ready', plan }, null, 2))
}

async function runInjectedHost(input: {
  readonly source: string
  readonly providerFleet?: ProviderFleet
  readonly providerBridgeToken?: string
  readonly agentHistoryHost: CodexAgentHistoryHost
  readonly agentHistoryBridgeToken: string
  readonly configBridge?: ConfigBridgeHandler
  readonly permissionPersistence?: PermissionPersistenceContext
  readonly pluginLifecycle?: { readonly handler: PluginLifecycleBridgeHandler; readonly runtime: CdpPluginLifecycleRuntime }
  readonly executable?: string
  readonly debugPort: number
  readonly hostArgs: readonly string[]
  readonly launcher: CordisXLauncherOptions
  readonly profile?: IsolatedCodexProfile
  readonly environment?: Readonly<Record<string, string>>
  readonly stdout: (line: string) => void
}): Promise<void> {
  const controller = new AbortController()
  const stop = (): void => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const watcher = watchAndInject({
    port: input.debugPort,
    source: input.source,
    signal: controller.signal,
    ...(input.providerFleet === undefined || input.providerBridgeToken === undefined ? {} : {
      providerFleet: input.providerFleet,
      providerBridgeToken: input.providerBridgeToken,
    }),
    agentHistoryHost: input.agentHistoryHost,
    agentHistoryBridgeToken: input.agentHistoryBridgeToken,
    ...(input.configBridge === undefined ? {} : { configBridge: input.configBridge }),
    ...(input.permissionPersistence === undefined ? {} : { permissionPersistence: input.permissionPersistence }),
    ...(input.pluginLifecycle === undefined ? {} : { pluginLifecycle: input.pluginLifecycle }),
    onStatus: message => input.stdout(`[cordisx] ${message}`),
  })
  let launched: ChildProcess | undefined
  let primaryError: unknown
  try {
    if (input.launcher.attach) {
      await waitForAbort(controller.signal)
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
    await Promise.race([waitForExit(launched), waitForAbort(controller.signal)])
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    controller.abort()
    const cleanup = await Promise.allSettled([
      watcher,
      ...(input.providerFleet === undefined ? [] : [input.providerFleet.close()]),
      Promise.resolve(input.agentHistoryHost.dispose()),
      ...(launched === undefined ? [] : [terminateIsolatedCodex(launched)]),
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
): Promise<void> {
  const config = invocation.pluginPath === undefined
    ? await loadConfig(path.resolve(cwd, invocation.configPath ?? 'cordisx.config.json'))
    : developmentPluginConfig(invocation.pluginPath, cwd)
  const composition = await bundle(config, stdout, {
    profileId: 'development',
    permission: { profileId: 'development', policies: [], persistent: false },
  })
  if (invocation.options.dryRun) {
    stdout(JSON.stringify({
      status: 'ready',
      mode: 'development',
      config: invocation.pluginPath === undefined
        ? path.resolve(cwd, invocation.configPath ?? 'cordisx.config.json')
        : pathToFileURL(path.resolve(cwd, invocation.pluginPath)).href,
      debugPort: invocation.options.debugPort ?? (
        invocation.options.attach || invocation.options.system ? config.codex.debugPort : 'automatic'
      ),
      hostArgs: invocation.hostArgs,
    }, null, 2))
    return
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
    : await prepareIsolatedCodexProfile(config.rootDir, invocation.options.profileDir)
  await runInjectedHost({
    source: composition.source,
    agentHistoryHost: agentHistoryHost(environment, resolveHomeConfigPath({ env: environment }), `development:${config.rootDir}`),
    agentHistoryBridgeToken: composition.agentHistoryBridgeToken,
    ...(composition.providerBridgeToken === undefined ? {} : {
      providerFleet: await ProviderFleet.create(config.providers, { appServer: { environment } }),
      providerBridgeToken: composition.providerBridgeToken,
    }),
    ...(executable === undefined ? {} : { executable }),
    debugPort,
    hostArgs: invocation.hostArgs,
    launcher: invocation.options,
    ...(profile === undefined ? {} : { profile }),
    stdout,
  })
}

/** Execute one CLI invocation. Exported for package-level integration tests. */
export async function runCordisXCli(argv: readonly string[], runtime: CordisXCliRuntime = {}): Promise<void> {
  const invocation = parseCordisXCli(argv)
  const stdout = runtime.stdout ?? console.log
  const cwd = runtime.cwd ?? process.cwd()
  const configPath = resolveHomeConfigPath({ env: runtime.env ?? process.env })

  if (invocation.action === 'help') {
    stdout(HELP)
    return
  }
  if (invocation.action === 'setup') {
    const config = await ensureHomeConfig({ env: runtime.env ?? process.env })
    stdout(`[cordisx] configuration ready: ${configPath}`)
    stdout(JSON.stringify(config, null, 2))
    return
  }
  if (invocation.action === 'config') {
    const config = await ensureHomeConfig({ env: runtime.env ?? process.env })
    stdout(`[cordisx] configuration: ${configPath}`)
    stdout(JSON.stringify(config, null, 2))
    return
  }
  if (invocation.action === 'dev') {
    await runDevelopment(invocation, cwd, stdout, runtime.env ?? process.env)
    return
  }

  const config = await ensureHomeConfig({ env: runtime.env ?? process.env })
  const appId = invocation.action === 'launch' ? invocation.app ?? config.defaultApp : config.defaultApp
  const adapter = resolveHostAdapter(appId)
  if (invocation.action === 'launch' && invocation.options.attach && (
    invocation.profile !== undefined || invocation.dataMode !== undefined
  )) {
    throw new Error('--attach cannot select or override a named profile')
  }
  if (invocation.action === 'launch' && invocation.options.system) {
    const app = ownValue(config.apps, appId)
    if (app === undefined) throw new Error(`host app is not configured: ${appId}`)
    const profileId = invocation.profile ?? app.defaultProfile
    const mode = invocation.dataMode ?? ownValue(app.profiles, profileId)?.dataMode ?? 'isolated'
    if (mode === 'isolated') throw new Error('--system cannot enforce an isolated host-data profile')
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
      stdout(JSON.stringify({
        status: 'unavailable',
        appId,
        profileId: selection.profileId,
        dataMode: selection.dataMode,
        diagnostic: error instanceof Error ? error.message : String(error),
      }, null, 2))
    }
    return
  }

  const configuredComposition = await loadConfig(configPath, { profileId: selection.profileId })
  const currentHomeConfig = await loadHomeConfig(configPath)
  const permissionPolicies = currentHomeConfig.permissions.filter(policy => policy.key.profileId === selection.profileId)
  const lifecycleGeneration = randomBytes(16).toString('hex')
  const lifecycleStore = new PluginActivationStore(rootFromConfigPath(configPath), selection.profileId, lifecycleGeneration)
  const lifecycleRuntime = new CdpPluginLifecycleRuntime()
  const configuredIds = new Set(configuredComposition.plugins.map(plugin => plugin.id))
  const pluginLifecycleCoordinator = new PluginLifecycleCoordinator({
    homeDir: rootFromConfigPath(configPath),
    profileId: selection.profileId,
    runtimeGeneration: lifecycleGeneration,
    permissionPolicies,
    loadPermissionPolicies: async () => (await loadHomeConfig(configPath)).permissions
      .filter(policy => policy.key.profileId === selection.profileId),
    runtime: lifecycleRuntime,
    reservedPluginIds: [...configuredIds],
  })
  const recoveryPlans = await pluginLifecycleCoordinator.prepareRecovery()
  if (recoveryPlans.length > 1) throw new Error('multiple shared registry rollback recoveries require separate launcher runs')
  const recoveryPlan = recoveryPlans[0]
  const initialActivation = recoveryPlan === undefined
    ? undefined
    : recoveredActivation(recoveryPlan, lifecycleGeneration)
  const activatedPlugins = initialActivation === undefined
    ? await loadActivatedPluginComposition(lifecycleStore)
    : await loadPluginComposition(lifecycleStore, initialActivation)
  const permissionIdentities = new PluginPermissionIdentityRegistry(pluginIdentities({
    ...configuredComposition,
    plugins: activatedPlugins,
  }))
  lifecycleRuntime.setPermissionIdentities(permissionIdentities)
  const collision = activatedPlugins.find(plugin => configuredIds.has(plugin.id))
  if (collision !== undefined) throw new Error(`launcher-configured plugin already owns package id ${collision.id}`)
  const composition: CordisXConfig = {
    ...configuredComposition,
    plugins: [...configuredComposition.plugins, ...activatedPlugins],
  }
  const pluginLifecycleBridgeToken = randomBytes(32).toString('hex')
  const pluginLifecycle = {
    handler: {
      token: pluginLifecycleBridgeToken,
      profileId: selection.profileId,
      generation: lifecycleGeneration,
      coordinator: pluginLifecycleCoordinator,
    },
    runtime: lifecycleRuntime,
  }
  const rendererComposition = await bundle(composition, stdout, {
    profileId: selection.profileId,
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
  const permissionPersistence = rendererComposition.permissionBridgeToken === undefined ? undefined : {
    configPath,
    profileId: selection.profileId,
    token: rendererComposition.permissionBridgeToken,
    identities: pluginIdentities(configuredComposition),
    identityAllowed: (identity: CordisXPluginIdentity) => permissionIdentities.allowed(identity),
  }
  if (invocation.options.attach) {
    const debugPort = invocation.options.debugPort ?? composition.codex.debugPort
    if (invocation.options.dryRun) {
      stdout(JSON.stringify({ status: 'ready', mode: 'attach', appId, debugPort }, null, 2))
      return
    }
    await runInjectedHost({
      source: rendererComposition.source,
      agentHistoryHost: agentHistoryHost(runtime.env ?? process.env, configPath, `${appId}:${selection.profileId}:attach`),
      agentHistoryBridgeToken: rendererComposition.agentHistoryBridgeToken,
      ...(rendererComposition.providerBridgeToken === undefined ? {} : {
        providerFleet: await ProviderFleet.create(composition.providers, { appServer: { environment: runtime.env ?? process.env } }),
        providerBridgeToken: rendererComposition.providerBridgeToken,
      }),
      ...(configBridge === undefined ? {} : { configBridge }),
      ...(permissionPersistence === undefined ? {} : { permissionPersistence }),
      pluginLifecycle,
      debugPort,
      hostArgs: invocation.hostArgs,
      launcher: invocation.options,
      stdout,
    })
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
  printPlan(plan, stdout)
  if (invocation.options.dryRun) {
    stdout(`[cordisx] loopback CDP port: ${invocation.options.debugPort ?? 'automatic'}`)
    return
  }

  const debugPort = invocation.options.debugPort ?? await findFreeLoopbackPort()
  if (invocation.options.debugPort !== undefined) await assertLoopbackPortAvailable(debugPort)
  await adapter.prepareLaunch(plan)
  stdout(`[cordisx] loopback CDP port: ${debugPort}`)
  const profile = plan.chromiumProfile.mode === 'independent'
    ? { userDataDir: plan.chromiumProfile.path }
    : undefined
  await runInjectedHost({
    source: rendererComposition.source,
    agentHistoryHost: agentHistoryHost(
      { ...(runtime.env ?? process.env), ...plan.environment },
      configPath,
      `${appId}:${selection.profileId}:${selection.dataMode}`,
    ),
    agentHistoryBridgeToken: rendererComposition.agentHistoryBridgeToken,
    ...(rendererComposition.providerBridgeToken === undefined ? {} : {
      providerFleet: await ProviderFleet.create(composition.providers, { appServer: { environment: runtime.env ?? process.env } }),
      providerBridgeToken: rendererComposition.providerBridgeToken,
    }),
    ...(configBridge === undefined ? {} : { configBridge }),
    ...(permissionPersistence === undefined ? {} : { permissionPersistence }),
    pluginLifecycle,
    executable: plan.executable,
    debugPort,
    hostArgs: invocation.hostArgs,
    launcher: invocation.options,
    ...(profile === undefined ? {} : { profile }),
    ...(Object.keys(plan.environment).length === 0 ? {} : { environment: plan.environment }),
    stdout,
  })
}
