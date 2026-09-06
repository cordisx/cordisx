import { Context, type Fiber } from '@deepseek-ai/cordis'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../contracts.js'
import type {
  CordisXExtensionPointControlMode,
  CordisXPermissionAuthorizationDecisionV1,
  CordisXPermissionAuthorizationPlanV1,
  CordisXPermissionPolicy,
  CordisXPluginActivationRecordV1,
  CordisXPluginBundleManagerSnapshotV1,
  CordisXPluginConsoleFacade,
  CordisXPluginIdentity,
  CordisXPluginModule,
  CordisXPointPolicy,
} from '../contracts.js'
import type { CordisXLocalDevelopmentSnapshot } from '../local-development-contracts.js'
import {
  isPermissionPolicyRecordV2,
  isPermissionPolicyRecordV3,
  isPermissionPolicyRecordV4,
} from '../permission-persistence.js'
import type {
  CordisXPermissionAuthorizationDecisionV2,
  CordisXPermissionAuthorizationDecisionV4,
  CordisXPermissionAuthorizationPlanV2,
  CordisXPermissionCapabilityV4,
  CordisXPermissionScopeV4,
} from '../permission-contracts.js'
import { type CodexAdapterHandle } from './adapter.js'
import { UnavailableCodexHostAdapter } from '../adapters/codex-agent.js'
import { createCodexAgentConnector } from '../adapters/codex-agent-connector.js'
import { CordisXHostAgentRuntime } from './agent.js'
import { PageAdmissionBindingRegistry } from './page-admission-lifecycle.js'
import { CordisXAgentSessionRuntime, type CordisXPrivateAgentDriver } from './agent-session-runtime.js'
import { CodexDesktopAgentSessionTransport } from './codex-desktop-agent-session-transport.js'
import { PlaygroundScenarioSessionScopeAuthority } from './playground-scenario-session-scope.js'
import { type AgentActiveRoute, AgentRouteSessionScopeAuthority } from './agent-route-session-scope.js'
import { CordisXConnectorBroker } from './connectors.js'
import { type ManagerModel, type ManagerSnapshot } from './manager.js'
import { HostManagerNavigationController } from './manager/navigation-controller.js'
import { CordisXCommandService } from './commands.js'
import { CordisXI18nService } from './i18n.js'
import { CordisXPageService, CordisXRouteService } from './navigation.js'
import { BrowserRouteHistoryAdapter, CodexRouterHistoryAdapter } from './codex-router-history.js'
import {
  type AgentRuntimeConnection,
  type AgentRuntimeRouteScope,
  BrowserPermissionPolicyStore,
  MemoryPermissionPolicyStore,
} from './platform.js'
import { CordisXSlotService } from './service.js'
import type { SurfaceContributionSnapshot } from './surfaces.js'
import type { ControlledSurfaceGroupChoice } from './controlled-surfaces.js'
import {
  BrowserExtensionPointPolicyStore,
  CORDISX_EXTENSION_POINT_LOCALE_CATALOGS,
  ExtensionPointDescriptorRegistry,
} from './extension-points.js'
import { projectPublicRuntimeSnapshot } from './public-runtime-snapshot.js'
import { BindingPlatformAdapter } from './provider-binding.js'
import { CordisXAgentLoopBroker } from './agent-loop.js'
import { PlaygroundMockAgentLoopHost, PlaygroundMockAgentLoopV4Transport } from './playground-mock-agent-loop.js'
import { PlaygroundRoomSimulationBridgeRegistry } from './playground-room-simulation-bridge.js'
import {
  BrowserConfigBridge,
  type ConfigCandidate,
  type ConfigMutationOperation,
  ConfigRendererRegistry,
  PluginConfigurationRegistry,
} from './configuration.js'
import { ManagerContentConfigAuthority } from './manager-content-config.js'
import { BrowserServiceConfigBridge } from './service-config-binding.js'
import { BrowserChannelCredentialBridge } from './channel-credential-binding.js'
import { BrowserChannelActionsBridge } from './channel-actions-binding.js'
import { BindingPermissionPolicyStore } from './permission-binding.js'
import { BrowserPluginLifecycleBridge } from './plugin-lifecycle-binding.js'
import { PluginConsoleAspect, type PluginPrincipalToken } from './plugin-console.js'
import {
  CORDISX_GENERATION_VISIBILITY_COORDINATOR,
  GenerationVisibilityCoordinator,
  type PluginGenerationPublication,
  type PluginGenerationReadinessReceipt,
  type PluginGenerationTransitionHandle,
} from './generation-visibility.js'
import { installSharedReactRuntime } from './react-runtime.js'
import { IconThemeRegistry } from './icon-theme-registry.js'
import { bindIconThemeRegistry } from './icons.js'
import { BrowserIconThemePreferenceBridge } from './icon-theme-preference-binding.js'
import {
  type CertifiedPermissionDocumentChannel,
  createCertifiedPermissionDocumentChannel,
} from './certified-permission-channel.js'
import { createBrowserHostDomWorkerEnvironment, type HostDomWorkerEnvironment } from './host-dom-worker.js'
import { TransientCanvasCoordinator } from './transient-canvas.js'
import { BrowserOwnerDocumentBridge, CordisXOwnerDocumentBroker } from './owner-documents.js'
import { type EntityPrincipalBinding } from './entities.js'
import {
  CordisXInternalRendererBootstrap,
  CordisXRuntimeHandle,
  CordisXRuntimeMetadata,
  CordisXStartOptions,
  createController,
  createRuntimeClosureScope,
  PluginController,
  readBlockedPlugins,
  RendererGenerationCleanupObservation,
  RendererGenerationTransaction,
  RendererPluginMutation,
  RuntimeBrowserPlugin,
} from './runtime-shared.js'
import * as runtimeClosures1 from './runtime-foundation.js'
import * as runtimeClosures2 from './runtime-plugin-mount.js'
import * as runtimeClosures3 from './runtime-manager-actions.js'
import * as runtimeClosures4 from './runtime-authorization-mutations.js'
import * as runtimeClosures5 from './runtime-lifecycle-handle.js'
import * as runtimeClosures6 from './runtime-agent-composition.js'

export async function start(
  plugins: readonly RuntimeBrowserPlugin[],
  metadata: CordisXRuntimeMetadata,
  internalBootstrap?: CordisXInternalRendererBootstrap,
  options: CordisXStartOptions = {},
): Promise<CordisXRuntimeHandle> {
  if (options.previousRuntimeDisposed !== true) await globalThis.__cordisxRuntime?.dispose()

  let ctx = new Context()
  let disposeInternalBootstrap: (() => void | Promise<void>) | undefined
  let disposePreparedSharedReactRuntime = options.disposePreparedSharedReactRuntime
  let sharedReactRuntime: ReturnType<typeof installSharedReactRuntime> | undefined
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
  const iconThemeRegistry = new IconThemeRegistry(generation, metadata.profileId)
  const browserHostedPlayground = metadata.hostKind === 'playground' || window.location.protocol !== 'app:'
  const routeHistory = browserHostedPlayground
    ? new BrowserRouteHistoryAdapter(window, true)
    : new CodexRouterHistoryAdapter(window)
  let disposeAgentDetailHistoryReturn: () => void = () => {}
  const playgroundRoomSimulationBridgeRegistry = metadata.hostKind === 'playground'
      && window.location.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname)
    ? new PlaygroundRoomSimulationBridgeRegistry()
    : undefined
  const unbindIconThemeRegistry = bindIconThemeRegistry(document, iconThemeRegistry)
  const iconThemePreferenceBridge =
    metadata.iconThemePreferenceBridgeToken === undefined || metadata.appId === undefined
      ? undefined
      : new BrowserIconThemePreferenceBridge(
        metadata.iconThemePreferenceBridgeToken,
        metadata.appId,
        metadata.profileId,
        generation,
        metadata.iconThemePreference,
      )
  let disposeIconThemePreferenceSubscription: (() => void) | undefined
  const permissionStore = metadata.permissionBridgeToken === undefined
    ? metadata.hostKind === 'playground' && metadata.permissionPolicies !== undefined
      ? new MemoryPermissionPolicyStore(
        metadata.permissionPolicies.filter(record =>
          !isPermissionPolicyRecordV2(record)
          && !isPermissionPolicyRecordV3(record) && !isPermissionPolicyRecordV4(record)
        ),
        metadata.permissionPolicies.filter(isPermissionPolicyRecordV2),
        metadata.permissionPolicies.filter(isPermissionPolicyRecordV3),
        metadata.permissionPolicies.filter(isPermissionPolicyRecordV4),
      )
      : new BrowserPermissionPolicyStore(metadata.profileId)
    : BindingPermissionPolicyStore.connect(metadata.permissionBridgeToken, metadata.permissionPolicies ?? [])
  const configBridge = metadata.configBridgeToken === undefined
    ? undefined
    : new BrowserConfigBridge(metadata.configBridgeToken, metadata.profileId, generation)
  const ownerDocumentBridge = metadata.ownerDocumentBindings === undefined
    ? undefined
    : new BrowserOwnerDocumentBridge()
  const ownerDocumentBroker = new CordisXOwnerDocumentBroker(ownerDocumentBridge, metadata.ownerDocumentBindings)
  const entityPrincipalBindings = new Map<string, EntityPrincipalBinding>()
  const registerEntityBindings = (bindings: CordisXRuntimeMetadata['ownerDocumentBindings']): void => {
    for (const binding of bindings ?? []) {
      if (binding.installationId !== undefined && binding.pluginGeneration !== undefined) {
        entityPrincipalBindings.set(
          JSON.stringify([binding.source, binding.pluginId, binding.moduleGeneration]),
          binding as EntityPrincipalBinding,
        )
      }
    }
  }
  registerEntityBindings(metadata.ownerDocumentBindings)
  const serviceConfigBridge = metadata.serviceConfigBridgeToken === undefined
    ? undefined
    : BrowserServiceConfigBridge.connect(metadata.serviceConfigBridgeToken, metadata.profileId, generation)
  const channelCredentialBridge = metadata.channelCredentialBridgeToken === undefined
    ? undefined
    : BrowserChannelCredentialBridge.connect(metadata.channelCredentialBridgeToken)
  const channelActionsBridge = metadata.channelActionsBridgeToken === undefined
    ? undefined
    : BrowserChannelActionsBridge.connect(metadata.channelActionsBridgeToken)
  const lifecycleBridge = metadata.pluginLifecycleBridgeToken === undefined
    ? undefined
    : new BrowserPluginLifecycleBridge(metadata.pluginLifecycleBridgeToken, metadata.profileId, generation)
  const localDevelopment = new Map(plugins.flatMap(plugin =>
    plugin.development === undefined
      ? []
      : [[plugin.development.sourcePath, structuredClone(plugin.development)] as const]
  ))
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
  let currentPluginBundles: CordisXPluginBundleManagerSnapshotV1 | undefined = metadata.pluginBundleSnapshot
  if (lifecycleBridge !== undefined) {
    currentPluginBundles = await lifecycleBridge.bundleSnapshot().catch(() => currentPluginBundles)
  }
  let ownsSharedReactRuntime = false
  if (globalThis.__cordisxSharedReactRuntime === undefined) {
    sharedReactRuntime = installSharedReactRuntime(document)
    ownsSharedReactRuntime = true
  } else {
    sharedReactRuntime = globalThis.__cordisxSharedReactRuntime
  }
  let certifiedPermissionChannel: CertifiedPermissionDocumentChannel | undefined
  try {
    const generationVisibility = new GenerationVisibilityCoordinator(currentActivation, metadata.initialRegistryEpoch)
    const pluginConsole = new PluginConsoleAspect(generation, 2000, () => Date.now(), generationVisibility)
    let pluginErrorOwners = (): readonly {
      readonly identity: CordisXPluginIdentity
      readonly principal: PluginPrincipalToken
      readonly source: string
    }[] => []
    const closureScope: any = createRuntimeClosureScope({
      abortPluginMutation: () => abortPluginMutation,
      activeAgentRuntimeRouteInstance: [
        () => activeAgentRuntimeRouteInstance,
        (value: any) => activeAgentRuntimeRouteInstance = value,
      ],
      activeController: () => activeController,
      activeControllers: () => activeControllers,
      actualAgentRuntimeRoute: () => actualAgentRuntimeRoute,
      adapterHandle: [() => adapterHandle, (value: any) => adapterHandle = value],
      adoptPluginBundleSnapshot: () => adoptPluginBundleSnapshot,
      adoptRecoveredActivation: () => adoptRecoveredActivation,
      agentAdapter: () => agentAdapter,
      agentDetailHistoryIdentity: () => agentDetailHistoryIdentity,
      agentDetailNavigator: () => agentDetailNavigator,
      agentLoopBroker: () => agentLoopBroker,
      agentLoopBrokerV2: () => agentLoopBrokerV2,
      agentLoopBrokerV4: () => agentLoopBrokerV4,
      agentLoopHost: () => agentLoopHost,
      agentOwnerControllers: () => agentOwnerControllers,
      agentOwnerForController: () => agentOwnerForController,
      agentOwnerKey: () => agentOwnerKey,
      agentRouteScopes: () => agentRouteScopes,
      agentRuntime: () => agentRuntime,
      agentRuntimeConnection: () => agentRuntimeConnection,
      agentRuntimeRouteDisposed: [() => agentRuntimeRouteDisposed, (value: any) => agentRuntimeRouteDisposed = value],
      agentSessionRuntime: [() => agentSessionRuntime, (value: any) => agentSessionRuntime = value],
      agentSessionTransport: () => agentSessionTransport,
      applyRestartCandidate: () => applyRestartCandidate,
      authorizePlugin: () => authorizePlugin,
      authorizePluginV2: () => authorizePluginV2,
      authorizePluginV4: () => authorizePluginV4,
      authorizePluginWith: () => authorizePluginWith,
      bindingPlatformAdapter: [() => bindingPlatformAdapter, (value: any) => bindingPlatformAdapter = value],
      blockedPlugins: () => blockedPlugins,
      boundProviderStatuses: () => boundProviderStatuses,
      broker: () => broker,
      browserHostedPlayground: () => browserHostedPlayground,
      candidateController: () => candidateController,
      capabilityAvailability: () => capabilityAvailability,
      certifiedPermissionChannel: [
        () => certifiedPermissionChannel,
        (value: any) => certifiedPermissionChannel = value,
      ],
      channelActionsBridge: () => channelActionsBridge,
      channelCredentialBridge: () => channelCredentialBridge,
      channelManagerFiber: [() => channelManagerFiber, (value: any) => channelManagerFiber = value],
      commandFiber: [() => commandFiber, (value: any) => commandFiber = value],
      commandService: [() => commandService, (value: any) => commandService = value],
      commitPluginMutation: () => commitPluginMutation,
      completePluginMutation: () => completePluginMutation,
      configBridge: () => configBridge,
      configRendererFiber: [() => configRendererFiber, (value: any) => configRendererFiber = value],
      configRenderers: () => configRenderers,
      configuration: () => configuration,
      connectorBroker: () => connectorBroker,
      consoleAffectedPluginIds: [() => consoleAffectedPluginIds, (value: any) => consoleAffectedPluginIds = value],
      controllerForAgentOwner: () => controllerForAgentOwner,
      controllers: () => controllers,
      ctx: [() => ctx, (value: any) => ctx = value],
      currentActivation: [() => currentActivation, (value: any) => currentActivation = value],
      currentPluginBundles: [() => currentPluginBundles, (value: any) => currentPluginBundles = value],
      desktopAgentSessionTransport: () => desktopAgentSessionTransport,
      developmentAgentRuntimeAuthorization: () => developmentAgentRuntimeAuthorization,
      developmentPolicySeed: () => developmentPolicySeed,
      disconnectPluginConsoleVisibility: () => disconnectPluginConsoleVisibility,
      dispose: () => dispose,
      disposeAgentDetailHistoryReturn: [
        () => disposeAgentDetailHistoryReturn,
        (value: any) => disposeAgentDetailHistoryReturn = value,
      ],
      disposeAgentPermissionFences: () => disposeAgentPermissionFences,
      disposeAgentRouteFences: () => disposeAgentRouteFences,
      disposeAgentRouteHistory: () => disposeAgentRouteHistory,
      disposeControllerFiber: () => disposeControllerFiber,
      disposeControllers: () => disposeControllers,
      disposeExtensionPointCatalogs: () => disposeExtensionPointCatalogs,
      disposeExtensionPointSubscription: [
        () => disposeExtensionPointSubscription,
        (value: any) => disposeExtensionPointSubscription = value,
      ],
      disposeI18nSubscription: [() => disposeI18nSubscription, (value: any) => disposeI18nSubscription = value],
      disposeIconThemePreferenceSubscription: [
        () => disposeIconThemePreferenceSubscription,
        (value: any) => disposeIconThemePreferenceSubscription = value,
      ],
      disposeInternalBootstrap: [() => disposeInternalBootstrap, (value: any) => disposeInternalBootstrap = value],
      disposeManager: [() => disposeManager, (value: any) => disposeManager = value],
      disposePageAdmissionActivation: [
        () => disposePageAdmissionActivation,
        (value: any) => disposePageAdmissionActivation = value,
      ],
      disposePermissionSubscription: [
        () => disposePermissionSubscription,
        (value: any) => disposePermissionSubscription = value,
      ],
      disposePreparedSharedReactRuntime: [
        () => disposePreparedSharedReactRuntime,
        (value: any) => disposePreparedSharedReactRuntime = value,
      ],
      disposed: [() => disposed, (value: any) => disposed = value],
      drainBatchSubscriberMicrotasks: () => drainBatchSubscriberMicrotasks,
      drainSuppressedNotifications: () => drainSuppressedNotifications,
      emitListeners: () => emitListeners,
      entityPrincipalBindings: () => entityPrincipalBindings,
      extensionContributionProjectionSites: [
        () => extensionContributionProjectionSites,
        (value: any) => extensionContributionProjectionSites = value,
      ],
      extensionPointBroker: () => extensionPointBroker,
      extensionPointDescriptors: () => extensionPointDescriptors,
      externalProviderStatuses: () => externalProviderStatuses,
      finalizePluginMutation: () => finalizePluginMutation,
      finalizedTransactions: () => finalizedTransactions,
      generation: () => generation,
      generationNotificationTrace: () => generationNotificationTrace,
      generationTransactions: () => generationTransactions,
      generationVisibility: () => generationVisibility,
      handle: () => handle,
      hostDomAuthority: () => hostDomAuthority,
      hostDomWorkerEnvironment: [() => hostDomWorkerEnvironment, (value: any) => hostDomWorkerEnvironment = value],
      i18nFiber: [() => i18nFiber, (value: any) => i18nFiber = value],
      i18nService: [() => i18nService, (value: any) => i18nService = value],
      iconThemeFiber: [() => iconThemeFiber, (value: any) => iconThemeFiber = value],
      iconThemePreferenceBridge: () => iconThemePreferenceBridge,
      iconThemeRegistry: () => iconThemeRegistry,
      internalBootstrap: () => internalBootstrap,
      knownRegistrations: () => knownRegistrations,
      legacyExtensionPointPolicies: () => legacyExtensionPointPolicies,
      lifecycleBridge: () => lifecycleBridge,
      listeners: () => listeners,
      localDevelopment: () => localDevelopment,
      managerContentConfigAuthority: [
        () => managerContentConfigAuthority,
        (value: any) => managerContentConfigAuthority = value,
      ],
      managerContentFiber: [() => managerContentFiber, (value: any) => managerContentFiber = value],
      managerModel: () => managerModel,
      managerNavigationController: () => managerNavigationController,
      managerSnapshot: () => managerSnapshot,
      metadata: () => metadata,
      moduleGenerationOf: () => moduleGenerationOf,
      mountPlugin: () => mountPlugin,
      notificationsSuppressed: [() => notificationsSuppressed, (value: any) => notificationsSuppressed = value],
      notify: () => notify,
      notifyBatch: () => notifyBatch,
      notifyFrom: () => notifyFrom,
      operation: [() => operation, (value: any) => operation = value],
      orderControllersFor: () => orderControllersFor,
      ownerDocumentBridge: () => ownerDocumentBridge,
      ownerDocumentBroker: () => ownerDocumentBroker,
      ownsSharedReactRuntime: [() => ownsSharedReactRuntime, (value: any) => ownsSharedReactRuntime = value],
      pageAdmissionBindings: () => pageAdmissionBindings,
      pageFiber: [() => pageFiber, (value: any) => pageFiber = value],
      pageService: [() => pageService, (value: any) => pageService = value],
      pendingAgentDetailReturn: [() => pendingAgentDetailReturn, (value: any) => pendingAgentDetailReturn = value],
      permissionAuthorizationPlan: () => permissionAuthorizationPlan,
      permissionAuthorizationPlanV2: () => permissionAuthorizationPlanV2,
      permissionStore: () => permissionStore,
      platformAdapter: () => platformAdapter,
      platformFiber: [() => platformFiber, (value: any) => platformFiber = value],
      playgroundAgentSessionPersistence: () => playgroundAgentSessionPersistence,
      playgroundMockAgentLoop: () => playgroundMockAgentLoop,
      playgroundMockAgentLoopV4Transport: () => playgroundMockAgentLoopV4Transport,
      playgroundRoomSimulationBridgeFiber: [
        () => playgroundRoomSimulationBridgeFiber,
        (value: any) => playgroundRoomSimulationBridgeFiber = value,
      ],
      playgroundRoomSimulationBridgeRegistry: () => playgroundRoomSimulationBridgeRegistry,
      playgroundScenarioAgentRuntimeRoute: () => playgroundScenarioAgentRuntimeRoute,
      pluginConsole: () => pluginConsole,
      pluginErrorOwners: [() => pluginErrorOwners, (value: any) => pluginErrorOwners = value],
      projectedControllers: () => projectedControllers,
      publicSnapshot: () => publicSnapshot,
      publishPluginMutation: () => publishPluginMutation,
      reconcileAgentRuntimeRoute: () => reconcileAgentRuntimeRoute,
      reconcilingAgentRuntimeRoute: [
        () => reconcilingAgentRuntimeRoute,
        (value: any) => reconcilingAgentRuntimeRoute = value,
      ],
      recordUnknownError: () => recordUnknownError,
      recoverPluginMutation: () => recoverPluginMutation,
      recoveredPlaygroundSessions: () => recoveredPlaygroundSessions,
      registerController: () => registerController,
      registerEntityBindings: () => registerEntityBindings,
      registrySubscriptions: () => registrySubscriptions,
      reloadPluginGeneration: () => reloadPluginGeneration,
      rememberFinalizedTransaction: () => rememberFinalizedTransaction,
      rememberRegistrations: () => rememberRegistrations,
      rememberRollbackReceipt: () => rememberRollbackReceipt,
      remountLastGood: () => remountLastGood,
      renewPrincipal: () => renewPrincipal,
      requiredBlockReason: () => requiredBlockReason,
      restoreControllers: () => restoreControllers,
      retirePrincipal: () => retirePrincipal,
      rollbackPluginMutation: () => rollbackPluginMutation,
      rollbackReceipts: () => rollbackReceipts,
      routeFiber: [() => routeFiber, (value: any) => routeFiber = value],
      routeHistory: () => routeHistory,
      routeService: [() => routeService, (value: any) => routeService = value],
      scenarioSessionOwner: [() => scenarioSessionOwner, (value: any) => scenarioSessionOwner = value],
      scenarioSessionScopeAuthority: [
        () => scenarioSessionScopeAuthority,
        (value: any) => scenarioSessionScopeAuthority = value,
      ],
      serviceConfigBridge: () => serviceConfigBridge,
      setExtensionPointControlAuthorization: () => setExtensionPointControlAuthorization,
      setExtensionPointControlGroupChoice: () => setExtensionPointControlGroupChoice,
      setExtensionPointPolicies: () => setExtensionPointPolicies,
      setExtensionPointPolicy: () => setExtensionPointPolicy,
      setPermissionPolicy: () => setPermissionPolicy,
      setPluginBlocked: () => setPluginBlocked,
      settingsFiber: [() => settingsFiber, (value: any) => settingsFiber = value],
      settingsNavigationProjectionSites: [
        () => settingsNavigationProjectionSites,
        (value: any) => settingsNavigationProjectionSites = value,
      ],
      settingsProjectionSites: [() => settingsProjectionSites, (value: any) => settingsProjectionSites = value],
      settleRegistryProjection: () => settleRegistryProjection,
      sharedReactRuntime: [() => sharedReactRuntime, (value: any) => sharedReactRuntime = value],
      simulatorSessionKey: () => simulatorSessionKey,
      slotFiber: [() => slotFiber, (value: any) => slotFiber = value],
      slotService: [() => slotService, (value: any) => slotService = value],
      stagePluginMutation: () => stagePluginMutation,
      subscribe: () => subscribe,
      systemPromptFiber: [() => systemPromptFiber, (value: any) => systemPromptFiber = value],
      traceNotification: () => traceNotification,
      transientCanvasCoordinator: [
        () => transientCanvasCoordinator,
        (value: any) => transientCanvasCoordinator = value,
      ],
      unbindIconThemeRegistry: () => unbindIconThemeRegistry,
      undeclareManagerContentOutlet: [
        () => undeclareManagerContentOutlet,
        (value: any) => undeclareManagerContentOutlet = value,
      ],
      undeclareManagerOutlet: [() => undeclareManagerOutlet, (value: any) => undeclareManagerOutlet = value],
      unregisterController: () => unregisterController,
      unregisterManagerPointCatalog: [
        () => unregisterManagerPointCatalog,
        (value: any) => unregisterManagerPointCatalog = value,
      ],
      updateLocalDevelopmentStatus: () => updateLocalDevelopmentStatus,
      updatePluginConfig: () => updatePluginConfig,
      visualFiber: [() => visualFiber, (value: any) => visualFiber = value],
    })
    const recordUnknownError = (event: Event): void =>
      runtimeClosures1.createRuntimeRecordUnknownError(closureScope, event)
    window.addEventListener('error', recordUnknownError)
    window.addEventListener('unhandledrejection', recordUnknownError)
    let consoleAffectedPluginIds: readonly string[] = []
    const disconnectPluginConsoleVisibility = runtimeClosures1.createRuntimeDisconnectPluginConsoleVisibility(
      closureScope,
    )
    const broker = runtimeClosures1.createRuntimeBroker(closureScope)
    if (metadata.certifiedPermissionChannelToken !== undefined && window.top === window) {
      certifiedPermissionChannel = createCertifiedPermissionDocumentChannel({
        token: metadata.certifiedPermissionChannelToken,
        profileId: metadata.profileId,
        runtimeGeneration: generation,
        sink: broker,
      })
      await certifiedPermissionChannel.ready
    }
    const hostDomAuthority = runtimeClosures1.createRuntimeHostDomAuthority(closureScope)
    // Capture native browser/MessagePort primitives before any plugin module
    // factory runs, then reuse the sealed environment for dynamic generations.
    let hostDomWorkerEnvironment: HostDomWorkerEnvironment | undefined
    try {
      hostDomWorkerEnvironment = createBrowserHostDomWorkerEnvironment(document)
    } catch (error) {
      if (plugins.some(plugin => plugin.isolatedArtifactSource !== undefined)) throw error
    }
    for (const plugin of plugins) {
      if (plugin.package === undefined) {
        generationVisibility.bindStable(
          plugin.id,
          plugin.artifactGeneration ?? `${generation}:${plugin.id}:bundled`,
        )
      }
    }
    ctx = ctx.extend({ [CORDISX_GENERATION_VISIBILITY_COORDINATOR]: generationVisibility })
    const configuration = new PluginConfigurationRegistry(generationVisibility)
    const configRenderers = new ConfigRendererRegistry(generationVisibility)
    const agentRuntime = new CordisXHostAgentRuntime({ adapter: agentAdapter, broker, generation })
    let routeService: CordisXRouteService | undefined
    let disposePageAdmissionActivation = () => {}
    if (metadata.agentLoopBackend === 'mock' && metadata.hostKind !== 'playground') {
      throw new Error('The deterministic AgentLoop Simulator is available only in the explicit Playground host')
    }
    const simulatorSessionKey = `cordisx.playground.simulator/v1:${metadata.profileId}:${
      plugins.map(plugin => `${plugin.id}@${plugin.source}`).join('|')
    }`
    const simulatorPersistence = runtimeClosures1.createRuntimeSimulatorPersistence(closureScope)
    const playgroundMockAgentLoop = metadata.agentLoopBackend === 'mock'
      ? new PlaygroundMockAgentLoopHost(undefined, simulatorPersistence, simulatorSessionKey)
      : undefined
    const simulatorV4Persistence = runtimeClosures1.createRuntimeSimulatorV4Persistence(closureScope)
    const agentLoopHost = runtimeClosures1.createRuntimeAgentLoopHost(closureScope)
    const agentLoopBroker = new CordisXAgentLoopBroker(agentLoopHost)
    const agentLoopBrokerV2 = runtimeClosures1.createRuntimeAgentLoopBrokerV2(closureScope)
    const playgroundMockAgentLoopV4Transport = playgroundMockAgentLoop === undefined
      ? undefined
      : new PlaygroundMockAgentLoopV4Transport(playgroundMockAgentLoop, simulatorV4Persistence)
    const agentLoopBrokerV4 = runtimeClosures1.createRuntimeAgentLoopBrokerV4(closureScope)
    // One Host-private authority backs all three public Agent/Session services.
    // The environment chooses a transport before plugin activation; no public
    // backend selector, raw bridge, or second app-server connection is exposed.
    const desktopAgentSessionTransport = metadata.hostKind === 'playground'
      ? undefined
      : await CodexDesktopAgentSessionTransport.connect()
    const playgroundAgentSessionPersistence = runtimeClosures1.createRuntimePlaygroundAgentSessionPersistence(
      closureScope,
    )
    const recoveredPlaygroundSessions = playgroundAgentSessionPersistence === undefined
      ? []
      : await playgroundAgentSessionPersistence.load()
    const agentRuntimeConnection: AgentRuntimeConnection = runtimeClosures1.createRuntimeAgentRuntimeConnection(
      closureScope,
    )
    broker.replaceAgentRuntimeConnection(agentRuntimeConnection)
    // Created only by the Playground Host; each use still requires the
    // launcher-owned provenance of one explicitly loaded local artifact.
    const developmentAgentRuntimeAuthorization = metadata.hostKind === 'playground'
      ? broker.createDevelopmentAgentRuntimeAuthorizationAuthority()
      : undefined
    const playgroundScenarioAgentRuntimeRoute = runtimeClosures1.createRuntimePlaygroundScenarioAgentRuntimeRoute(
      closureScope,
    )
    let scenarioSessionOwner = (
      _sessionId: string,
    ): import('@cordisx/protocol/sessions/v1').PluginOwnerIdentity | undefined => undefined
    let scenarioSessionScopeAuthority: PlaygroundScenarioSessionScopeAuthority | undefined
    let activeAgentRuntimeRouteInstance: string | undefined
    let reconcilingAgentRuntimeRoute = false
    let agentRuntimeRouteDisposed = false
    let agentSessionRuntime!: CordisXAgentSessionRuntime
    const pageAdmissionBindings = new PageAdmissionBindingRegistry()
    const managerNavigationController = new HostManagerNavigationController()
    const agentOwnerControllers = new Map<string, PluginController>()
    const agentOwnerKey = (owner: AgentActiveRoute['owner']): string => `${owner.pluginId}\u0000${owner.generation}`
    const agentOwnerForController = (controller: PluginController): AgentActiveRoute['owner'] =>
      runtimeClosures1.createRuntimeAgentOwnerForController(closureScope, controller)
    const controllerForAgentOwner = (owner: AgentActiveRoute['owner']): PluginController | undefined =>
      runtimeClosures1.createRuntimeControllerForAgentOwner(closureScope, owner)
    const actualAgentRuntimeRoute = ():
      | Readonly<{
        readonly scope: AgentRuntimeRouteScope
        readonly owner: AgentActiveRoute['owner']
      }>
      | undefined => runtimeClosures1.createRuntimeActualAgentRuntimeRoute(closureScope)
    const agentRouteScopes: AgentRouteSessionScopeAuthority = runtimeClosures1.createRuntimeAgentRouteScopes(
      closureScope,
    )
    const reconcileAgentRuntimeRoute = (): void =>
      runtimeClosures1.createRuntimeReconcileAgentRuntimeRoute(closureScope)
    await runtimeClosures6.runRuntimeStage1188(closureScope)
    const agentSessionTransport: CordisXPrivateAgentDriver = runtimeClosures1.createRuntimeAgentSessionTransport(
      closureScope,
    )
    const agentDetailNavigator = runtimeClosures1.createRuntimeAgentDetailNavigator(closureScope)
    const agentDetailHistoryIdentity = () => runtimeClosures1.createRuntimeAgentDetailHistoryIdentity(closureScope)
    let pendingAgentDetailReturn:
      | Readonly<{ readonly identity: ReturnType<typeof agentDetailHistoryIdentity>; readonly restore: () => void }>
      | undefined
    const restoreAgentDetailReturn = () => runtimeClosures1.createRuntimeRestoreAgentDetailReturn(closureScope)
    const onAgentDetailHistoryPop = () => restoreAgentDetailReturn()
    window.addEventListener('popstate', onAgentDetailHistoryPop, { capture: true })
    const unsubscribeAgentDetailRouteReturn = routeHistory.subscribe(restoreAgentDetailReturn)
    disposeAgentDetailHistoryReturn = () => {
      pendingAgentDetailReturn = undefined
      window.removeEventListener('popstate', onAgentDetailHistoryPop, { capture: true })
      unsubscribeAgentDetailRouteReturn()
    }
    agentSessionRuntime = runtimeClosures6.createRuntimeAgentSessionRuntime(closureScope)
    scenarioSessionOwner = sessionId => agentSessionRuntime.ownerForSession(sessionId)
    const disposeAgentRouteFences = runtimeClosures1.createRuntimeDisposeAgentRouteFences(closureScope)
    const disposeAgentPermissionFences = runtimeClosures1.createRuntimeDisposeAgentPermissionFences(closureScope)
    const disposeAgentRouteHistory = routeHistory.subscribe(reconcileAgentRuntimeRoute)
    // Host-owned only: no plugin or renderer global receives this broker/adapter.
    const connectorBroker = new CordisXConnectorBroker()
    const agentConnector = connectorBroker.register(createCodexAgentConnector(agentAdapter))
    if (!agentConnector.ok) throw new Error(`Host Agent Connector registration failed: ${agentConnector.error.message}`)
    // The bootstrap closure is selected only by the Host composition before it
    // is bundled. It runs before controller construction/normal plugin
    // activation and is never placed in metadata or a renderer global.
    const developmentPolicySeed = metadata.hostKind === 'playground'
      ? broker.createDevelopmentAgentRuntimePolicySeedAuthority()
      : undefined
    const bootstrapResult = await runtimeClosures1.createRuntimeBootstrapResult(closureScope)
    if (typeof bootstrapResult === 'function') disposeInternalBootstrap = bootstrapResult
    const boundProviderStatuses = bindingPlatformAdapter?.capabilityProviderStatuses() ?? []
    const externalProviderStatuses = runtimeClosures1.createRuntimeExternalProviderStatuses(closureScope)
    const capabilityAvailability = runtimeClosures1.createRuntimeCapabilityAvailability(closureScope)
    const extensionPointDescriptors = new ExtensionPointDescriptorRegistry(CORDISX_EXTENSION_POINT_LOCALE_CATALOGS)
    const legacyExtensionPointPolicies = new BrowserExtensionPointPolicyStore().read()
    const extensionPointBroker = runtimeClosures1.createRuntimeExtensionPointBroker(closureScope)
    const controllers: PluginController[] = plugins.map(item => createController(item, pluginConsole))
    const moduleGenerationOf = (controller: PluginController): string =>
      runtimeClosures1.createRuntimeModuleGenerationOf(closureScope, controller)
    const projectedControllers = (): PluginController[] =>
      runtimeClosures1.createRuntimeProjectedControllers(closureScope)
    const activeControllers = (): PluginController[] => runtimeClosures1.createRuntimeActiveControllers(closureScope)
    const activeController = (id: string, source?: string): PluginController | undefined =>
      runtimeClosures1.createRuntimeActiveController(closureScope, id, source)
    pluginErrorOwners = () =>
      activeControllers().map(controller => ({
        identity: controller.identity,
        principal: controller.principal,
        source: controller.item.source,
      }))
    const requiredBlockReason = (controller: PluginController): string | undefined =>
      runtimeClosures1.createRuntimeRequiredBlockReason(closureScope, controller)
    const registerController = (controller: PluginController, registerAuthority = true): void =>
      runtimeClosures1.createRuntimeRegisterController(closureScope, controller, registerAuthority)
    const unregisterController = (controller: PluginController): void =>
      runtimeClosures1.createRuntimeUnregisterController(closureScope, controller)
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
    let i18nService: CordisXI18nService | undefined
    let i18nFiber: Fiber | undefined
    let platformFiber: Fiber | undefined
    let systemPromptFiber: Fiber | undefined
    let commandFiber: Fiber | undefined
    let pageFiber: Fiber | undefined
    let routeFiber: Fiber | undefined
    let managerContentFiber: Fiber | undefined
    let managerContentConfigAuthority: ManagerContentConfigAuthority | undefined
    let slotFiber: Fiber | undefined
    let settingsFiber: Fiber | undefined
    let configRendererFiber: Fiber | undefined
    let iconThemeFiber: Fiber | undefined
    let visualFiber: Fiber | undefined
    let channelManagerFiber: Fiber | undefined
    let playgroundRoomSimulationBridgeFiber: Fiber | undefined
    let disposeManager: (() => void) | undefined
    let undeclareManagerOutlet: (() => void) | undefined
    let undeclareManagerContentOutlet: (() => void) | undefined
    let unregisterManagerPointCatalog: (() => void) | undefined
    let adapterHandle: CodexAdapterHandle | undefined
    let transientCanvasCoordinator: TransientCanvasCoordinator | undefined
    let disposeI18nSubscription: (() => void) | undefined
    let disposePermissionSubscription: (() => void) | undefined
    let disposeExtensionPointSubscription: (() => void) | undefined
    const disposeExtensionPointCatalogs: (() => void | Promise<void>)[] = []
    const registrySubscriptions: (() => void)[] = []
    const generationTransactions = new Map<string, RendererGenerationTransaction>()
    const finalizedTransactions = new Map<string, RendererGenerationTransaction>()
    const rollbackReceipts = new Map<string, RendererGenerationCleanupObservation>()
    let operation: Promise<unknown> = Promise.resolve()
    let disposed = false
    let notificationsSuppressed = false
    const generationNotificationTrace: { source: string; registryEpoch: number; suppressed: boolean }[] = []
    let settingsProjectionSites = new Set<string>()
    let settingsNavigationProjectionSites = new Map<string, string>()
    let extensionContributionProjectionSites = new Map<string, string>()

    const traceNotification = (source: string, suppressed: boolean): void =>
      runtimeClosures1.createRuntimeTraceNotification(closureScope, source, suppressed)
    const emitListeners = (): void => {
      for (const listener of listeners) listener()
    }

    const rememberRollbackReceipt = (
      receipt: RendererGenerationCleanupObservation,
    ): RendererGenerationCleanupObservation =>
      runtimeClosures1.createRuntimeRememberRollbackReceipt(closureScope, receipt)
    const rememberFinalizedTransaction = (transactionId: string, transaction: RendererGenerationTransaction): void =>
      runtimeClosures1.createRuntimeRememberFinalizedTransaction(closureScope, transactionId, transaction)
    const notifyBatch = (): void => runtimeClosures1.createRuntimeNotifyBatch(closureScope)
    const notify = (source = 'runtime'): void => runtimeClosures1.createRuntimeNotify(closureScope, source)
    const notifyFrom = (source: string): () => void => () => notify(source)
    const drainSuppressedNotifications = async (): Promise<void> =>
      runtimeClosures1.createRuntimeDrainSuppressedNotifications(closureScope)
    const drainBatchSubscriberMicrotasks = async (): Promise<void> =>
      runtimeClosures1.createRuntimeDrainBatchSubscriberMicrotasks(closureScope)

    const settleRegistryProjection = (): Promise<void> =>
      runtimeClosures1.createRuntimeSettleRegistryProjection(closureScope)

    const rememberRegistrations = (pluginId: string): void =>
      runtimeClosures1.createRuntimeRememberRegistrations(closureScope, pluginId)

    const disposeControllerFiber = async (
      controller: PluginController,
      reason: 'owner-disposed' | 'generation-replaced',
    ): Promise<void> => runtimeClosures2.createRuntimeDisposeControllerFiber(closureScope, controller, reason)

    const renewPrincipal = (controller: PluginController): void =>
      runtimeClosures2.createRuntimeRenewPrincipal(closureScope, controller)

    const retirePrincipal = (controller: PluginController, message: string): void =>
      runtimeClosures2.createRuntimeRetirePrincipal(closureScope, controller, message)

    const mountPlugin = async (controller: PluginController): Promise<void> =>
      runtimeClosures2.createRuntimeMountPlugin(closureScope, controller)

    const managerSnapshot = (): ManagerSnapshot => runtimeClosures3.createRuntimeManagerSnapshot(closureScope)

    // The global runtime handle is a plugin-facing/debug surface. Absolute
    // local paths and Host-private build diagnostics are available only to the
    // Manager model installed below.
    const publicSnapshot = (): ManagerSnapshot => projectPublicRuntimeSnapshot(managerSnapshot())

    const setPluginBlocked = (id: string, blocked: boolean): Promise<void> =>
      runtimeClosures3.createRuntimeSetPluginBlocked(closureScope, id, blocked)

    const remountLastGood = async (controller: PluginController): Promise<void> =>
      runtimeClosures3.createRuntimeRemountLastGood(closureScope, controller)

    const applyRestartCandidate = async (controller: PluginController, candidate: ConfigCandidate): Promise<void> =>
      runtimeClosures3.createRuntimeApplyRestartCandidate(closureScope, controller, candidate)

    const updatePluginConfig = (
      id: string,
      expectedRevision: number,
      operations: readonly ConfigMutationOperation[],
    ): Promise<void> => runtimeClosures3.createRuntimeUpdatePluginConfig(closureScope, id, expectedRevision, operations)

    const setPermissionPolicy = (
      id: string,
      capability: CordisXPermissionCapabilityV4,
      policy: CordisXPermissionPolicy,
      scope?: CordisXPermissionScopeV4,
    ): Promise<void> => runtimeClosures3.createRuntimeSetPermissionPolicy(closureScope, id, capability, policy, scope)

    const subscribe = (listener: () => void): () => void =>
      runtimeClosures3.createRuntimeSubscribe(closureScope, listener)

    const setExtensionPointPolicy = (
      source: string,
      pluginId: string,
      pointId: string,
      policy: CordisXPointPolicy,
    ): Promise<void> =>
      runtimeClosures3.createRuntimeSetExtensionPointPolicy(closureScope, source, pluginId, pointId, policy)

    const setExtensionPointPolicies = (
      source: string,
      pluginId: string,
      policies: readonly { readonly pointId: string; readonly policy: CordisXPointPolicy }[],
    ): Promise<void> =>
      runtimeClosures3.createRuntimeSetExtensionPointPolicies(closureScope, source, pluginId, policies)

    const setExtensionPointControlAuthorization = (
      _expectedPolicyRevision: number,
      reference: Readonly<{
        principalHandle: string
        source: string
        pluginId: string
        pointId: string
        claimId: string
        mode: CordisXExtensionPointControlMode
      }>,
      policy: 'inherit' | 'allow' | 'deny',
    ): Promise<void> =>
      runtimeClosures4.createRuntimeSetExtensionPointControlAuthorization(
        closureScope,
        _expectedPolicyRevision,
        reference,
        policy,
      )

    const setExtensionPointControlGroupChoice = (
      expectedPolicyRevision: number,
      choice: ControlledSurfaceGroupChoice,
    ): Promise<void> =>
      runtimeClosures4.createRuntimeSetExtensionPointControlGroupChoice(closureScope, expectedPolicyRevision, choice)

    const permissionAuthorizationPlan = (id: string): CordisXPermissionAuthorizationPlanV1 =>
      runtimeClosures4.createRuntimePermissionAuthorizationPlan(closureScope, id)

    const permissionAuthorizationPlanV2 = (id: string): CordisXPermissionAuthorizationPlanV2 | undefined =>
      runtimeClosures4.createRuntimePermissionAuthorizationPlanV2(closureScope, id)

    const authorizePluginWith = (
      id: string,
      authorize: (controller: PluginController) => Promise<void>,
    ): Promise<void> => runtimeClosures4.createRuntimeAuthorizePluginWith(closureScope, id, authorize)

    const authorizePlugin = (id: string, decision: CordisXPermissionAuthorizationDecisionV1): Promise<void> =>
      runtimeClosures4.createRuntimeAuthorizePlugin(closureScope, id, decision)

    const authorizePluginV2 = (id: string, decision: CordisXPermissionAuthorizationDecisionV2): Promise<void> =>
      runtimeClosures4.createRuntimeAuthorizePluginV2(closureScope, id, decision)

    const authorizePluginV4 = (id: string, decision: CordisXPermissionAuthorizationDecisionV4): Promise<void> =>
      runtimeClosures4.createRuntimeAuthorizePluginV4(closureScope, id, decision)

    const candidateController = (
      handle: PluginGenerationTransitionHandle,
      mutation: RendererPluginMutation,
      pluginId: string,
      module?: CordisXPluginModule,
      moduleFactory?: (console: CordisXPluginConsoleFacade) => CordisXPluginModule,
      modules?: Readonly<Record<string, CordisXPluginModule>>,
    ): { readonly controller: PluginController; readonly registerAuthority: boolean } =>
      runtimeClosures4.createRuntimeCandidateController(
        closureScope,
        handle,
        mutation,
        pluginId,
        module,
        moduleFactory,
        modules,
      )

    const disposeControllers = async (
      items: readonly PluginController[],
      activation: CordisXPluginActivationRecordV1,
      disposedAfter: string[],
    ): Promise<void> => runtimeClosures4.createRuntimeDisposeControllers(closureScope, items, activation, disposedAfter)

    const orderControllersFor = (activation: CordisXPluginActivationRecordV1): void =>
      runtimeClosures4.createRuntimeOrderControllersFor(closureScope, activation)

    const restoreControllers = async (
      items: readonly PluginController[],
      activation: CordisXPluginActivationRecordV1,
      disposedAfter: string[],
      publication?: PluginGenerationPublication,
    ): Promise<void> =>
      runtimeClosures4.createRuntimeRestoreControllers(closureScope, items, activation, disposedAfter, publication)

    const stagePluginMutation = (
      mutation: RendererPluginMutation,
      module?: CordisXPluginModule,
      moduleFactory?: (console: CordisXPluginConsoleFacade) => CordisXPluginModule,
      modules?: Readonly<Record<string, CordisXPluginModule>>,
    ): Promise<PluginGenerationReadinessReceipt> =>
      runtimeClosures4.createRuntimeStagePluginMutation(closureScope, mutation, module, moduleFactory, modules)

    const publishPluginMutation = (transactionId: string): Promise<PluginGenerationPublication> =>
      runtimeClosures4.createRuntimePublishPluginMutation(closureScope, transactionId)

    const completePluginMutation = (transactionId: string): Promise<RendererGenerationCleanupObservation> =>
      runtimeClosures4.createRuntimeCompletePluginMutation(closureScope, transactionId)

    const finalizePluginMutation = (transactionId: string): Promise<void> =>
      runtimeClosures4.createRuntimeFinalizePluginMutation(closureScope, transactionId)

    const commitPluginMutation = async (transactionId: string): Promise<void> =>
      runtimeClosures4.createRuntimeCommitPluginMutation(closureScope, transactionId)

    const rollbackPluginMutation = (transactionId: string): Promise<RendererGenerationCleanupObservation> =>
      runtimeClosures4.createRuntimeRollbackPluginMutation(closureScope, transactionId)

    const recoverPluginMutation = (
      input: RendererGenerationCleanupObservation,
    ): Promise<RendererGenerationCleanupObservation> =>
      runtimeClosures5.createRuntimeRecoverPluginMutation(closureScope, input)

    const adoptRecoveredActivation = (active: CordisXPluginActivationRecordV1, registryEpoch: number): Promise<void> =>
      runtimeClosures5.createRuntimeAdoptRecoveredActivation(closureScope, active, registryEpoch)

    const abortPluginMutation = async (transactionId: string): Promise<void> => {
      await rollbackPluginMutation(transactionId)
    }

    const reloadPluginGeneration = (
      pluginId: string,
      moduleGeneration: string,
      runtimeGeneration: string,
    ): Promise<void> =>
      runtimeClosures5.createRuntimeReloadPluginGeneration(closureScope, pluginId, moduleGeneration, runtimeGeneration)

    const updateLocalDevelopmentStatus = (status: CordisXLocalDevelopmentSnapshot): boolean =>
      runtimeClosures5.createRuntimeUpdateLocalDevelopmentStatus(closureScope, status)

    const adoptPluginBundleSnapshot = (
      snapshot: CordisXPluginBundleManagerSnapshotV1,
    ): Readonly<{ revision: number; pluginRevision: number }> =>
      runtimeClosures5.createRuntimeAdoptPluginBundleSnapshot(closureScope, snapshot)

    const dispose = async (): Promise<void> => runtimeClosures5.createRuntimeDispose(closureScope)

    const handle: CordisXRuntimeHandle = runtimeClosures5.createRuntimeHandle(closureScope)
    const managerModel: ManagerModel = runtimeClosures5.createRuntimeManagerModel(closureScope)
    await runtimeClosures6.runRuntimeStage4077(closureScope)

    globalThis.__cordisxRuntime = handle
    document.documentElement.dataset.cordisxReady = 'true'
    const activeIds = controllers.filter(controller => controller.status === 'active').map(controller =>
      controller.item.id
    )
    console.info(`[cordisx] mounted ${activeIds.length} plugin(s): ${activeIds.join(', ')}`)
    return handle
  } catch (error) {
    certifiedPermissionChannel?.dispose()
    certifiedPermissionChannel = undefined
    disposeAgentDetailHistoryReturn()
    routeHistory.dispose()
    if (ownsSharedReactRuntime) sharedReactRuntime?.dispose()
    else disposePreparedSharedReactRuntime?.()
    disposePreparedSharedReactRuntime = undefined
    sharedReactRuntime = undefined
    ownsSharedReactRuntime = false
    throw error
  }
}
