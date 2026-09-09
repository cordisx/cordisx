import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import { CORDISX_PLATFORM_CAPABILITIES, CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../contracts.js'
import type {
  CordisXBrowserPlugin,
  CordisXCapabilityScope,
  CordisXCommandReference,
  CordisXExtensionPointControlMode,
  CordisXLocalizedText,
  CordisXManagerSettingsNavigationItem,
  CordisXManagerSettingsTabItem,
  CordisXPermissionAuthorizationDecisionV1,
  CordisXPermissionAuthorizationPlanV1,
  CordisXPermissionPolicy,
  CordisXPlatformCapability,
  CordisXPluginActivationRecordV1,
  CordisXPluginBundleLifecycleOperationV1,
  CordisXPluginBundleLifecycleResultV1,
  CordisXPluginBundleManagerSnapshotV1,
  CordisXPluginConsoleFacade,
  CordisXPluginIdentity,
  CordisXPluginLifecycleOperationV1,
  CordisXPluginLifecycleResultV1,
  CordisXPluginManifestV1,
  CordisXPluginManifestV4,
  CordisXPluginManifestV5,
  CordisXPluginManifestV6,
  CordisXPluginManifestV7,
  CordisXPluginManifestV8,
  CordisXPluginModule,
  CordisXPluginPackageManifestV1,
  CordisXPointPolicy,
  CordisXRouteReference,
} from '../contracts.js'
import type { CordisXLocalDevelopmentSnapshot } from '../local-development-contracts.js'
import {
  type CordisXPersistedPermissionPolicyRecord,
  isPermissionPolicyRecordV2,
  isPermissionPolicyRecordV3,
  isPermissionPolicyRecordV4,
} from '../permission-persistence.js'
import type { HomeConfigIconThemePreference } from '../config/home-config.js'
import type {
  CordisXPermissionAuthorizationDecisionV2,
  CordisXPermissionAuthorizationDecisionV4,
  CordisXPermissionAuthorizationPlanV2,
  CordisXPermissionAuthorizationPlanV4,
  CordisXPermissionCapabilityV4,
  CordisXPermissionScopeV4,
} from '../permission-contracts.js'
import { type CodexAdapterHandle, installCodexAdapter, installPlaygroundAdapter } from './adapter.js'
import { UnavailableCodexHostAdapter } from '../adapters/codex-agent.js'
import { createCodexAgentConnector } from '../adapters/codex-agent-connector.js'
import { CordisXHostAgentRuntime, CordisXSystemPromptService } from './agent.js'
import { PageAdmissionBindingRegistry } from './page-admission-lifecycle.js'
import { createPageComposerAdapter } from './page-admission-adapter.js'
import {
  CordisXAgentAdmissionBootstrapReservationService,
  CordisXAgentAdmissionBootstrapRoomReservationService,
  CordisXAgentAdmissionBootstrapRoomTargetService,
  CordisXAgentAdmissionBootstrapRouteDeclarationService,
  CordisXAgentAdmissionBootstrapRouteReservationService,
  CordisXAgentAdmissionBootstrapTargetService,
  CordisXAgentAdmissionReservationService,
  CordisXAgentAdmissionTargetOriginService,
  CordisXAgentAdmissionTargetReservationService,
  CordisXAgentDetailNavigationService,
  CordisXAgentPageAdmissionReservationService,
  CordisXAgentPageAdmissionRouteDeclarationService,
  CordisXAgentPageAdmissionRouteReservationService,
  CordisXAgentPageAdmissionTargetService,
  CordisXAgentPageFreshRoomNavigationService,
  CordisXAgentRegistryServiceV1,
  CordisXAgentSessionDetailReferenceService,
  CordisXAgentSessionRuntime,
  CordisXApprovalServiceV1,
  type CordisXPrivateAgentDriver,
  CordisXSessionRegistryServiceV1,
} from './agent-session-runtime.js'
import {
  CodexDesktopAgentSessionTransport,
  UnavailableAgentSessionTransport,
} from './codex-desktop-agent-session-transport.js'
import { DeterministicAgentSessionTransport } from './deterministic-agent-session-transport.js'
import { PlaygroundScenarioSessionScopeAuthority } from './playground-scenario-session-scope.js'
import { projectPlaygroundAgentSessions } from './playground-agent-session-projection.js'
import {
  type AgentActiveRoute,
  AgentRouteSessionScopeAuthority,
  type AgentRuntimePermissionDeclaration,
} from './agent-route-session-scope.js'
import {
  type CordisXBoundConnectorClient,
  type CordisXConnectorAuthorization,
  CordisXConnectorBroker,
  type CordisXConnectorClientCapability,
  type CordisXConnectorRegistrationIdentity,
} from './connectors.js'
import {
  type ManagerModel,
  type ManagerPluginSnapshot,
  type ManagerPluginStatus,
  type ManagerSettingsNavigationItemSnapshot,
  type ManagerSettingsTabSnapshot,
  type ManagerSnapshot,
} from './manager.js'
import { installReactCordisXManager } from './manager/install.js'
import { HostManagerNavigationController } from './manager/navigation-controller.js'
import { selectPluginReadme } from './readme.js'
import { CordisXCommandService } from './commands.js'
import { CordisXI18nService } from './i18n.js'
import { CordisXVisualService } from './visuals.js'
import { CordisXManagerContentNavigationService, CordisXPageService, CordisXRouteService } from './navigation.js'
import { BrowserRouteHistoryAdapter, CodexRouterHistoryAdapter } from './codex-router-history.js'
import type { SelectedNavigationActionRegistry } from './selected-navigation-actions.js'
import {
  HostAgentTaskDetailsNavigator,
  navigateHostTaskDetailsSameDocument,
} from './host-ui/AgentTaskDetailsNavigator.js'
import {
  type AgentRuntimeConnection,
  type AgentRuntimeRouteScope,
  BrowserPermissionAuthorizationPromptV2,
  BrowserPermissionPolicyStore,
  BrowserPermissionPrompt,
  CordisXPlatformService,
  MemoryPermissionPolicyStore,
  normalizePluginManifest,
  PermissionBroker,
  type PlatformPermissionSnapshot,
} from './platform.js'
import { CORDISX_PLUGIN_GENERATION, CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE, CordisXSlotService } from './service.js'
import type { SurfaceContributionSnapshot } from './surfaces.js'
import type { ControlledSurfaceGroupChoice } from './controlled-surfaces.js'
import {
  BrowserExtensionPointPolicyStore,
  buildExtensionPointRuntimeSnapshot,
  CORDISX_EXTENSION_POINT_LOCALE_CATALOGS,
  CORDISX_MANAGER_EXTENSION_POINT_CATALOG,
  ExtensionPointDescriptorRegistry,
  ExtensionPointPolicyBroker,
  MemoryExtensionPointPolicyStore,
} from './extension-points.js'
import { projectPublicRuntimeSnapshot } from './public-runtime-snapshot.js'
import { sortManagerSettingsNavigationItems } from './manager-settings-navigation.js'
import { BindingPlatformAdapter } from './provider-binding.js'
import {
  BindingAgentLoopHost,
  type CordisXAgentLoopAuthorizationRequestV4,
  CordisXAgentLoopBroker,
  type CordisXBoundAgentLoopClientOptions,
  UnavailableAgentLoopHost,
} from './agent-loop.js'
import { combineAgentLoopClients, CordisXAgentLoopBrokerV2 } from './agent-loop-v2.js'
import { adaptAgentLoopV3 } from './agent-loop-v3-compat.js'
import { CordisXAgentLoopBrokerV4 } from './agent-loop-v4.js'
import {
  PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE,
  PlaygroundMockAgentLoopHost,
  type PlaygroundMockAgentLoopSnapshot,
  PlaygroundMockAgentLoopV4Transport,
} from './playground-mock-agent-loop.js'
import {
  CordisXPlaygroundRoomSimulationBridgeService,
  PlaygroundRoomSimulationBridgeRegistry,
  type PlaygroundRoomSimulationForwardingClient,
} from './playground-room-simulation-bridge.js'
import type { CompatibleBoundAgentLoopClient } from '../agent-loop-contracts.js'
import {
  BrowserConfigBridge,
  type ConfigCandidate,
  type ConfigMutationOperation,
  ConfigRendererRegistry,
  CordisXConfigRendererService,
  CordisXPluginSettingsService,
  moduleConfigApplies,
  moduleConfigSchema,
  PluginConfigurationRegistry,
} from './configuration.js'
import { ManagerContentConfigAuthority } from './manager-content-config.js'
import { BrowserServiceConfigBridge } from './service-config-binding.js'
import { BrowserChannelCredentialBridge } from './channel-credential-binding.js'
import { BrowserChannelActionsBridge } from './channel-actions-binding.js'
import type {
  HostServiceConfigDescriptor,
  HostServiceConfigMutation,
  HostServiceConfigMutationResult,
} from '../launcher/service-config.js'
import { BindingPermissionPolicyStore } from './permission-binding.js'
import { CORDISX_PERMISSION_LOCALE_CATALOGS } from '../permission-locales.js'
import { pluginBrandIconDataUrl } from './plugin-branding.js'
import { BrowserPluginLifecycleBridge } from './plugin-lifecycle-binding.js'
import {
  CapabilityAvailabilityRegistry,
  CORDISX_CAPABILITY_AVAILABILITY_LOCALE_CATALOGS,
  externalProviderCapabilityProviders,
  hostLocalCapabilityProviders,
  platformAdapterCapabilityProvider,
} from './capability-availability.js'
import { CORDISX_PLUGIN_PRINCIPAL, PluginConsoleAspect, type PluginPrincipalToken } from './plugin-console.js'
import {
  CORDISX_GENERATION_VISIBILITY_COORDINATOR,
  GenerationVisibilityCoordinator,
  type PluginGenerationPublication,
  type PluginGenerationReadinessReceipt,
  type PluginGenerationTransitionHandle,
  type PluginGenerationView,
} from './generation-visibility.js'
import { type ChannelManagerProjectionV1, CordisXChannelManagerService } from './channel-manager.js'
import { installSharedReactRuntime } from './react-runtime.js'
import { IconThemeRegistry } from './icon-theme-registry.js'
import { CordisXIconThemeService } from './icon-theme-service.js'
import { bindIconThemeRegistry } from './icons.js'
import { BrowserIconThemePreferenceBridge } from './icon-theme-preference-binding.js'
import { reconcileIconThemePreference, selectAndPersistIconTheme } from './icon-theme-selection.js'
import {
  type CertifiedPermissionDocumentChannel,
  createCertifiedPermissionDocumentChannel,
} from './certified-permission-channel.js'
import { createCordisXHostDomRootDefinitions, HostDomAuthority } from './host-dom.js'
import {
  createBrowserHostDomWorkerEnvironment,
  createHostDomWorkerBoundary,
  type HostDomWorkerBoundary,
  type HostDomWorkerEnvironment,
} from './host-dom-worker.js'
import { TransientCanvasCoordinator } from './transient-canvas.js'
import { BrowserOwnerDocumentBridge, CordisXOwnerDocumentBroker } from './owner-documents.js'
import { CordisXEntityRegistryServiceV1, type EntityPrincipalBinding } from './entities.js'
import type { EntityRegistry } from '@cordisx/protocol/entities/v1'
import { BrowserPlaygroundAgentSessionPersistence } from './playground-agent-session-persistence.js'
import type { PlaygroundSessionScenarioCatalogV1 } from '../playground/session-scenario-catalog.js'
import type { CordisXOwnerDocumentsV1 } from '../durable-document-contracts.js'
import type { CordisXExternalProviderAvailabilityStatus } from '../capability-availability-contracts.js'
import type { CordisXExtensionPointPolicyRecordV1 } from '../contracts.js'
import type { CordisXPersistedSession } from './agent-session-runtime.js'
import type { SharedReactRuntime } from './react-runtime.js'
import type {
  BLOCKED_PLUGINS_KEY,
  cloneRendererValue,
  committedActivation,
  controllerHasRuntimeModule,
  CordisXInternalRendererBootstrap,
  CordisXRuntimeHandle,
  CordisXRuntimeMetadata,
  CordisXStartOptions,
  createController,
  createRuntimeClosureScope,
  errorMessage,
  isExplicitLocalDevelopmentArtifact,
  localizedPluginText,
  manifestUsesHostDom,
  manifestUsesTransientCanvas,
  MAX_ROLLBACK_RECEIPTS,
  PluginController,
  pluginDescriptionFields,
  pluginFromModule,
  pluginInject,
  pluginPresentation,
  pluginReadmeSummary,
  readBlockedPlugins,
  RendererGenerationCleanupObservation,
  RendererGenerationTransaction,
  RendererPluginMutation,
  RuntimeBrowserPlugin,
  topologicalActivationOrder,
  writeBlockedPlugins,
} from './runtime-shared.js'

export interface RuntimeClosureScope {
  readonly abortPluginMutation: () => (transactionId: string) => Promise<void>
  activeAgentRuntimeRouteInstance: string | undefined
  readonly activeController: () => (id: string, source?: string) => PluginController | undefined
  readonly activeControllers: () => () => PluginController[]
  readonly actualAgentRuntimeRoute: () => () =>
    | Readonly<{ readonly scope: AgentRuntimeRouteScope; readonly owner: AgentActiveRoute['owner'] }>
    | undefined
  adapterHandle: CodexAdapterHandle | undefined
  agentConversationShellFiber: Fiber | undefined
  readonly adoptPluginBundleSnapshot: () => (
    snapshot: CordisXPluginBundleManagerSnapshotV1,
  ) => Readonly<{ revision: number; pluginRevision: number }>
  readonly adoptRecoveredActivation: () => (
    active: CordisXPluginActivationRecordV1,
    registryEpoch: number,
  ) => Promise<void>
  readonly agentAdapter: () => UnavailableCodexHostAdapter
  readonly agentDetailHistoryIdentity: () => () => Readonly<{ index?: number; key?: string; path: string }>
  readonly agentDetailNavigator: () => HostAgentTaskDetailsNavigator
  readonly agentLoopBroker: () => CordisXAgentLoopBroker
  readonly agentLoopBrokerV2: () => CordisXAgentLoopBrokerV2
  readonly agentLoopBrokerV4: () => CordisXAgentLoopBrokerV4
  readonly agentLoopHost: () => PlaygroundMockAgentLoopHost | UnavailableAgentLoopHost | BindingAgentLoopHost
  readonly agentOwnerControllers: () => Map<string, PluginController>
  readonly agentOwnerForController: () => (controller: PluginController) => AgentActiveRoute['owner']
  readonly agentOwnerKey: () => (owner: AgentActiveRoute['owner']) => string
  readonly agentRouteScopes: () => AgentRouteSessionScopeAuthority
  readonly agentRuntime: () => CordisXHostAgentRuntime
  readonly agentRuntimeConnection: () => Readonly<{ connectionId: string; generation: number }>
  agentRuntimeRouteDisposed: boolean
  agentSessionRuntime: CordisXAgentSessionRuntime
  readonly agentSessionTransport: () => CordisXPrivateAgentDriver
  readonly applyRestartCandidate: () => (controller: PluginController, candidate: ConfigCandidate) => Promise<void>
  readonly authorizePlugin: () => (id: string, decision: CordisXPermissionAuthorizationDecisionV1) => Promise<void>
  readonly authorizePluginV2: () => (id: string, decision: CordisXPermissionAuthorizationDecisionV2) => Promise<void>
  readonly authorizePluginV4: () => (id: string, decision: CordisXPermissionAuthorizationDecisionV4) => Promise<void>
  readonly authorizePluginWith: () => (
    id: string,
    authorize: (controller: PluginController) => Promise<void>,
  ) => Promise<void>
  bindingPlatformAdapter: BindingPlatformAdapter | undefined
  readonly blockedPlugins: () => Set<string>
  readonly boundProviderStatuses: () => readonly CordisXExternalProviderAvailabilityStatus[]
  readonly broker: () => PermissionBroker
  readonly browserHostedPlayground: () => boolean
  readonly candidateController: () => (
    handle: PluginGenerationTransitionHandle,
    mutation: RendererPluginMutation,
    pluginId: string,
    module?: CordisXPluginModule,
    moduleFactory?: (console: CordisXPluginConsoleFacade) => CordisXPluginModule,
    modules?: Readonly<Record<string, CordisXPluginModule>>,
  ) => { readonly controller: PluginController; readonly registerAuthority: boolean }
  readonly capabilityAvailability: () => CapabilityAvailabilityRegistry
  certifiedPermissionChannel: CertifiedPermissionDocumentChannel | undefined
  readonly channelActionsBridge: () => BrowserChannelActionsBridge | undefined
  readonly channelCredentialBridge: () => BrowserChannelCredentialBridge | undefined
  channelManagerFiber: Fiber | undefined
  commandFiber: Fiber | undefined
  commandService: CordisXCommandService | undefined
  readonly commitPluginMutation: () => (transactionId: string) => Promise<void>
  readonly completePluginMutation: () => (transactionId: string) => Promise<RendererGenerationCleanupObservation>
  readonly configBridge: () => BrowserConfigBridge | undefined
  configRendererFiber: Fiber | undefined
  readonly configRenderers: () => ConfigRendererRegistry
  readonly configuration: () => PluginConfigurationRegistry
  readonly connectorBroker: () => CordisXConnectorBroker
  consoleAffectedPluginIds: readonly string[]
  readonly controllerForAgentOwner: () => (owner: AgentActiveRoute['owner']) => PluginController | undefined
  readonly controllers: () => PluginController[]
  ctx: Context
  currentActivation: CordisXPluginActivationRecordV1
  currentPluginBundles: CordisXPluginBundleManagerSnapshotV1 | undefined
  readonly desktopAgentSessionTransport: () => CodexDesktopAgentSessionTransport | undefined
  readonly developmentPolicySeed: () => object | undefined
  readonly disconnectPluginConsoleVisibility: () => () => void
  readonly dispose: () => () => Promise<void>
  disposeAgentDetailHistoryReturn: () => void
  readonly disposeAgentPermissionFences: () => () => void
  readonly disposeAgentRouteFences: () => () => void
  readonly disposeAgentRouteHistory: () => () => void
  readonly disposeControllerFiber: () => (
    controller: PluginController,
    reason: 'owner-disposed' | 'generation-replaced',
  ) => Promise<void>
  readonly disposeControllers: () => (
    items: readonly PluginController[],
    activation: CordisXPluginActivationRecordV1,
    disposedAfter: string[],
  ) => Promise<void>
  readonly disposeExtensionPointCatalogs: () => (() => void | Promise<void>)[]
  disposeExtensionPointSubscription: (() => void) | undefined
  disposeI18nSubscription: (() => void) | undefined
  disposeIconThemePreferenceSubscription: (() => void) | undefined
  disposeInternalBootstrap: (() => void | Promise<void>) | undefined
  disposeManager: (() => void) | undefined
  disposePageAdmissionActivation: () => void
  disposePermissionSubscription: (() => void) | undefined
  disposePreparedSharedReactRuntime: (() => void) | undefined
  disposed: boolean
  readonly drainBatchSubscriberMicrotasks: () => () => Promise<void>
  readonly drainSuppressedNotifications: () => () => Promise<void>
  readonly emitListeners: () => () => void
  readonly entityPrincipalBindings: () => Map<string, EntityPrincipalBinding>
  extensionContributionProjectionSites: Map<string, string>
  readonly extensionPointBroker: () => ExtensionPointPolicyBroker
  readonly extensionPointDescriptors: () => ExtensionPointDescriptorRegistry
  readonly externalProviderStatuses: () => readonly CordisXExternalProviderAvailabilityStatus[] | {
    providerId: string
    displayName: string
    state: 'unavailable'
  }[]
  readonly finalizePluginMutation: () => (transactionId: string) => Promise<void>
  readonly finalizedTransactions: () => Map<string, RendererGenerationTransaction>
  readonly generation: () => string
  readonly generationNotificationTrace: () => { source: string; registryEpoch: number; suppressed: boolean }[]
  readonly generationTransactions: () => Map<string, RendererGenerationTransaction>
  readonly generationVisibility: () => GenerationVisibilityCoordinator
  readonly handle: () => CordisXRuntimeHandle
  readonly hostDomAuthority: () => HostDomAuthority
  hostDomWorkerEnvironment: HostDomWorkerEnvironment | undefined
  i18nFiber: Fiber | undefined
  i18nService: CordisXI18nService | undefined
  iconThemeFiber: Fiber | undefined
  readonly iconThemePreferenceBridge: () => BrowserIconThemePreferenceBridge | undefined
  readonly iconThemeRegistry: () => IconThemeRegistry
  readonly internalBootstrap: () => CordisXInternalRendererBootstrap | undefined
  readonly knownRegistrations: () => Map<string, readonly SurfaceContributionSnapshot[]>
  readonly legacyExtensionPointPolicies: () => readonly CordisXExtensionPointPolicyRecordV1[]
  readonly lifecycleBridge: () => BrowserPluginLifecycleBridge | undefined
  readonly listeners: () => Set<() => void>
  readonly localDevelopment: () => Map<string, CordisXLocalDevelopmentSnapshot>
  managerContentConfigAuthority: ManagerContentConfigAuthority | undefined
  managerContentFiber: Fiber | undefined
  readonly managerModel: () => ManagerModel
  readonly managerNavigationController: () => HostManagerNavigationController
  readonly managerSnapshot: () => () => ManagerSnapshot
  readonly metadata: () => CordisXRuntimeMetadata
  readonly moduleGenerationOf: () => (controller: PluginController) => string
  readonly mountPlugin: () => (controller: PluginController) => Promise<void>
  notificationsSuppressed: boolean
  readonly notify: () => (source?: string) => void
  readonly notifyBatch: () => () => void
  readonly notifyFrom: () => (source: string) => () => void
  operation: Promise<unknown>
  readonly orderControllersFor: () => (activation: CordisXPluginActivationRecordV1) => void
  readonly ownerDocumentBridge: () => BrowserOwnerDocumentBridge | undefined
  readonly ownerDocumentBroker: () => CordisXOwnerDocumentBroker
  ownsSharedReactRuntime: boolean
  readonly pageAdmissionBindings: () => PageAdmissionBindingRegistry
  readonly selectedNavigationActions: () => SelectedNavigationActionRegistry
  pageFiber: Fiber | undefined
  pageService: CordisXPageService | undefined
  pendingAgentDetailReturn:
    | Readonly<
      {
        readonly identity: ReturnType<() => Readonly<{ index?: number; key?: string; path: string }>>
        readonly restore: () => void
      }
    >
    | undefined
  readonly permissionAuthorizationPlan: () => (id: string) => CordisXPermissionAuthorizationPlanV1
  readonly permissionAuthorizationPlanV2: () => (id: string) => CordisXPermissionAuthorizationPlanV2 | undefined
  readonly permissionStore: () =>
    | MemoryPermissionPolicyStore
    | BrowserPermissionPolicyStore
    | BindingPermissionPolicyStore
  readonly platformAdapter: () => UnavailableCodexHostAdapter | BindingPlatformAdapter
  platformFiber: Fiber | undefined
  readonly playgroundAgentSessionPersistence: () => BrowserPlaygroundAgentSessionPersistence | undefined
  readonly playgroundMockAgentLoop: () => PlaygroundMockAgentLoopHost | undefined
  readonly playgroundMockAgentLoopV4Transport: () => PlaygroundMockAgentLoopV4Transport | undefined
  playgroundRoomSimulationBridgeFiber: Fiber | undefined
  readonly playgroundRoomSimulationBridgeRegistry: () => PlaygroundRoomSimulationBridgeRegistry | undefined
  readonly playgroundScenarioAgentRuntimeRoute: () => object | undefined
  readonly pluginConsole: () => PluginConsoleAspect
  pluginErrorOwners: () => readonly {
    readonly identity: CordisXPluginIdentity
    readonly principal: PluginPrincipalToken
    readonly source: string
  }[]
  readonly projectedControllers: () => () => PluginController[]
  readonly publicSnapshot: () => () => ManagerSnapshot
  readonly publishPluginMutation: () => (transactionId: string) => Promise<PluginGenerationPublication>
  readonly reconcileAgentRuntimeRoute: () => () => void
  reconcilingAgentRuntimeRoute: boolean
  readonly recordUnknownError: () => (event: Event) => void
  readonly recoverPluginMutation: () => (
    input: RendererGenerationCleanupObservation,
  ) => Promise<RendererGenerationCleanupObservation>
  readonly recoveredPlaygroundSessions: () => readonly CordisXPersistedSession[]
  readonly registerController: () => (controller: PluginController, registerAuthority?: boolean) => void
  readonly registerEntityBindings: () => (bindings: CordisXRuntimeMetadata['ownerDocumentBindings']) => void
  readonly registrySubscriptions: () => (() => void)[]
  readonly reloadPluginGeneration: () => (
    pluginId: string,
    moduleGeneration: string,
    runtimeGeneration: string,
  ) => Promise<void>
  readonly rememberFinalizedTransaction: () => (
    transactionId: string,
    transaction: RendererGenerationTransaction,
  ) => void
  readonly rememberRegistrations: () => (pluginId: string) => void
  readonly rememberRollbackReceipt: () => (
    receipt: RendererGenerationCleanupObservation,
  ) => RendererGenerationCleanupObservation
  readonly remountLastGood: () => (controller: PluginController) => Promise<void>
  readonly renewPrincipal: () => (controller: PluginController) => void
  readonly requiredBlockReason: () => (controller: PluginController) => string | undefined
  readonly restoreControllers: () => (
    items: readonly PluginController[],
    activation: CordisXPluginActivationRecordV1,
    disposedAfter: string[],
    publication?: PluginGenerationPublication,
  ) => Promise<void>
  readonly retirePrincipal: () => (controller: PluginController, message: string) => void
  readonly rollbackPluginMutation: () => (transactionId: string) => Promise<RendererGenerationCleanupObservation>
  readonly rollbackReceipts: () => Map<string, RendererGenerationCleanupObservation>
  routeFiber: Fiber | undefined
  readonly routeHistory: () => BrowserRouteHistoryAdapter | CodexRouterHistoryAdapter
  routeService: CordisXRouteService | undefined
  scenarioSessionOwner: (_sessionId: string) => import('@cordisx/protocol/sessions/v1').PluginOwnerIdentity | undefined
  scenarioSessionScopeAuthority: PlaygroundScenarioSessionScopeAuthority | undefined
  readonly serviceConfigBridge: () => BrowserServiceConfigBridge | undefined
  readonly setExtensionPointControlAuthorization: () => (
    _expectedPolicyRevision: number,
    reference: Readonly<
      {
        principalHandle: string
        source: string
        pluginId: string
        pointId: string
        claimId: string
        mode: CordisXExtensionPointControlMode
      }
    >,
    policy: 'inherit' | 'allow' | 'deny',
  ) => Promise<void>
  readonly setExtensionPointControlGroupChoice: () => (
    expectedPolicyRevision: number,
    choice: ControlledSurfaceGroupChoice,
  ) => Promise<void>
  readonly setExtensionPointPolicies: () => (
    source: string,
    pluginId: string,
    policies: readonly { readonly pointId: string; readonly policy: CordisXPointPolicy }[],
  ) => Promise<void>
  readonly setExtensionPointPolicy: () => (
    source: string,
    pluginId: string,
    pointId: string,
    policy: CordisXPointPolicy,
  ) => Promise<void>
  readonly setPermissionPolicy: () => (
    id: string,
    capability: CordisXPermissionCapabilityV4 | 'ui.extension-points.interact' | 'usage.read',
    policy: CordisXPermissionPolicy,
    scope?: CordisXPermissionScopeV4,
  ) => Promise<void>
  readonly setPluginBlocked: () => (id: string, blocked: boolean) => Promise<void>
  settingsFiber: Fiber | undefined
  settingsNavigationProjectionSites: Map<string, string>
  settingsProjectionSites: Set<string>
  readonly settleRegistryProjection: () => () => Promise<void>
  sharedReactRuntime: SharedReactRuntime | undefined
  readonly simulatorSessionKey: () => string
  slotFiber: Fiber | undefined
  slotService: CordisXSlotService | undefined
  readonly stagePluginMutation: () => (
    mutation: RendererPluginMutation,
    module?: CordisXPluginModule,
    moduleFactory?: (console: CordisXPluginConsoleFacade) => CordisXPluginModule,
    modules?: Readonly<Record<string, CordisXPluginModule>>,
  ) => Promise<PluginGenerationReadinessReceipt>
  readonly subscribe: () => (listener: () => void) => () => void
  systemPromptFiber: Fiber | undefined
  readonly traceNotification: () => (source: string, suppressed: boolean) => void
  transientCanvasCoordinator: TransientCanvasCoordinator | undefined
  readonly unbindIconThemeRegistry: () => () => void
  undeclareManagerContentOutlet: (() => void) | undefined
  undeclareManagerOutlet: (() => void) | undefined
  readonly unregisterController: () => (controller: PluginController) => void
  unregisterManagerPointCatalog: (() => void) | undefined
  readonly updateLocalDevelopmentStatus: () => (status: CordisXLocalDevelopmentSnapshot) => boolean
  readonly updatePluginConfig: () => (
    id: string,
    expectedRevision: number,
    operations: readonly ConfigMutationOperation[],
  ) => Promise<void>
  visualFiber: Fiber | undefined
}
