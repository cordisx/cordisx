import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import { CORDISX_PLATFORM_CAPABILITIES, CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../contracts.js'
import type {
  CordisXBrowserPlugin,
  CordisXCommandReference,
  CordisXManagerSettingsTabItem,
  CordisXManagerSettingsNavigationItem,
  CordisXPermissionAuthorizationDecisionV1,
  CordisXPermissionPolicy,
  CordisXPermissionAuthorizationPlanV1,
  CordisXPluginManifestV4,
  CordisXPointPolicy,
  CordisXPlatformCapability,
  CordisXCapabilityScope,
  CordisXPluginIdentity,
  CordisXPluginActivationRecordV1,
  CordisXPluginPackageManifestV1,
  CordisXPluginLifecycleOperationV1,
  CordisXPluginLifecycleResultV1,
  CordisXPluginConsoleFacade,
  CordisXLocalizedText,
  CordisXPluginManifestV1,
  CordisXPluginModule,
  CordisXRouteReference,
} from '../contracts.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import type {
  CordisXPermissionAuthorizationDecisionV2,
  CordisXPermissionAuthorizationPlanV2,
} from '../permission-contracts.js'
import { installCodexAdapter, type CodexAdapterHandle } from './adapter.js'
import { UnavailableCodexHostAdapter } from '../adapters/codex-agent.js'
import { CordisXAgentService, CordisXHostAgentRuntime, CordisXSystemPromptService } from './agent.js'
import { CordisXAgentEventService } from './agent-events.js'
import {
  installCordisXManager,
  type ManagerModel,
  type ManagerPluginSnapshot,
  type ManagerPluginStatus,
  type ManagerSnapshot,
  type ManagerSettingsTabSnapshot,
  type ManagerSettingsNavigationItemSnapshot,
} from './manager.js'
import { CordisXCommandService } from './commands.js'
import { CordisXI18nService } from './i18n.js'
import { CordisXPageService, CordisXRouteService } from './navigation.js'
import {
  BrowserPermissionPolicyStore,
  BrowserPermissionPrompt,
  BrowserPermissionAuthorizationPromptV2,
  CordisXPlatformService,
  PermissionBroker,
  normalizePluginManifest,
  type PlatformPermissionSnapshot,
} from './platform.js'
import { CORDISX_PLUGIN_GENERATION, CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE, CordisXSlotService } from './service.js'
import type { SurfaceContributionSnapshot } from './surfaces.js'
import {
  BrowserExtensionPointPolicyStore,
  CORDISX_EXTENSION_POINT_LOCALE_CATALOGS,
  CORDISX_MANAGER_EXTENSION_POINT_CATALOG,
  ExtensionPointDescriptorRegistry,
  ExtensionPointPolicyBroker,
  buildExtensionPointRuntimeSnapshot,
} from './extension-points.js'
import { sortManagerSettingsNavigationItems } from './manager-settings-navigation.js'
import { BindingPlatformAdapter } from './provider-binding.js'
import { BindingAgentHistoryAdapter, UnavailableAgentHistoryAdapter } from './agent-history-binding.js'
import { CordisXAgentHistoryService } from './agent-history.js'
import {
  BrowserConfigBridge,
  ConfigRendererRegistry,
  CordisXConfigRendererService,
  CordisXPluginSettingsService,
  PluginConfigurationRegistry,
  moduleConfigApplies,
  moduleConfigSchema,
  type ConfigCandidate,
  type ConfigMutationOperation,
} from './configuration.js'
import { BrowserServiceConfigBridge } from './service-config-binding.js'
import type { HostServiceConfigDescriptor, HostServiceConfigMutation, HostServiceConfigMutationResult } from '../launcher/service-config.js'
import { BindingPermissionPolicyStore } from './permission-binding.js'
import { BrowserPluginLifecycleBridge } from './plugin-lifecycle-binding.js'
import {
  CORDISX_CAPABILITY_AVAILABILITY_LOCALE_CATALOGS,
  CapabilityAvailabilityRegistry,
  externalProviderCapabilityProviders,
  hostLocalCapabilityProviders,
  platformAdapterCapabilityProvider,
} from './capability-availability.js'
import {
  CORDISX_PLUGIN_PRINCIPAL,
  PluginConsoleAspect,
  type PluginPrincipalToken,
} from './plugin-console.js'
import {
  CORDISX_GENERATION_VISIBILITY_COORDINATOR,
  GenerationVisibilityCoordinator,
  type PluginGenerationPublication,
  type PluginGenerationReadinessReceipt,
  type PluginGenerationTransitionHandle,
  type PluginGenerationView,
} from './generation-visibility.js'
import {
  CordisXChannelManagerService,
  type ChannelManagerProjectionV1,
} from './channel-manager.js'

const BLOCKED_PLUGINS_KEY = 'cordisx.manager.blockedPlugins.v1'

interface CordisXRuntimeMetadata {
  readonly version: string
  readonly providers: readonly { readonly id: string; readonly displayName: string }[]
  readonly profileId: string
  readonly permissionPolicies?: readonly CordisXPersistedPermissionPolicyRecord[]
  readonly permissionBridgeToken?: string
  readonly providerBridgeToken?: string
  readonly agentHistoryBridgeToken?: string
  readonly configBridgeToken?: string
  readonly serviceConfigBridgeToken?: string
  readonly pluginLifecycleBridgeToken?: string
  readonly pluginActivation?: CordisXPluginActivationRecordV1
  readonly initialRegistryEpoch?: number
  readonly generation?: string
  readonly channelManager?: ChannelManagerProjectionV1
}

interface PluginController {
  item: CordisXBrowserPlugin
  readonly identity: CordisXPluginIdentity
  manifest: CordisXPluginManifestV1 | CordisXPluginManifestV4
  principal: PluginPrincipalToken
  activation: number
  principalLive: boolean
  unregisterPermissions?: () => void
  unregisterExtensionPoints?: () => void
  fiber?: Fiber
  status: ManagerPluginStatus
  error?: string
  blockedReason?: string
  generationContext?: Record<PropertyKey, unknown>
  generationView?: PluginGenerationView
}

function topologicalActivationOrder(
  activation: CordisXPluginActivationRecordV1,
  included: ReadonlySet<string>,
): string[] {
  const items = new Map(activation.plugins.map(item => [item.id, item]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const output: string[] = []
  const visit = (id: string): void => {
    if (visited.has(id) || !included.has(id)) return
    if (visiting.has(id)) throw new Error('candidate dependency graph contains a cycle')
    const item = items.get(id)
    if (item === undefined) return
    visiting.add(id)
    for (const dependency of item.dependencies) visit(dependency.id)
    visiting.delete(id)
    visited.add(id)
    output.push(id)
  }
  for (const item of activation.plugins) visit(item.id)
  return output
}

function committedActivation(candidate: CordisXPluginActivationRecordV1): CordisXPluginActivationRecordV1 {
  const { transactionId: _transactionId, ...record } = candidate
  return {
    ...record,
    recordKind: 'active',
    lastGoodRevision: candidate.revision,
  }
}

interface RendererGenerationTransaction {
  readonly handle: PluginGenerationTransitionHandle
  readonly readiness?: PluginGenerationReadinessReceipt
  readonly affectedPluginIds: readonly string[]
  readonly previous: readonly PluginController[]
  readonly candidates: readonly PluginController[]
  readonly previousActivation: CordisXPluginActivationRecordV1
  readonly candidateActivation: CordisXPluginActivationRecordV1
  publication?: PluginGenerationPublication
  failedStage?: boolean
  disposedAfter: string[]
}

export interface RendererPluginMutation {
  readonly transactionId: string
  readonly transactionEpoch?: string
  readonly expectedRegistryEpoch?: number
  readonly afterRegistryEpoch?: number
  readonly operation: 'install' | 'update' | 'enable' | 'disable' | 'uninstall'
  readonly previous: CordisXPluginActivationRecordV1
  readonly candidate: CordisXPluginActivationRecordV1
  readonly targetId: string
  readonly affectedPluginIds: readonly string[]
  readonly package?: {
    readonly manifest: CordisXPluginPackageManifestV1
    readonly digest: `sha256:${string}`
    readonly identitySource: string
    readonly readme?: string
  }
  readonly authorizationDecision?: CordisXPermissionAuthorizationDecisionV1 | CordisXPermissionAuthorizationDecisionV2
}

interface CordisXRuntimeHandle extends ManagerModel {
  readonly version: string
  readonly pluginIds: readonly string[]
  execute(owner: string, reference: CordisXCommandReference, invocationKey?: string): Promise<unknown>
  navigate(owner: string, reference: CordisXRouteReference): Promise<void>
  setExtensionPointPolicy(source: string, pluginId: string, pointId: string, policy: CordisXPointPolicy): Promise<void>
  permissionAuthorizationPlan(id: string): CordisXPermissionAuthorizationPlanV1
  authorizePlugin(id: string, decision: CordisXPermissionAuthorizationDecisionV1): Promise<void>
  permissionAuthorizationPlanV2(id: string): CordisXPermissionAuthorizationPlanV2 | undefined
  authorizePluginV2(id: string, decision: CordisXPermissionAuthorizationDecisionV2): Promise<void>
  /** Host-private readback of the registry authority; never used as renderer lifecycle input. */
  activePluginGeneration(): CordisXPluginActivationRecordV1
  /** Host-private bounded evidence for cross-registry batch notification assertions. */
  generationNotificationTrace(): readonly {
    readonly source: string
    readonly registryEpoch: number
    readonly suppressed: boolean
  }[]
  /** Host-private barrier used before opening a generation transaction. */
  settleRegistryProjection(): Promise<void>
  recoverPluginMutation(input: RendererGenerationCleanupObservation): Promise<RendererGenerationCleanupObservation>
  adoptRecoveredActivation(active: CordisXPluginActivationRecordV1, registryEpoch: number): Promise<void>
  stagePluginMutation(
    mutation: RendererPluginMutation,
    module?: CordisXPluginModule,
    moduleFactory?: (console: CordisXPluginConsoleFacade) => CordisXPluginModule,
  ): Promise<PluginGenerationReadinessReceipt>
  publishPluginMutation(transactionId: string): Promise<PluginGenerationPublication>
  completePluginMutation(transactionId: string): Promise<RendererGenerationCleanupObservation>
  finalizePluginMutation(transactionId: string): Promise<void>
  rollbackPluginMutation(transactionId: string): Promise<RendererGenerationCleanupObservation>
  commitPluginMutation(transactionId: string): Promise<void>
  abortPluginMutation(transactionId: string): Promise<void>
  reloadPluginGeneration(pluginId: string, moduleGeneration: string, runtimeGeneration: string): Promise<void>
  dispose(): Promise<void>
}

export interface RendererGenerationCleanupObservation {
  readonly transactionId: string
  readonly transactionEpoch: string
  readonly registryEpoch: number
  readonly active: CordisXPluginActivationRecordV1
  readonly disposedAfter: CordisXPluginActivationRecordV1
}

declare global {
  // eslint-disable-next-line no-var
  var __cordisxRuntime: CordisXRuntimeHandle | undefined
  // eslint-disable-next-line no-var
  var __cordisxBoot: Promise<CordisXRuntimeHandle> | undefined
  // eslint-disable-next-line no-var
  var __cordisxPendingPluginModuleV1: CordisXPluginModule | undefined
  // eslint-disable-next-line no-var
  var __cordisxPendingPluginModuleFactoryV1: ((console: CordisXPluginConsoleFacade) => CordisXPluginModule) | undefined
}

function pluginFromModule(module: CordisXPluginModule): Plugin {
  if (typeof module.apply === 'function') return module as Plugin.Object
  const fallback = module.default
  if (typeof fallback === 'function') return fallback as Plugin
  if (fallback !== null && typeof fallback === 'object' && typeof (fallback as { apply?: unknown }).apply === 'function') {
    return fallback as Plugin.Object
  }
  throw new Error('CordisX plugin module must export apply() or a default Cordis plugin')
}

function pluginInject(module: CordisXPluginModule | undefined): readonly string[] {
  if (module === undefined || module.inject === undefined) return []
  if (Array.isArray(module.inject)) return module.inject.filter((value): value is string => typeof value === 'string')
  return Object.keys(module.inject)
}

function pluginReadmeSummary(readme: string | undefined): string | undefined {
  if (readme === undefined) return undefined
  const paragraphs = readme.replace(/\r\n?/g, '\n').split(/\n\s*\n/)
  for (const paragraph of paragraphs) {
    const lines = paragraph.split('\n').map(line => line.trim()).filter(Boolean)
    if (lines.length === 0
      || lines.every(line => line.startsWith('#') || line.startsWith('![') || line.startsWith('<') || line.startsWith('```'))
      || lines[0]?.startsWith('---') === true) continue
    const text = lines.join(' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[`*_~>#]/g, '')
      .replace(/^[-+]\s+/, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (text.length > 0) return text.length > 220 ? `${text.slice(0, 217).trimEnd()}…` : text
  }
  return undefined
}

function pluginDescriptionFields(readme: string | undefined): { readonly description?: string } {
  const description = pluginReadmeSummary(readme)
  return description === undefined ? {} : { description }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function createController(item: CordisXBrowserPlugin, pluginConsole: PluginConsoleAspect): PluginController {
  const identity = Object.freeze({ source: item.source, id: item.id })
  const activation = 1
  const pluginGeneration = item.package?.moduleGeneration ?? `${pluginConsole.generation}:${item.id}:bundled`
  const principal = pluginConsole.issue(identity, pluginGeneration)
  try {
    const module = item.moduleFactory?.(pluginConsole.consoleFacade(principal)) ?? item.module
    const boundItem: CordisXBrowserPlugin = module === undefined || module === item.module ? item : { ...item, module }
    return {
      item: boundItem,
      identity,
      principal,
      activation,
      principalLive: true,
      manifest: normalizePluginManifest(item.manifest ?? module?.manifest, item.id),
      status: !item.enabled || module === undefined ? 'configured-disabled' : 'active',
    }
  } catch (error) {
    return {
      item,
      identity,
      principal,
      activation,
      principalLive: true,
      manifest: normalizePluginManifest(undefined, item.id),
      status: 'failed',
      error: errorMessage(error),
    }
  }
}

function readBlockedPlugins(): Set<string> {
  try {
    const value = localStorage.getItem(BLOCKED_PLUGINS_KEY)
    if (value === null) return new Set()
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((item): item is string => typeof item === 'string'))
  } catch {
    return new Set()
  }
}

function writeBlockedPlugins(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(BLOCKED_PLUGINS_KEY, JSON.stringify([...ids].sort()))
  } catch {
    // Storage may be unavailable in hardened profiles; runtime blocking still works.
  }
}

async function start(
  plugins: readonly CordisXBrowserPlugin[],
  metadata: CordisXRuntimeMetadata,
): Promise<CordisXRuntimeHandle> {
  await globalThis.__cordisxRuntime?.dispose()

  let ctx = new Context()
  const blockedPlugins = readBlockedPlugins()
  const agentAdapter = new UnavailableCodexHostAdapter()
  let bindingPlatformAdapter: BindingPlatformAdapter | undefined
  if (metadata.providers.length > 0 && metadata.providerBridgeToken !== undefined) {
    bindingPlatformAdapter = await BindingPlatformAdapter.connect(metadata.providerBridgeToken).catch(() => undefined)
  }
  const platformAdapter = bindingPlatformAdapter ?? agentAdapter
  const generation = metadata.generation ?? (typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `generation-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const permissionStore = metadata.permissionBridgeToken === undefined
    ? new BrowserPermissionPolicyStore(metadata.profileId)
    : BindingPermissionPolicyStore.connect(metadata.permissionBridgeToken, metadata.permissionPolicies ?? [])
  const configBridge = metadata.configBridgeToken === undefined
    ? undefined
    : new BrowserConfigBridge(metadata.configBridgeToken, metadata.profileId, generation)
  const serviceConfigBridge = metadata.serviceConfigBridgeToken === undefined
    ? undefined
    : BrowserServiceConfigBridge.connect(metadata.serviceConfigBridgeToken, metadata.profileId, generation)
  const lifecycleBridge = metadata.pluginLifecycleBridgeToken === undefined
    ? undefined
    : new BrowserPluginLifecycleBridge(metadata.pluginLifecycleBridgeToken, metadata.profileId, generation)
  let currentActivation: CordisXPluginActivationRecordV1 = metadata.pluginActivation ?? {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: 'active',
    profileId: metadata.profileId,
    revision: 0,
    lastGoodRevision: 0,
    runtimeGeneration: generation,
    plugins: [],
  }
  if (currentActivation.profileId !== metadata.profileId || currentActivation.runtimeGeneration !== generation) {
    throw new Error('plugin activation metadata does not match the renderer scope')
  }
  const generationVisibility = new GenerationVisibilityCoordinator(currentActivation, metadata.initialRegistryEpoch)
  const pluginConsole = new PluginConsoleAspect(generation, 2000, () => Date.now(), generationVisibility)
  let pluginErrorOwners = (): readonly {
    readonly identity: CordisXPluginIdentity
    readonly principal: PluginPrincipalToken
    readonly source: string
  }[] => []
  const recordUnknownError = (event: Event): void => {
    const candidate = event as Event & { readonly filename?: unknown; readonly error?: unknown; readonly reason?: unknown }
    const error = candidate.error ?? candidate.reason
    let evidence = typeof candidate.filename === 'string' ? candidate.filename : ''
    try {
      if (error instanceof Error && typeof error.stack === 'string') evidence += `\n${error.stack}`
      else if (error !== undefined) evidence += `\n${String(error)}`
    } catch { /* hostile rejection values do not affect the runtime */ }
    const matches = pluginErrorOwners().filter(owner => owner.source !== '' && evidence.includes(owner.source))
    if (matches.length === 1) {
      pluginConsole.recordBestEffortError(matches[0]!.principal, `window.${event.type}`, error)
    } else if (matches.length > 1) {
      pluginConsole.recordUnattributedError(`${event.type}:${matches.map(owner => owner.identity.id).sort().join(',')}`)
    }
  }
  window.addEventListener('error', recordUnknownError)
  window.addEventListener('unhandledrejection', recordUnknownError)
  let consoleAffectedPluginIds: readonly string[] = []
  const disconnectPluginConsoleVisibility = generationVisibility.connect({
    prepare: transition => { consoleAffectedPluginIds = transition.affectedPluginIds },
    notify: () => pluginConsole.visibilityChanged(consoleAffectedPluginIds),
  })
  const broker = new PermissionBroker(
    permissionStore,
    new BrowserPermissionPrompt(),
    () => new Date(),
    30_000,
    metadata.profileId,
    generation,
    generationVisibility,
    pluginConsole,
    new BrowserPermissionAuthorizationPromptV2(document),
  )
  for (const plugin of plugins) {
    if (plugin.package === undefined) generationVisibility.bindStable(plugin.id, `${generation}:${plugin.id}:bundled`)
  }
  ctx = ctx.extend({ [CORDISX_GENERATION_VISIBILITY_COORDINATOR]: generationVisibility })
  const configuration = new PluginConfigurationRegistry(generationVisibility)
  const configRenderers = new ConfigRendererRegistry(generationVisibility)
  const agentRuntime = new CordisXHostAgentRuntime({ adapter: agentAdapter, broker, generation })
  const historyAdapter = metadata.agentHistoryBridgeToken === undefined
    ? new UnavailableAgentHistoryAdapter()
    : await BindingAgentHistoryAdapter.connect(metadata.agentHistoryBridgeToken).catch(() => new UnavailableAgentHistoryAdapter())
  const boundProviderStatuses = bindingPlatformAdapter?.capabilityProviderStatuses() ?? []
  const externalProviderStatuses = boundProviderStatuses.length > 0
    ? boundProviderStatuses
    : metadata.providers.map(provider => ({
      providerId: provider.id,
      displayName: provider.displayName,
      state: 'unavailable' as const,
    }))
  const capabilityAvailability = new CapabilityAvailabilityRegistry([
    platformAdapterCapabilityProvider(agentAdapter.status(), {
      providerId: 'desktop-current-connection',
      kind: 'current-connection',
    }),
    ...externalProviderCapabilityProviders(externalProviderStatuses),
    ...hostLocalCapabilityProviders({
      agentStatus: agentRuntime.status(),
      historyStatus: historyAdapter.status(),
      configurationWritable: configBridge !== undefined,
      packageLifecycleAvailable: lifecycleBridge !== undefined,
    }),
  ])
  const extensionPointDescriptors = new ExtensionPointDescriptorRegistry(CORDISX_EXTENSION_POINT_LOCALE_CATALOGS)
  const extensionPointBroker = new ExtensionPointPolicyBroker(
    extensionPointDescriptors,
    new BrowserExtensionPointPolicyStore(),
    generation,
    generationVisibility,
  )
  const controllers: PluginController[] = plugins.map(item => createController(item, pluginConsole))
  const moduleGenerationOf = (controller: PluginController): string => (
    controller.item.package?.moduleGeneration ?? `${generation}:${controller.item.id}:bundled`
  )
  const projectedControllers = (): PluginController[] => controllers.filter(controller => (
    generationVisibility.projected({
      pluginId: controller.item.id,
      moduleGeneration: moduleGenerationOf(controller),
    })
  ))
  const activeControllers = (): PluginController[] => projectedControllers().filter(controller => generationVisibility.visible({
    pluginId: controller.item.id,
    moduleGeneration: moduleGenerationOf(controller),
  }))
  const activeController = (id: string, source?: string): PluginController | undefined => projectedControllers().find(controller => (
    controller.item.id === id && (source === undefined || controller.item.source === source)
  ))
  pluginErrorOwners = () => activeControllers().map(controller => ({
    identity: controller.identity,
    principal: controller.principal,
    source: controller.item.source,
  }))
  const requiredBlockReason = (controller: PluginController): string | undefined => {
    const denied = broker.requiredDenied(controller.identity, controller.generationView)
    if (denied.length > 0) return `Required capability denied: ${denied.join(', ')}`
    const declarations = controller.manifest.capabilities.flatMap(item => (
      (CORDISX_PLATFORM_CAPABILITIES as readonly string[]).includes(item.name)
        ? [{
            name: item.name as CordisXPlatformCapability,
            required: item.required,
            scope: item.scope as CordisXCapabilityScope,
          }]
        : []
    ))
    const unavailable = capabilityAvailability.unavailableRequired(declarations)
    if (unavailable.length > 0) return `Required capability unavailable: ${unavailable.join(', ')}`
    return undefined
  }
  const registerController = (controller: PluginController, registerAuthority = true): void => {
    if (registerAuthority) {
      controller.unregisterPermissions = broker.register(controller.identity, controller.manifest, {
        pluginId: controller.item.id,
        moduleGeneration: moduleGenerationOf(controller),
        ...(controller.generationView?.transactionId === undefined ? {} : {
          transactionId: controller.generationView.transactionId,
          transactionEpoch: controller.generationView.transactionEpoch,
        }),
      }, controller.generationView)
      controller.unregisterExtensionPoints = extensionPointBroker.register(controller.identity, {
        pluginId: controller.item.id,
        moduleGeneration: moduleGenerationOf(controller),
        ...(controller.generationView?.transactionId === undefined ? {} : {
          transactionId: controller.generationView.transactionId,
          transactionEpoch: controller.generationView.transactionEpoch,
        }),
      }, controller.generationView)
    }
    const configSchema = moduleConfigSchema(controller.item.module)
    const configApplies = moduleConfigApplies(controller.item.module)
    configuration.register({
      identity: controller.identity,
      moduleGeneration: moduleGenerationOf(controller),
      ...(controller.generationView === undefined ? {} : { candidateView: controller.generationView }),
      ...(configSchema === undefined ? {} : { schema: configSchema }),
      applies: configApplies,
      raw: controller.item.config,
      revision: controller.item.revision,
      writable: configBridge !== undefined
        && controller.item.enabled
        && controller.item.module !== undefined
        && configApplies !== 'service-restart',
    })
  }
  const unregisterController = (controller: PluginController): void => {
    const index = controllers.indexOf(controller)
    if (index >= 0) controllers.splice(index, 1)
    controller.unregisterPermissions?.()
    delete controller.unregisterPermissions
    controller.unregisterExtensionPoints?.()
    delete controller.unregisterExtensionPoints
    configuration.unregister(
      controller.item.id,
      moduleGenerationOf(controller),
    )
  }
  for (const controller of controllers) {
    registerController(controller)
    if (controller.status === 'active' && blockedPlugins.has(controller.item.id)) controller.status = 'blocked'
  }
  await broker.settled()
  for (const controller of controllers) {
    const blockedReason = requiredBlockReason(controller)
    if (controller.status === 'active' && blockedReason !== undefined) {
      controller.status = 'permission-blocked'
      controller.blockedReason = blockedReason
    }
  }
  const listeners = new Set<() => void>()
  const knownRegistrations = new Map<string, readonly SurfaceContributionSnapshot[]>()
  let slotService: CordisXSlotService | undefined
  let commandService: CordisXCommandService | undefined
  let pageService: CordisXPageService | undefined
  let routeService: CordisXRouteService | undefined
  let i18nService: CordisXI18nService | undefined
  let i18nFiber: Fiber | undefined
  let platformFiber: Fiber | undefined
  let agentEventFiber: Fiber | undefined
  let agentHistoryFiber: Fiber | undefined
  let agentFiber: Fiber | undefined
  let systemPromptFiber: Fiber | undefined
  let commandFiber: Fiber | undefined
  let pageFiber: Fiber | undefined
  let routeFiber: Fiber | undefined
  let slotFiber: Fiber | undefined
  let settingsFiber: Fiber | undefined
  let configRendererFiber: Fiber | undefined
  let channelManagerFiber: Fiber | undefined
  let disposeManager: (() => void) | undefined
  let undeclareManagerOutlet: (() => void) | undefined
  let undeclareManagerContentOutlet: (() => void) | undefined
  let unregisterManagerPointCatalog: (() => void) | undefined
  let adapterHandle: CodexAdapterHandle | undefined
  let disposeI18nSubscription: (() => void) | undefined
  let disposePermissionSubscription: (() => void) | undefined
  let disposeExtensionPointSubscription: (() => void) | undefined
  const disposeExtensionPointCatalogs: (() => void | Promise<void>)[] = []
  const registrySubscriptions: (() => void)[] = []
  const generationTransactions = new Map<string, RendererGenerationTransaction>()
  let operation: Promise<unknown> = Promise.resolve()
  let disposed = false
  let notificationsSuppressed = false
  const generationNotificationTrace: { source: string; registryEpoch: number; suppressed: boolean }[] = []
  let settingsProjectionSites = new Set<string>()
  let settingsNavigationProjectionSites = new Map<string, string>()
  let extensionContributionProjectionSites = new Map<string, string>()

  const traceNotification = (source: string, suppressed: boolean): void => {
    generationNotificationTrace.push({ source, registryEpoch: generationVisibility.registryEpoch(), suppressed })
    if (generationNotificationTrace.length > 256) generationNotificationTrace.shift()
  }
  const emitListeners = (): void => {
    for (const listener of listeners) listener()
  }
  const notifyBatch = (): void => {
    traceNotification('generation-batch', false)
    emitListeners()
  }
  const notify = (source = 'runtime'): void => {
    traceNotification(source, notificationsSuppressed)
    if (notificationsSuppressed) return
    emitListeners()
  }
  const notifyFrom = (source: string): (() => void) => () => notify(source)
  const drainSuppressedNotifications = async (): Promise<void> => {
    await Promise.resolve()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    await Promise.resolve()
  }
  const drainBatchSubscriberMicrotasks = async (): Promise<void> => {
    let observed = generationNotificationTrace.length
    let stableTurns = 0
    for (let turn = 0; turn < 32; turn += 1) {
      await Promise.resolve()
      if (generationNotificationTrace.length === observed) {
        stableTurns += 1
        if (stableTurns === 2) return
      } else {
        observed = generationNotificationTrace.length
        stableTurns = 0
      }
    }
    throw new Error('generation batch subscribers did not reach a microtask fixed point')
  }

  const settleRegistryProjection = (): Promise<void> => {
    const task = operation.then(async () => {
      if (disposed) throw new Error('CordisX runtime is disposed')
      await drainBatchSubscriberMicrotasks()
    })
    operation = task.catch(() => {})
    return task
  }

  const rememberRegistrations = (pluginId: string): void => {
    const controller = activeController(pluginId)
    if (controller === undefined) return
    const registrations = slotService?.snapshot().filter(item => item.owner === pluginId) ?? []
    if (registrations.length > 0) knownRegistrations.set(
      `${pluginId}\u0000${moduleGenerationOf(controller)}`,
      registrations,
    )
  }

  const disposeControllerFiber = async (controller: PluginController, reason: 'owner-disposed' | 'generation-replaced'): Promise<void> => {
    rememberRegistrations(controller.item.id)
    agentRuntime.releaseOwner(controller.identity, reason, moduleGenerationOf(controller))
    let failure: unknown
    try {
      await controller.fiber?.dispose()
    } catch (error) {
      failure = error
    }
    try {
      await routeService?.settled()
    } catch (error) {
      failure ??= error
    } finally {
      retirePrincipal(controller, `Plugin disposed: ${reason}`)
      delete controller.fiber
    }
    if (failure !== undefined) throw failure
  }

  const renewPrincipal = (controller: PluginController): void => {
    if (controller.principalLive) return
    controller.activation += 1
    controller.principal = pluginConsole.issue(
      controller.identity,
      moduleGenerationOf(controller),
    )
    controller.principalLive = true
    const module = controller.item.moduleFactory?.(pluginConsole.consoleFacade(controller.principal)) ?? controller.item.module
    controller.item = module === undefined || module === controller.item.module ? controller.item : { ...controller.item, module }
    controller.manifest = normalizePluginManifest(controller.item.manifest ?? module?.manifest, controller.item.id)
  }

  const retirePrincipal = (controller: PluginController, message: string): void => {
    if (!controller.principalLive) return
    pluginConsole.deactivate(controller.principal, message)
    controller.principalLive = false
  }

  const mountPlugin = async (controller: PluginController): Promise<void> => {
    renewPrincipal(controller)
    const module = controller.item.module
    if (module === undefined) throw new Error(`plugin ${controller.item.id} is not bundled because it is disabled in configuration`)
    const blockedReason = requiredBlockReason(controller)
    if (blockedReason !== undefined) {
      controller.status = 'permission-blocked'
      controller.blockedReason = blockedReason
      return
    }
    const pluginContext = ctx.extend({
      [CORDISX_PLUGIN_ID]: controller.item.id,
      [CORDISX_PLUGIN_SOURCE]: controller.item.source,
      [CORDISX_PLUGIN_GENERATION]: moduleGenerationOf(controller),
      [CORDISX_PLUGIN_PRINCIPAL]: controller.principal,
      ...(controller.generationContext ?? {}),
    })
    pluginConsole.lifecycle(controller.principal, controller.activation === 1 ? 'activate' : 'reload', 'Plugin activation started')
    const fiber = pluginContext.plugin(
      pluginFromModule(module),
      configuration.get(controller.item.id, generationVisibility.view(pluginContext)),
    )
    controller.fiber = fiber
    try {
      await fiber
      controller.status = 'active'
      pluginConsole.lifecycle(controller.principal, controller.activation === 1 ? 'activate' : 'reload', 'Plugin activation completed')
      delete controller.error
      delete controller.blockedReason
      rememberRegistrations(controller.item.id)
    } catch (error) {
      controller.status = 'failed'
      controller.error = errorMessage(error)
      pluginConsole.diagnostic(controller.principal, 'plugin.activation', 'Plugin activation failed', error)
      await fiber.dispose()
      delete controller.fiber
      retirePrincipal(controller, 'Plugin disposed after activation failure')
      throw error
    }
  }

  const snapshot = (): ManagerSnapshot => {
    const liveRegistrations = slotService?.snapshot() ?? []
    const livePluginIds = new Set(liveRegistrations.map(item => item.owner))
    const activeRegistrationKeys = new Set(activeControllers().map(controller => (
      `${controller.item.id}\u0000${moduleGenerationOf(controller)}`
    )))
    const inactiveRegistrations = [...knownRegistrations]
      .filter(([key, registrations]) => activeRegistrationKeys.has(key)
        && registrations.every(item => !livePluginIds.has(item.owner)))
      .flatMap(([, registrations]) => registrations.map(item => ({
        ...item,
        visible: false,
        rendered: false,
        error: item.error ?? 'owning plugin is inactive',
      })))
    const allRegistrations = [...liveRegistrations, ...inactiveRegistrations]
    const nextContributionSites = new Map<string, string>()
    for (const registration of allRegistrations) {
      nextContributionSites.set(`extension-point:contribution:${registration.qualifiedId}:title`, registration.owner)
      nextContributionSites.set(`extension-point:contribution:${registration.qualifiedId}:description`, registration.owner)
    }
    for (const [site, owner] of extensionContributionProjectionSites) {
      if (!nextContributionSites.has(site)) i18nService?.clearDiagnosticSite(owner, site)
    }
    extensionContributionProjectionSites = nextContributionSites
    const navigation = routeService?.snapshot() ?? { routes: [], pages: [], outlets: [] }
    const nextSettingsSites = new Set<string>()
    const externalSettingsTabs = liveRegistrations
      .filter(item => item.surface === 'manager.settings.tabs' && item.valid && item.visible && item.authorized && !item.pending)
      .map((registration): ManagerSettingsTabSnapshot => {
        const item = registration.item as CordisXManagerSettingsTabItem
        const titleSite = `manager-settings:${registration.qualifiedId}:title`
        nextSettingsSites.add(titleSite)
        const disabledSite = `manager-settings:${registration.qualifiedId}:disabled`
        if (registration.disabledReason !== undefined) nextSettingsSites.add(disabledSite)
        return {
          id: registration.qualifiedId,
          owner: registration.owner,
          title: i18nService?.resolveFor(registration.owner, item.title, titleSite).text ?? item.title.fallback ?? item.title.key,
          icon: item.icon,
          order: registration.order,
          disabled: registration.disabled,
          ...(registration.disabledReason === undefined ? {} : {
            disabledReason: i18nService?.resolveFor(registration.owner, registration.disabledReason, disabledSite).text
              ?? registration.disabledReason.fallback
              ?? registration.disabledReason.key,
          }),
          builtin: false,
          route: item.route,
        }
      })
    for (const site of settingsProjectionSites) {
      if (!nextSettingsSites.has(site)) {
        const owner = site.split(':')[1]
        if (owner !== undefined) i18nService?.clearDiagnosticSite(owner, site)
      }
    }
    settingsProjectionSites = nextSettingsSites
    // Keep resolving compatibility descriptors for diagnostic/localization cleanup;
    // they deliberately have no live Manager projection.
    void externalSettingsTabs
    // A is a retained protocol/catalog contract, not a current Manager product
    // surface. Do not project a hidden Settings page or a clickable empty tab.
    const settingsTabs: readonly ManagerSettingsTabSnapshot[] = Object.freeze([])
    const nextSettingsNavigationSites = new Map<string, string>()
    const settingsNavigationItems = sortManagerSettingsNavigationItems(
      liveRegistrations
        .filter(item => item.surface === 'manager.settings.navigation-items'
          && item.valid && item.visible && item.authorized && !item.pending
          && (item.group === 'before-settings' || item.group === 'after-settings'))
        .flatMap((registration): readonly ManagerSettingsNavigationItemSnapshot[] => {
          const item = registration.item as CordisXManagerSettingsNavigationItem
          const route = navigation.routes.find(candidate => candidate.owner === registration.owner
            && candidate.qualifiedId === `${registration.owner}:${item.route.id}`
            && candidate.valid && candidate.authorized
            && candidate.productMetadata.title !== undefined && candidate.productMetadata.description !== undefined)
          if (route === undefined) return []
          const page = navigation.pages.find(candidate => candidate.owner === registration.owner
            && candidate.qualifiedId === `${registration.owner}:${route.definition.page}`
            && candidate.metadata.icon !== undefined
            && candidate.productMetadata.title !== undefined && candidate.productMetadata.description !== undefined)
          if (page === undefined) return []
          const title = route.productMetadata.title
          const description = route.productMetadata.description
          const pageTitle = page.productMetadata.title
          const pageDescription = page.productMetadata.description
          if (title === undefined || description === undefined || pageTitle === undefined || pageDescription === undefined) return []
          const disabledSite = `manager-settings-navigation:${registration.qualifiedId}:disabled`
          if (registration.disabledReason !== undefined) nextSettingsNavigationSites.set(disabledSite, registration.owner)
          return [Object.freeze({
            id: registration.qualifiedId,
            owner: registration.owner,
            group: registration.group as 'before-settings' | 'after-settings',
            order: registration.order,
            title,
            description,
            pageTitle,
            pageDescription,
            icon: page.metadata.icon!,
            disabled: registration.disabled,
            ...(registration.disabledReason === undefined ? {} : {
              disabledReason: i18nService?.resolveFor(
                registration.owner,
                registration.disabledReason,
                disabledSite,
              ).text ?? registration.disabledReason.fallback ?? registration.disabledReason.key,
            }),
            route: item.route,
          })]
        }),
    )
    for (const [site, owner] of settingsNavigationProjectionSites) {
      if (!nextSettingsNavigationSites.has(site)) i18nService?.clearDiagnosticSite(owner, site)
    }
    settingsNavigationProjectionSites = nextSettingsNavigationSites
    const hostText = (value: CordisXLocalizedText, site: string): string => (
      i18nService?.resolveFor('host', value, site).text
      ?? value.fallback
      ?? `[[host:${value.key}]]`
    )
    return {
      version: metadata.version,
      plugins: projectedControllers().map((controller): ManagerPluginSnapshot => ({
        id: controller.item.id,
        source: controller.item.source,
        name: controller.manifest.name ?? controller.item.module?.name ?? controller.item.id,
        ...pluginDescriptionFields(controller.item.readme),
        inject: pluginInject(controller.item.module),
        config: configuration.descriptor(controller.item.id, i18nService?.getSnapshot().locale ?? 'en').value,
        configuration: configuration.descriptor(controller.item.id, i18nService?.getSnapshot().locale ?? 'en'),
        ...(controller.item.readme === undefined ? {} : { readme: controller.item.readme }),
        ...(controller.item.package === undefined ? {} : {
          package: {
            version: controller.item.package.version,
            digest: controller.item.package.digest,
            moduleGeneration: controller.item.package.moduleGeneration,
            dependencies: controller.item.package.dependencies.map(item => item.id),
            ...(controller.item.package.canonicalSource === undefined ? {} : { canonicalSource: controller.item.package.canonicalSource }),
          },
        }),
        status: controller.status,
        ...(controller.error === undefined ? {} : { error: controller.error }),
        ...(controller.blockedReason === undefined ? {} : { blockedReason: controller.blockedReason }),
      })),
      registrations: allRegistrations,
      commands: commandService?.snapshot() ?? [],
      navigation,
      settingsTabs,
      settingsNavigationItems,
      localization: i18nService?.getSnapshot() ?? { locale: 'en', direction: 'ltr', version: 0 },
      localeCatalogs: i18nService?.catalogs() ?? [],
      localizationDiagnostics: i18nService?.diagnostics() ?? [],
      platform: platformAdapter.status(),
      capabilityProviders: capabilityAvailability.providerSnapshot().map(provider => ({
        providerId: provider.providerId,
        providerNameText: hostText(provider.providerName, `capability-provider:${provider.providerId}:name`),
        kind: provider.kind,
        family: provider.family,
        status: provider.status,
        reasonText: hostText(provider.reason, `capability-provider:${provider.providerId}:reason`),
        ...(provider.generation === undefined ? {} : { generation: provider.generation }),
      })),
      pluginLifecycle: {
        profileId: metadata.profileId,
        revision: currentActivation.revision,
        runtimeGeneration: generation,
        operationsAvailable: lifecycleBridge !== undefined,
      },
      permissions: broker.snapshots().map((permission: PlatformPermissionSnapshot) => {
        const availability = capabilityAvailability.resolve(permission.capability, permission.scope)
        const site = `permission:${permission.identity.source}:${permission.identity.id}:${permission.capability}`
        return {
          identity: permission.identity,
          capability: permission.capability,
          required: permission.required,
          reason: permission.reason,
          reasonText: i18nService?.resolveFor(permission.identity.id, permission.reason, site).text
            ?? permission.reason.fallback
            ?? `[[${permission.identity.id}:${permission.reason.key}]]`,
          scope: permission.scope,
          policy: permission.policy,
          ...(permission.lastRequested === undefined ? {} : { lastRequested: permission.lastRequested }),
          ...(permission.lastUsedAt === undefined ? {} : { lastUsedAt: permission.lastUsedAt }),
          ...(permission.lastDeniedAt === undefined ? {} : { lastDeniedAt: permission.lastDeniedAt }),
          denialCount: permission.denialCount,
          ...(permission.blockedReason === undefined ? {} : { blockedReason: permission.blockedReason }),
          availability: {
            status: availability.status,
            reasonText: hostText(availability.reason, `${site}:availability`),
            providers: availability.providers.map(provider => ({
              providerId: provider.providerId,
              providerNameText: hostText(provider.providerName, `${site}:provider:${provider.providerId}:name`),
              kind: provider.kind,
              family: provider.family,
              status: provider.status,
              reasonText: hostText(provider.reason, `${site}:provider:${provider.providerId}:reason`),
              ...(provider.generation === undefined ? {} : { generation: provider.generation }),
              scope: provider.scope,
            })),
          },
        }
      }),
      extensionPoints: buildExtensionPointRuntimeSnapshot({
        descriptors: extensionPointDescriptors,
        broker: extensionPointBroker,
        i18n: i18nService!,
        plugins: activeControllers().map(controller => ({
          id: controller.item.id,
          source: controller.item.source,
          name: controller.manifest.name ?? controller.item.module?.name ?? controller.item.id,
          ...pluginDescriptionFields(controller.item.readme),
          status: controller.status,
        })),
        registrations: allRegistrations,
        commands: commandService?.snapshot() ?? [],
        navigation,
        surfaceAvailability: slotService?.registry.availabilitySnapshot() ?? [],
      }),
    }
  }

  const setPluginBlocked = (id: string, blocked: boolean): Promise<void> => {
    const task = operation.then(async () => {
      if (disposed) throw new Error('CordisX runtime is disposed')
      const controller = activeController(id)
      if (controller === undefined) throw new Error(`unknown CordisX plugin: ${id}`)
      if (!controller.item.enabled || controller.item.module === undefined) {
        throw new Error(`plugin ${id} is disabled in cordisx.config.json and is not bundled`)
      }

      if (blocked) {
        blockedPlugins.add(id)
        writeBlockedPlugins(blockedPlugins)
        broker.clearOnce(controller.identity)
        rememberRegistrations(id)
        agentRuntime.releaseOwner(controller.identity, 'plugin-blocked', moduleGenerationOf(controller))
        await controller.fiber?.dispose()
        await routeService?.settled()
        retirePrincipal(controller, 'Plugin blocked')
        delete controller.fiber
        controller.status = 'blocked'
        delete controller.error
        notify()
        return
      }

      if (controller.status === 'active') return
      blockedPlugins.delete(id)
      writeBlockedPlugins(blockedPlugins)
      const blockedReason = requiredBlockReason(controller)
      if (blockedReason !== undefined) {
        controller.status = 'permission-blocked'
        controller.blockedReason = blockedReason
        notify()
        return
      }
      try {
        await mountPlugin(controller)
      } catch (error) {
        blockedPlugins.add(id)
        writeBlockedPlugins(blockedPlugins)
        notify()
        throw error
      }
      notify()
    })
    operation = task.catch(() => {})
    return task
  }

  const remountLastGood = async (controller: PluginController): Promise<void> => {
    configuration.abort(controller.item.id)
    await controller.fiber?.dispose()
    retirePrincipal(controller, 'Plugin disposed for configuration rollback')
    delete controller.fiber
    await mountPlugin(controller)
  }

  const applyRestartCandidate = async (controller: PluginController, candidate: ConfigCandidate): Promise<void> => {
    rememberRegistrations(controller.item.id)
    agentRuntime.releaseOwner(controller.identity, 'owner-disposed', moduleGenerationOf(controller))
    await controller.fiber?.dispose()
    await routeService?.settled()
    retirePrincipal(controller, 'Plugin disposed for configuration restart')
    delete controller.fiber
    configuration.begin(controller.item.id, candidate)
    await mountPlugin(controller)
  }

  const updatePluginConfig = (
    id: string,
    expectedRevision: number,
    operations: readonly ConfigMutationOperation[],
  ): Promise<void> => {
    const task = operation.then(async () => {
      if (disposed) throw new Error('CordisX runtime is disposed')
      const controller = activeController(id)
      if (controller === undefined) throw new Error(`unknown CordisX plugin: ${id}`)
      if (configBridge === undefined) throw new Error('plugin configuration writer is unavailable in this launcher mode')
      const descriptor = configuration.descriptor(id, i18nService?.getSnapshot().locale ?? 'en')
      if (descriptor.applies === 'service-restart') {
        throw new Error('service-restart configuration requires an owning launcher service restart handler')
      }
      const candidate = configuration.stage(id, expectedRevision, operations)
      const staged = await configBridge.stage(controller.identity, expectedRevision, candidate.raw)
      let candidateMounted = false
      try {
        const mayMount = controller.item.enabled
          && controller.item.module !== undefined
          && !blockedPlugins.has(id)
          && requiredBlockReason(controller) === undefined
        if (descriptor.applies === 'plugin-restart' && mayMount) {
          try {
            await applyRestartCandidate(controller, candidate)
            candidateMounted = true
          } catch (restartError) {
            configuration.abort(id)
            await configBridge.abort(controller.identity, staged.candidateRevision).catch(() => undefined)
            try {
              await remountLastGood(controller)
            } catch (rollbackError) {
              controller.status = 'failed'
              controller.error = `rollback-failed: ${errorMessage(rollbackError)}`
              notify()
              throw new Error(`plugin restart failed (${errorMessage(restartError)}); last-good rollback failed (${errorMessage(rollbackError)})`)
            }
            throw new Error(`plugin restart failed; last-good restored: ${errorMessage(restartError)}`)
          }
        }
        const committed = await configBridge.commit(controller.identity, staged.candidateRevision)
        if (descriptor.applies === 'app-restart') {
          configuration.commitForAppRestart(id, committed.revision, candidate)
        } else {
          configuration.commit(id, committed.revision, candidate)
        }
        notify()
      } catch (error) {
        if (candidateMounted) {
          try {
            await remountLastGood(controller)
          } catch (rollbackError) {
            controller.status = 'failed'
            controller.error = `rollback-failed: ${errorMessage(rollbackError)}`
          }
        } else {
          configuration.abort(id)
        }
        await configBridge.abort(controller.identity, staged.candidateRevision).catch(() => undefined)
        notify()
        throw error
      }
    })
    operation = task.catch(() => {})
    return task
  }

  const setPermissionPolicy = (
    id: string,
    capability: CordisXPlatformCapability,
    policy: CordisXPermissionPolicy,
  ): Promise<void> => {
    const task = operation.then(async () => {
      if (disposed) throw new Error('CordisX runtime is disposed')
      const controller = activeController(id)
      if (controller === undefined) throw new Error(`unknown CordisX plugin: ${id}`)
      await broker.setPolicy(controller.identity, capability, policy)
      const blockedReason = requiredBlockReason(controller)
      if (blockedReason !== undefined) {
        rememberRegistrations(id)
        agentRuntime.releaseOwner(controller.identity, 'permission-blocked', moduleGenerationOf(controller))
        await controller.fiber?.dispose()
        await routeService?.settled()
        retirePrincipal(controller, 'Plugin disposed after required permission denial')
        delete controller.fiber
        controller.status = 'permission-blocked'
        controller.blockedReason = blockedReason
        notify()
        return
      }
      if (controller.status === 'permission-blocked') {
        delete controller.blockedReason
        if (blockedPlugins.has(id)) {
          controller.status = 'blocked'
        } else if (controller.item.enabled && controller.item.module !== undefined) {
          await mountPlugin(controller)
        } else {
          controller.status = 'configured-disabled'
        }
      }
      notify()
    })
    operation = task.catch(() => {})
    return task
  }

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  const setExtensionPointPolicy = (
    source: string,
    pluginId: string,
    pointId: string,
    policy: CordisXPointPolicy,
  ): Promise<void> => {
    const task = operation.then(async () => {
      if (disposed) throw new Error('CordisX runtime is disposed')
      const controller = activeController(pluginId, source)
      if (controller === undefined) throw new Error(`unknown CordisX plugin identity: ${source} / ${pluginId}`)
      extensionPointBroker.setPolicy(controller.identity, pointId, policy)
      slotService?.invalidatePointPolicies()
      await routeService?.invalidatePointPolicies()
      notify()
    })
    operation = task.catch(() => {})
    return task
  }

  const permissionAuthorizationPlan = (id: string): CordisXPermissionAuthorizationPlanV1 => {
    const controller = activeController(id)
    if (controller === undefined) throw new Error(`unknown CordisX plugin: ${id}`)
    return broker.authorizationPlan(controller.identity, 'enable')
  }

  const permissionAuthorizationPlanV2 = (id: string): CordisXPermissionAuthorizationPlanV2 | undefined => {
    const controller = activeController(id)
    if (controller === undefined) throw new Error(`unknown CordisX plugin: ${id}`)
    return controller.manifest.schemaVersion === 4
      ? broker.authorizationPlanV2(controller.identity, 'enable', controller.generationView)
      : undefined
  }

  const authorizePluginWith = (
    id: string,
    authorize: (controller: PluginController) => Promise<void>,
  ): Promise<void> => {
    const task = operation.then(async () => {
      if (disposed) throw new Error('CordisX runtime is disposed')
      const controller = activeController(id)
      if (controller === undefined) throw new Error(`unknown CordisX plugin: ${id}`)
      if (!controller.item.enabled || controller.item.module === undefined) {
        throw new Error(`plugin ${id} is disabled in cordisx.config.json and is not bundled`)
      }
      await authorize(controller)
      blockedPlugins.delete(id)
      writeBlockedPlugins(blockedPlugins)
      const blockedReason = requiredBlockReason(controller)
      if (blockedReason !== undefined) {
        rememberRegistrations(id)
        agentRuntime.releaseOwner(controller.identity, 'permission-blocked', moduleGenerationOf(controller))
        await controller.fiber?.dispose()
        await routeService?.settled()
        retirePrincipal(controller, 'Plugin disposed after activation authorization denial')
        delete controller.fiber
        controller.status = 'permission-blocked'
        controller.blockedReason = blockedReason
        notify()
        return
      }
      if (controller.fiber === undefined) await mountPlugin(controller)
      notify()
    })
    operation = task.catch(() => {})
    return task
  }

  const authorizePlugin = (
    id: string,
    decision: CordisXPermissionAuthorizationDecisionV1,
  ): Promise<void> => authorizePluginWith(id, async controller => {
    await broker.authorizeActivation(controller.identity, decision, 'enable', controller.generationView)
  })

  const authorizePluginV2 = (
    id: string,
    decision: CordisXPermissionAuthorizationDecisionV2,
  ): Promise<void> => authorizePluginWith(id, async controller => {
    if (controller.manifest.schemaVersion !== 4) throw new Error(`plugin ${id} does not use permission v2`)
    await broker.authorizeActivationV2(controller.identity, decision, 'enable', controller.generationView)
  })

  const candidateController = (
    handle: PluginGenerationTransitionHandle,
    mutation: RendererPluginMutation,
    pluginId: string,
    module?: CordisXPluginModule,
    moduleFactory?: (console: CordisXPluginConsoleFacade) => CordisXPluginModule,
  ): { readonly controller: PluginController; readonly registerAuthority: boolean } => {
    const activation = mutation.candidate.plugins.find(item => item.id === pluginId)
    if (activation === undefined) throw new Error(`candidate is missing affected plugin ${pluginId}`)
    const existing = activeController(pluginId)
    const replacesTarget = pluginId === mutation.targetId
      && (mutation.operation === 'install' || mutation.operation === 'update' || mutation.operation === 'enable')
    if (!replacesTarget && existing === undefined) throw new Error(`affected plugin ${pluginId} is not active`)
    if (replacesTarget && (mutation.package === undefined || (module === undefined && moduleFactory === undefined))) {
      throw new Error('candidate package module is unavailable')
    }
    if (replacesTarget && (mutation.package!.manifest.id !== pluginId
      || mutation.package!.digest !== activation.digest
      || mutation.package!.manifest.version !== activation.version)) {
      throw new Error('candidate package does not match the activation tuple')
    }
    const descriptor = existing === undefined
      ? undefined
      : configuration.descriptor(pluginId, i18nService?.getSnapshot().locale ?? 'en')
    const candidateModule = replacesTarget ? module : existing!.item.module
    const candidateModuleFactory = replacesTarget ? moduleFactory : existing!.item.moduleFactory
    const candidateManifest = replacesTarget ? mutation.package!.manifest.runtimeManifest : existing!.item.manifest
    const item: CordisXBrowserPlugin = {
      id: pluginId,
      source: replacesTarget ? mutation.package!.identitySource : existing!.item.source,
      enabled: activation.enabled,
      ...(candidateModule === undefined ? {} : { module: candidateModule }),
      ...(candidateModuleFactory === undefined ? {} : { moduleFactory: candidateModuleFactory }),
      config: descriptor?.value ?? {},
      revision: descriptor?.revision ?? 0,
      ...(candidateManifest === undefined ? {} : { manifest: candidateManifest }),
      package: {
        version: activation.version,
        digest: activation.digest,
        moduleGeneration: activation.moduleGeneration,
        dependencies: activation.dependencies,
        ...(activation.canonicalSource === undefined ? {} : { canonicalSource: activation.canonicalSource }),
      },
      ...(replacesTarget
        ? mutation.package!.readme === undefined ? {} : { readme: mutation.package!.readme }
        : existing!.item.readme === undefined ? {} : { readme: existing!.item.readme }),
    }
    const controller = createController(item, pluginConsole)
    controller.generationContext = generationVisibility.context(handle, pluginId)
    const candidateContext = ctx.extend({
      [CORDISX_PLUGIN_ID]: controller.item.id,
      [CORDISX_PLUGIN_SOURCE]: controller.item.source,
      [CORDISX_PLUGIN_GENERATION]: moduleGenerationOf(controller),
      ...controller.generationContext,
    })
    controller.generationView = generationVisibility.view(candidateContext)
    return { controller, registerAuthority: true }
  }

  const disposeControllers = async (
    items: readonly PluginController[],
    activation: CordisXPluginActivationRecordV1,
    disposedAfter: string[],
  ): Promise<void> => {
    const byId = new Map(items.map(controller => [controller.item.id, controller]))
    const order = topologicalActivationOrder(activation, new Set(byId.keys())).reverse()
    let failure: unknown
    for (const id of order) {
      if (disposedAfter.includes(id)) continue
      const controller = byId.get(id)
      if (controller === undefined) continue
      try {
        await disposeControllerFiber(controller, 'generation-replaced')
      } catch (error) {
        failure ??= error
      } finally {
        unregisterController(controller)
        disposedAfter.push(id)
      }
    }
    if (failure !== undefined) throw failure
  }

  const orderControllersFor = (activation: CordisXPluginActivationRecordV1): void => {
    const order = new Map(activation.plugins.map((plugin, index) => [plugin.id, index]))
    const generation = new Map(activation.plugins.map(plugin => [plugin.id, plugin.moduleGeneration]))
    controllers.sort((left, right) => {
      const byPlugin = (order.get(left.item.id) ?? Number.MAX_SAFE_INTEGER)
        - (order.get(right.item.id) ?? Number.MAX_SAFE_INTEGER)
      if (byPlugin !== 0) return byPlugin
      const expected = generation.get(left.item.id)
      if (moduleGenerationOf(left) === expected) return -1
      if (moduleGenerationOf(right) === expected) return 1
      return 0
    })
  }

  const restoreControllers = async (
    items: readonly PluginController[],
    activation: CordisXPluginActivationRecordV1,
    disposedAfter: string[],
    publication?: PluginGenerationPublication,
  ): Promise<void> => {
    const byId = new Map(items.map(controller => [controller.item.id, controller]))
    for (const id of topologicalActivationOrder(activation, new Set(disposedAfter))) {
      const controller = byId.get(id)
      if (controller === undefined || !disposedAfter.includes(id)) continue
      if (publication !== undefined) {
        controller.generationContext = generationVisibility.retiringContext(publication, id)
        const rollbackContext = ctx.extend({
          [CORDISX_PLUGIN_ID]: controller.item.id,
          [CORDISX_PLUGIN_SOURCE]: controller.item.source,
          [CORDISX_PLUGIN_GENERATION]: moduleGenerationOf(controller),
          ...controller.generationContext,
        })
        controller.generationView = generationVisibility.view(rollbackContext)
      }
      if (!controllers.includes(controller)) {
        registerController(controller)
        controllers.push(controller)
      }
      const item = activation.plugins.find(plugin => plugin.id === id)
      if (item?.enabled === true && !blockedPlugins.has(id)) await mountPlugin(controller)
      const index = disposedAfter.indexOf(id)
      if (index >= 0) disposedAfter.splice(index, 1)
    }
  }

  const stagePluginMutation = (
    mutation: RendererPluginMutation,
    module?: CordisXPluginModule,
    moduleFactory?: (console: CordisXPluginConsoleFacade) => CordisXPluginModule,
  ): Promise<PluginGenerationReadinessReceipt> => {
    const task = operation.then(async () => {
      if (disposed) throw new Error('CordisX runtime is disposed')
      if (mutation.previous.runtimeGeneration !== generation || mutation.candidate.runtimeGeneration !== generation) {
        throw new Error('stale CordisX runtime generation')
      }
      if (mutation.candidate.lastGoodRevision !== mutation.previous.revision
        || mutation.candidate.revision !== mutation.previous.revision + 1) {
        throw new Error('invalid plugin activation revision transition')
      }
      if (generationTransactions.has(mutation.transactionId)) throw new Error('plugin generation transaction already exists')
      const handle = generationVisibility.begin(
        mutation.transactionId,
        mutation.previous,
        mutation.candidate,
        mutation.transactionEpoch,
      )
      const supplied = new Set(mutation.affectedPluginIds)
      if (supplied.size !== handle.affectedPluginIds.length
        || handle.affectedPluginIds.some(id => !supplied.has(id))
        || !handle.affectedPluginIds.includes(mutation.targetId)) {
        generationVisibility.abort(handle)
        throw new Error('affected plugin set does not match the Host dependency closure')
      }
      const affected = new Set(handle.affectedPluginIds)
      const previous = activeControllers().filter(controller => affected.has(controller.item.id))
      const candidates: PluginController[] = []
      notificationsSuppressed = true
      try {
        for (const id of handle.affectedPluginIds) {
          if (!mutation.candidate.plugins.some(item => item.id === id)) continue
          const candidate = candidateController(handle, mutation, id, module, moduleFactory)
          registerController(candidate.controller, candidate.registerAuthority)
          controllers.push(candidate.controller)
          candidates.push(candidate.controller)
          if (candidate.controller.item.id === mutation.targetId
            && mutation.authorizationDecision !== undefined
            && (mutation.operation === 'install' || mutation.operation === 'update' || mutation.operation === 'enable')) {
            if (mutation.authorizationDecision.schemaVersion === 2) {
              if (candidate.controller.manifest.schemaVersion !== 4) throw new Error('permission v2 decision requires manifest-v4')
              await broker.authorizeActivationV2(
                candidate.controller.identity,
                mutation.authorizationDecision,
                mutation.operation as 'install' | 'update' | 'enable',
                candidate.controller.generationView,
              )
            } else {
              await broker.authorizeActivation(
                candidate.controller.identity,
                mutation.authorizationDecision,
                mutation.operation as 'install' | 'update' | 'enable',
                candidate.controller.generationView,
              )
            }
          }
        }
        await broker.settled()
        const candidateById = new Map(candidates.map(controller => [controller.item.id, controller]))
        for (const id of topologicalActivationOrder(mutation.candidate, affected)) {
          const activation = mutation.candidate.plugins.find(item => item.id === id)
          const controller = candidateById.get(id)
          if (activation?.enabled !== true || controller === undefined) continue
          if (blockedPlugins.has(id)) throw new Error(`candidate plugin ${id} is blocked`)
          await mountPlugin(controller)
          if (controller.status !== 'active') throw new Error(`candidate plugin ${id} is not ready: ${controller.blockedReason ?? controller.error ?? controller.status}`)
        }
        const readiness = generationVisibility.confirmReadiness(handle)
        if ((mutation.expectedRegistryEpoch !== undefined && readiness.expectedRegistryEpoch !== mutation.expectedRegistryEpoch)
          || (mutation.afterRegistryEpoch !== undefined && readiness.afterRegistryEpoch !== mutation.afterRegistryEpoch)) {
          throw new Error('shared registry epoch does not match the Host activation plan')
        }
        generationTransactions.set(mutation.transactionId, {
          handle,
          readiness,
          affectedPluginIds: handle.affectedPluginIds,
          previous,
          candidates,
          previousActivation: mutation.previous,
          candidateActivation: mutation.candidate,
          disposedAfter: [],
        })
        return readiness
      } catch (error) {
        const disposedCandidates: string[] = []
        await disposeControllers(candidates, mutation.candidate, disposedCandidates).catch(() => undefined)
        generationTransactions.set(mutation.transactionId, {
          handle,
          affectedPluginIds: handle.affectedPluginIds,
          previous,
          candidates,
          previousActivation: mutation.previous,
          candidateActivation: mutation.candidate,
          disposedAfter: disposedCandidates,
          failedStage: true,
        })
        throw error
      } finally {
        notificationsSuppressed = false
      }
    })
    operation = task.catch(() => {})
    return task
  }

  const publishPluginMutation = (transactionId: string): Promise<PluginGenerationPublication> => {
    const task = operation.then(async () => {
      const transaction = generationTransactions.get(transactionId)
      if (transaction === undefined) throw new Error('unknown plugin generation transaction')
      if (transaction.failedStage || transaction.readiness === undefined) throw new Error('plugin generation readiness failed')
      if (transaction.publication === undefined) {
        const barrier = generationVisibility.preparePublish(transaction.handle, transaction.readiness)
        notificationsSuppressed = true
        try {
          orderControllersFor(transaction.candidateActivation)
          transaction.publication = generationVisibility.publish(barrier)
          currentActivation = transaction.candidateActivation
          await routeService?.settled()
          await broker.settled()
          await drainSuppressedNotifications()
          notifyBatch()
          // Let synchronous subscribers enqueue their projection microtasks while
          // registry-local notifications are still suppressed. Drain the finite
          // projection/diagnostic microtask cascade without yielding a macrotask.
          await drainBatchSubscriberMicrotasks()
        } finally {
          notificationsSuppressed = false
        }
      }
      return transaction.publication
    })
    operation = task.catch(() => {})
    return task
  }

  const completePluginMutation = (transactionId: string): Promise<RendererGenerationCleanupObservation> => {
    const task = operation.then(async () => {
      const transaction = generationTransactions.get(transactionId)
      if (transaction?.publication === undefined) throw new Error('plugin generation is not published')
      notificationsSuppressed = true
      try {
        await disposeControllers(transaction.previous, transaction.previousActivation, transaction.disposedAfter)
        await drainSuppressedNotifications()
      } finally {
        notificationsSuppressed = false
      }
      return {
        transactionId,
        transactionEpoch: transaction.publication.transactionEpoch,
        registryEpoch: transaction.publication.registryEpoch,
        active: transaction.candidateActivation,
        disposedAfter: transaction.previousActivation,
      }
    })
    operation = task.catch(() => {})
    return task
  }

  const finalizePluginMutation = (transactionId: string): Promise<void> => {
    const task = operation.then(() => {
      const transaction = generationTransactions.get(transactionId)
      if (transaction?.publication === undefined || transaction.disposedAfter.length !== transaction.previous.length) {
        throw new Error('plugin generation cleanup is incomplete')
      }
      generationVisibility.completeLastGood(transaction.publication)
      currentActivation = committedActivation(transaction.candidateActivation)
      generationTransactions.delete(transactionId)
    })
    operation = task.catch(() => {})
    return task
  }

  const commitPluginMutation = async (transactionId: string): Promise<void> => {
    await publishPluginMutation(transactionId)
    await completePluginMutation(transactionId)
    await finalizePluginMutation(transactionId)
  }

  const rollbackPluginMutation = (transactionId: string): Promise<RendererGenerationCleanupObservation> => {
    const task = operation.then(async () => {
      const transaction = generationTransactions.get(transactionId)
      if (transaction === undefined) throw new Error('unknown plugin generation transaction')
      const disposedCandidates: string[] = []
      if (transaction.publication === undefined) {
        notificationsSuppressed = true
        try {
          await disposeControllers(transaction.candidates, transaction.candidateActivation, disposedCandidates)
          await drainSuppressedNotifications()
          const registryEpoch = transaction.failedStage
            ? generationVisibility.rollbackFailedStage(transaction.handle)
            : (generationVisibility.abort(transaction.handle), generationVisibility.registryEpoch())
          generationTransactions.delete(transactionId)
          return {
            transactionId,
            transactionEpoch: transaction.handle.transactionEpoch,
            registryEpoch,
            active: transaction.previousActivation,
            disposedAfter: transaction.candidateActivation,
          }
        } finally {
          notificationsSuppressed = false
        }
      } else {
        notificationsSuppressed = true
        try {
          await restoreControllers(
            transaction.previous,
            transaction.previousActivation,
            transaction.disposedAfter,
            transaction.publication,
          )
          orderControllersFor(transaction.previousActivation)
          generationVisibility.rollback(transaction.publication)
          currentActivation = transaction.previousActivation
          await disposeControllers(transaction.candidates, transaction.candidateActivation, disposedCandidates)
          await routeService?.settled()
          await broker.settled()
          generationVisibility.completeRollback(transaction.publication)
          await drainSuppressedNotifications()
          notifyBatch()
          await drainBatchSubscriberMicrotasks()
        } finally {
          notificationsSuppressed = false
        }
      }
      generationTransactions.delete(transactionId)
      return {
        transactionId,
        transactionEpoch: transaction.handle.transactionEpoch,
        registryEpoch: generationVisibility.registryEpoch(),
        active: transaction.previousActivation,
        disposedAfter: transaction.candidateActivation,
      }
    })
    operation = task.catch(() => {})
    return task
  }

  const recoverPluginMutation = (
    input: RendererGenerationCleanupObservation,
  ): Promise<RendererGenerationCleanupObservation> => {
    const task = operation.then(() => {
      if (disposed) throw new Error('CordisX runtime is disposed')
      if (generationTransactions.size !== 0) throw new Error('plugin generation recovery conflicts with a live transaction')
      if (input.registryEpoch !== generationVisibility.registryEpoch()
        || input.active.profileId !== currentActivation.profileId
        || input.active.plugins.length !== currentActivation.plugins.length) {
        throw new Error('plugin generation recovery scope is stale')
      }
      const live = new Map(currentActivation.plugins.map(plugin => [plugin.id, plugin]))
      for (const plugin of input.active.plugins) {
        const current = live.get(plugin.id)
        if (current === undefined
          || current.version !== plugin.version
          || current.digest !== plugin.digest
          || current.moduleGeneration !== plugin.moduleGeneration
          || current.enabled !== plugin.enabled
          || JSON.stringify(current.dependencies) !== JSON.stringify(plugin.dependencies)
          || current.canonicalSource !== plugin.canonicalSource) {
          throw new Error('plugin generation recovery closure is stale')
        }
      }
      const disposedGenerations = new Map(input.disposedAfter.plugins.map(plugin => [plugin.id, plugin.moduleGeneration]))
      for (const controller of projectedControllers()) {
        const candidateGeneration = disposedGenerations.get(controller.item.id)
        if (candidateGeneration !== undefined
          && candidateGeneration === moduleGenerationOf(controller)
          && candidateGeneration !== live.get(controller.item.id)?.moduleGeneration) {
          throw new Error('published candidate generation survived process recovery')
        }
      }
      return structuredClone(input)
    })
    operation = task.catch(() => {})
    return task
  }

  const adoptRecoveredActivation = (
    active: CordisXPluginActivationRecordV1,
    registryEpoch: number,
  ): Promise<void> => {
    const task = operation.then(() => {
      if (disposed) throw new Error('CordisX runtime is disposed')
      if (active.runtimeGeneration !== generation) throw new Error('recovered activation runtime generation is stale')
      generationVisibility.adoptRecoveredActivation(active, registryEpoch)
      currentActivation = active
    })
    operation = task.catch(() => {})
    return task
  }

  const abortPluginMutation = async (transactionId: string): Promise<void> => {
    await rollbackPluginMutation(transactionId)
  }

  const reloadPluginGeneration = (pluginId: string, moduleGeneration: string, runtimeGeneration: string): Promise<void> => {
    const task = operation.then(async () => {
      if (disposed) throw new Error('CordisX runtime is disposed')
      if (runtimeGeneration !== generation) throw new Error('stale CordisX runtime generation')
      const controller = activeController(pluginId)
      if (controller === undefined || controller.item.package?.moduleGeneration !== moduleGeneration) {
        throw new Error('stale plugin module generation')
      }
      if (!controller.item.enabled || controller.item.module === undefined) throw new Error('plugin is disabled')
      await disposeControllerFiber(controller, 'owner-disposed')
      try {
        await mountPlugin(controller)
      } catch (error) {
        await mountPlugin(controller).catch(rollbackError => {
          controller.status = 'failed'
          controller.error = `rollback-failed: ${errorMessage(rollbackError)}`
        })
        throw error
      } finally {
        notify()
      }
    })
    operation = task.catch(() => {})
    return task
  }

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    disposeManager?.()
    disposeManager = undefined
    disposeI18nSubscription?.()
    disposeI18nSubscription = undefined
    disposePermissionSubscription?.()
    disposePermissionSubscription = undefined
    disposeExtensionPointSubscription?.()
    disposeExtensionPointSubscription = undefined
    for (const unsubscribe of registrySubscriptions.splice(0)) unsubscribe()
    await operation
    for (const controller of [...controllers].reverse()) {
      agentRuntime.releaseOwner(controller.identity, 'generation-replaced', moduleGenerationOf(controller))
      await controller.fiber?.dispose()
      retirePrincipal(controller, 'Plugin disposed with runtime generation')
      delete controller.fiber
    }
    generationTransactions.clear()
    configBridge?.dispose()
    serviceConfigBridge?.dispose()
    lifecycleBridge?.dispose()
    configRenderers.dispose()
    configuration.dispose()
    adapterHandle?.dispose()
    adapterHandle = undefined
    undeclareManagerContentOutlet?.()
    undeclareManagerContentOutlet = undefined
    undeclareManagerOutlet?.()
    undeclareManagerOutlet = undefined
    await slotFiber?.dispose()
    slotFiber = undefined
    await configRendererFiber?.dispose()
    configRendererFiber = undefined
    await channelManagerFiber?.dispose()
    channelManagerFiber = undefined
    await settingsFiber?.dispose()
    settingsFiber = undefined
    await routeFiber?.dispose()
    routeFiber = undefined
    await pageFiber?.dispose()
    pageFiber = undefined
    await commandFiber?.dispose()
    commandFiber = undefined
    await platformFiber?.dispose()
    platformFiber = undefined
    await systemPromptFiber?.dispose()
    systemPromptFiber = undefined
    await agentFiber?.dispose()
    agentFiber = undefined
    await agentEventFiber?.dispose()
    agentEventFiber = undefined
    await agentHistoryFiber?.dispose()
    agentHistoryFiber = undefined
    await agentRuntime.dispose()
    historyAdapter.dispose()
    bindingPlatformAdapter?.dispose()
    bindingPlatformAdapter = undefined
    if (permissionStore instanceof BindingPermissionPolicyStore) permissionStore.dispose()
    for (const remove of disposeExtensionPointCatalogs.splice(0).reverse()) await remove()
    unregisterManagerPointCatalog?.()
    unregisterManagerPointCatalog = undefined
    await i18nFiber?.dispose()
    i18nFiber = undefined
    listeners.clear()
    for (const controller of controllers) controller.unregisterPermissions?.()
    for (const controller of controllers) controller.unregisterExtensionPoints?.()
    broker.dispose()
    window.removeEventListener('error', recordUnknownError)
    window.removeEventListener('unhandledrejection', recordUnknownError)
    disconnectPluginConsoleVisibility()
    pluginConsole.dispose()
    extensionPointBroker.dispose()
    extensionPointDescriptors.dispose()
    settingsProjectionSites.clear()
    settingsNavigationProjectionSites.clear()
    extensionContributionProjectionSites.clear()
    if (globalThis.__cordisxRuntime === handle) globalThis.__cordisxRuntime = undefined
    document.documentElement.removeAttribute('data-cordisx-ready')
  }

  const handle: CordisXRuntimeHandle = {
    version: metadata.version,
    get pluginIds() { return projectedControllers().map(controller => controller.item.id) },
    execute: (owner, reference, invocationKey) => {
      if (commandService === undefined) return Promise.reject(new Error('CordisX commands are not ready'))
      return commandService.executeFor(owner, reference, invocationKey)
    },
    navigate: (owner, reference) => {
      if (routeService === undefined) return Promise.reject(new Error('CordisX routes are not ready'))
      return routeService.navigateFor(owner, reference)
    },
    mountSettingsTab: (id, panelBody) => {
      if (routeService === undefined || slotService === undefined) return Promise.reject(new Error('CordisX manager settings are not ready'))
      const registration = slotService.snapshot().find(item => item.surface === 'manager.settings.tabs'
        && item.qualifiedId === id && item.valid && item.visible && item.authorized && !item.pending && !item.disabled)
      if (registration === undefined) return Promise.reject(new Error(`manager settings tab ${id} is not activatable`))
      const item = registration.item as CordisXManagerSettingsTabItem
      return routeService.mountManagerSettingsFor(registration.owner, item.route, registration.qualifiedId, panelBody)
    },
    closeSettingsTabContent: () => routeService?.closeManagerSettings() ?? Promise.resolve(),
    mountManagerContent: (id, container) => {
      if (routeService === undefined || slotService === undefined) return Promise.reject(new Error('CordisX manager content is not ready'))
      const registration = slotService.snapshot().find(item => item.surface === 'manager.settings.navigation-items'
        && item.qualifiedId === id && item.valid && item.visible && item.authorized && !item.pending && !item.disabled
        && (item.group === 'before-settings' || item.group === 'after-settings'))
      if (registration === undefined) return Promise.reject(new Error(`manager content item ${id} is not activatable`))
      const item = registration.item as CordisXManagerSettingsNavigationItem
      return routeService.mountManagerContentFor(registration.owner, item.route, registration.qualifiedId, container)
    },
    closeManagerContent: () => routeService?.closeManagerContent() ?? Promise.resolve(),
    pluginConsole: (id) => {
      const controller = activeController(id)
      if (controller === undefined) throw new Error(`unknown CordisX plugin: ${id}`)
      return pluginConsole.query(controller.identity)
    },
    clearPluginConsole: (id) => {
      const controller = activeController(id)
      if (controller === undefined) throw new Error(`unknown CordisX plugin: ${id}`)
      pluginConsole.clear(controller.identity)
    },
    subscribePluginConsole: listener => pluginConsole.subscribe(listener),
    setExtensionPointPolicy,
    permissionAuthorizationPlan,
    authorizePlugin,
    permissionAuthorizationPlanV2,
    authorizePluginV2,
    activePluginGeneration: () => structuredClone(currentActivation),
    generationNotificationTrace: () => generationNotificationTrace.map(item => ({ ...item })),
    settleRegistryProjection,
    requestPluginLifecycle: (lifecycleOperation: CordisXPluginLifecycleOperationV1): Promise<CordisXPluginLifecycleResultV1> => {
      if (lifecycleBridge === undefined) return Promise.reject(new Error('plugin lifecycle operations are unavailable'))
      return lifecycleBridge.request(currentActivation.revision, lifecycleOperation)
    },
    permissionLifecycleReviewPlanV2: target => {
      if (lifecycleBridge === undefined) return Promise.reject(new Error('plugin lifecycle operations are unavailable'))
      return lifecycleBridge.permissionReviewPlanV2(currentActivation.revision, target)
    },
    applyPermissionLifecycleReviewV2: decision => {
      if (lifecycleBridge === undefined) return Promise.reject(new Error('plugin lifecycle operations are unavailable'))
      return lifecycleBridge.applyPermissionReviewV2(currentActivation.revision, decision)
    },
    stagePluginMutation,
    publishPluginMutation,
    completePluginMutation,
    finalizePluginMutation,
    rollbackPluginMutation,
    recoverPluginMutation,
    adoptRecoveredActivation,
    commitPluginMutation,
    abortPluginMutation,
    reloadPluginGeneration,
    snapshot,
    setPluginBlocked,
    updatePluginConfig,
    listServiceConfigs: async (pluginId: string): Promise<readonly HostServiceConfigDescriptor[]> => {
      if (serviceConfigBridge === undefined) return []
      return await serviceConfigBridge.list(pluginId)
    },
    updateServiceConfig: async (mutation: HostServiceConfigMutation): Promise<HostServiceConfigMutationResult> => {
      if (serviceConfigBridge === undefined) throw new Error('service-config-unavailable')
      return await serviceConfigBridge.mutate(mutation)
    },
    mountConfigRenderer: (pluginId, field, container, setDraft) => configRenderers.mount(pluginId, field, container, setDraft),
    setPermissionPolicy,
    subscribe,
    dispose,
  }

  try {
    i18nFiber = ctx.plugin(CordisXI18nService)
    await i18nFiber
    i18nService = ctx.i18n as CordisXI18nService
    for (const catalog of CORDISX_EXTENSION_POINT_LOCALE_CATALOGS) {
      disposeExtensionPointCatalogs.push(i18nService.define(catalog))
    }
    for (const catalog of CORDISX_CAPABILITY_AVAILABILITY_LOCALE_CATALOGS) {
      disposeExtensionPointCatalogs.push(i18nService.define(catalog))
    }
    disposeI18nSubscription = i18nService.subscribeInternal(notifyFrom('i18n'))
    disposePermissionSubscription = broker.subscribe(notifyFrom('permissions'))
    disposeExtensionPointSubscription = extensionPointBroker.subscribe(notifyFrom('extension-policy'))
    settingsFiber = ctx.plugin(CordisXPluginSettingsService, { registry: configuration, console: pluginConsole })
    await settingsFiber
    configRendererFiber = ctx.plugin(CordisXConfigRendererService, { registry: configRenderers, console: pluginConsole })
    await configRendererFiber
    channelManagerFiber = ctx.plugin(CordisXChannelManagerService, metadata.channelManager)
    await channelManagerFiber
    registrySubscriptions.push(configuration.subscribe(notifyFrom('configuration')))
    platformFiber = ctx.plugin(CordisXPlatformService, { adapter: platformAdapter, broker, console: pluginConsole })
    await platformFiber
    agentEventFiber = ctx.plugin(CordisXAgentEventService, {
      ledger: agentRuntime.ledger,
      broker,
      status: () => agentRuntime.status(),
      console: pluginConsole,
    })
    await agentEventFiber
    agentHistoryFiber = ctx.plugin(CordisXAgentHistoryService, { adapter: historyAdapter, broker, generation, console: pluginConsole })
    await agentHistoryFiber
    agentFiber = ctx.plugin(CordisXAgentService, { runtime: agentRuntime, console: pluginConsole })
    await agentFiber
    systemPromptFiber = ctx.plugin(CordisXSystemPromptService, { runtime: agentRuntime, console: pluginConsole })
    await systemPromptFiber
    commandFiber = ctx.plugin(CordisXCommandService, { console: pluginConsole })
    await commandFiber
    commandService = ctx.commands as CordisXCommandService
    pageFiber = ctx.plugin(CordisXPageService, pluginConsole)
    await pageFiber
    pageService = ctx.pages as CordisXPageService
    routeFiber = ctx.plugin(CordisXRouteService, pluginConsole)
    await routeFiber
    routeService = ctx.routes as CordisXRouteService
    unregisterManagerPointCatalog = extensionPointDescriptors.registerCatalog(CORDISX_MANAGER_EXTENSION_POINT_CATALOG)
    const managerOutletController = {
      getSnapshot: () => ({ available: false, contextKey: generation, placement: 'absolute' as const }),
      subscribe: (_listener: () => void) => () => {},
      show: () => {},
      hide: () => {},
    }
    undeclareManagerOutlet = routeService.outlets.declare({
      schemaVersion: 1,
      id: 'manager.settings.content',
      authority: 'host-adapter',
      scope: 'manager-settings',
      preferredPlacement: 'absolute',
      contextPolicy: 'generation',
      presentationGroup: 'manager.settings',
    }, managerOutletController, path => path.startsWith('/manager/settings/') && path.length > '/manager/settings/'.length)
    const managerContentOutletController = {
      getSnapshot: () => ({ available: false, contextKey: generation, placement: 'absolute' as const }),
      subscribe: (_listener: () => void) => () => {},
      show: () => {},
      hide: () => {},
    }
    undeclareManagerContentOutlet = routeService.outlets.declare({
      schemaVersion: 1,
      id: 'manager.content',
      authority: 'host-adapter',
      scope: 'manager',
      preferredPlacement: 'absolute',
      contextPolicy: 'generation',
      presentationGroup: 'manager',
    }, managerContentOutletController, path => (
      path.startsWith('/manager/extensions/') && path.length > '/manager/extensions/'.length
    ))
    slotFiber = ctx.plugin(CordisXSlotService, { console: pluginConsole })
    await slotFiber
    slotService = ctx.slots as CordisXSlotService
    slotService.setResolvers({
      command: (owner, reference, view) => commandService?.hasFor(owner, reference, view) ?? false,
      route: (owner, id, view) => routeService?.hasFor(owner, id, view) ?? false,
      managerSettingsRoute: (owner, id, view) => routeService?.managerSettingsRouteFor(owner, id, view)
        ?? { state: 'pending', detail: 'CordisX routes are not ready' },
      managerSettingsNavigationRoute: (owner, id, view) => routeService?.managerSettingsNavigationRouteFor(owner, id, view)
        ?? { state: 'pending', detail: 'CordisX routes are not ready' },
    })
    commandService.setAccessResolver(extensionPointBroker)
    routeService.setAccessResolver(extensionPointBroker)
    slotService.setAccessResolver(extensionPointBroker)
    registrySubscriptions.push(
      extensionPointDescriptors.subscribe(notifyFrom('extension-descriptors')),
      commandService.subscribeInternal(notifyFrom('commands')),
      pageService.registry.subscribe(notifyFrom('pages')),
      routeService.subscribeInternal(notifyFrom('routes')),
      slotService.subscribeInternal(notifyFrom('surfaces')),
    )
    adapterHandle = installCodexAdapter(document, slotService, commandService, routeService, i18nService, extensionPointDescriptors, {
      generation,
      adapterVersion: metadata.version,
    })
    for (const controller of controllers) {
      if (controller.status !== 'active') continue
      await mountPlugin(controller)
    }
    disposeManager = installCordisXManager(document, handle)
  } catch (error) {
    await dispose()
    throw error
  }

  globalThis.__cordisxRuntime = handle
  document.documentElement.dataset.cordisxReady = 'true'
  const activeIds = controllers.filter(controller => controller.status === 'active').map(controller => controller.item.id)
  console.info(`[cordisx] mounted ${activeIds.length} plugin(s): ${activeIds.join(', ')}`)
  return handle
}

/** Serialize repeated CDP injections so a newer generation disposes the previous one first. */
export function installCordisX(
  plugins: readonly CordisXBrowserPlugin[],
  metadata: CordisXRuntimeMetadata,
): Promise<CordisXRuntimeHandle> {
  const previous = globalThis.__cordisxBoot ?? Promise.resolve(undefined)
  const next = previous.catch(() => undefined).then(() => start(plugins, metadata))
  globalThis.__cordisxBoot = next
  return next
}
