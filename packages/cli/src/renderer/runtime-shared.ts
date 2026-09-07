import type { CordisXPluginManifestV10 } from '../extension-point-interaction-permissions.js'
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
  CordisXPluginManifestV9,
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

export const BLOCKED_PLUGINS_KEY = 'cordisx.manager.blockedPlugins.v1'

export const MAX_ROLLBACK_RECEIPTS = 64

export function cloneRendererValue<Value>(value: Value): Value {
  return typeof globalThis.structuredClone === 'function'
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as Value
}

export interface CordisXRuntimeMetadata {
  readonly version: string
  readonly workspaceCwd: string
  readonly providers: readonly { readonly id: string; readonly displayName: string }[]
  readonly profileId: string
  readonly appId?: string
  readonly iconThemePreference?: HomeConfigIconThemePreference
  readonly iconThemePreferenceBridgeToken?: string
  readonly permissionPolicies?: readonly CordisXPersistedPermissionPolicyRecord[]
  readonly permissionBridgeToken?: string
  readonly providerBridgeToken?: string
  readonly agentHistoryBridgeToken?: string
  readonly configBridgeToken?: string
  readonly playgroundAgentSessionStoreToken?: string
  readonly ownerDocumentBindings?: readonly {
    readonly source: string
    readonly pluginId: string
    readonly moduleGeneration: string
    readonly installationId?: string
    readonly pluginGeneration?: number
    readonly token: string
  }[]
  readonly serviceConfigBridgeToken?: string
  readonly channelCredentialBridgeToken?: string
  readonly channelActionsBridgeToken?: string
  readonly pluginLifecycleBridgeToken?: string
  readonly pluginBundleSnapshot?: CordisXPluginBundleManagerSnapshotV1
  /** Vite-only targeted reload. The callback never enters plugin Contexts. */
  readonly developmentReloadPlugin?: (pluginId: string) => Promise<void>
  /** Launcher-only RemoteObject handoff nonce; never an authorization payload. */
  readonly certifiedPermissionChannelToken?: string
  readonly pluginActivation?: CordisXPluginActivationRecordV1
  readonly initialRegistryEpoch?: number
  readonly generation?: string
  readonly channelManager?: ChannelManagerProjectionV1
  /** Development-only host with explicit semantic seats and no Codex DOM probes. */
  readonly hostKind?: 'codex' | 'playground'
  /** Debug-only deterministic service; accepted only by the explicit Playground host. */
  readonly agentLoopBackend?: 'mock'
  /** Host-validated declarative catalog; never accepted from a plugin Context. */
  readonly playgroundSessionScenarios?: PlaygroundSessionScenarioCatalogV1
}

export interface RuntimeBrowserPlugin extends CordisXBrowserPlugin {
  /** Launcher-derived opaque generation for a verified bundled artifact. */
  readonly artifactGeneration?: string
  /** Source data for one manifest-v5/v6/v7 plugin isolated from the Host renderer. */
  readonly isolatedArtifactSource?: string
  readonly development?: CordisXLocalDevelopmentSnapshot
}

export function isExplicitLocalDevelopmentArtifact(item: RuntimeBrowserPlugin): boolean {
  const development = item.development
  return development?.origin === 'local-dev'
    && development.state === 'ready'
    && development.pluginId === item.id
    && development.sourcePath.trim().length > 0
    && (item.package !== undefined || item.artifactGeneration !== undefined)
    && item.source.startsWith('file:///cordisx-local-dev/')
}

export type CordisXInternalRendererBootstrap = (
  host: Readonly<{
    readonly connectors: CordisXConnectorBroker
    /** Development-only setup seam; never injected into plugin Contexts. */
    readonly agentRuntimePolicies?: Readonly<{
      seed(
        identity: CordisXPluginIdentity,
        entries: readonly Readonly<{
          capability: import('@cordisx/protocol/agents/v1').AgentRuntimeCapability
          sessionIds: readonly [string, ...string[]]
          policy: 'ask' | 'allow-persistent' | 'deny-persistent'
        }>[],
      ): Promise<void>
    }>
  }>,
) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>

export interface PluginController {
  item: RuntimeBrowserPlugin
  readonly identity: CordisXPluginIdentity
  manifest:
    | CordisXPluginManifestV1
    | CordisXPluginManifestV4
    | CordisXPluginManifestV5
    | CordisXPluginManifestV6
    | CordisXPluginManifestV7
    | CordisXPluginManifestV8
    | CordisXPluginManifestV9
    | CordisXPluginManifestV10
  principal: PluginPrincipalToken
  activation: number
  principalLive: boolean
  unregisterPermissions?: () => void
  unregisterExtensionPoints?: () => void
  unregisterConnector?: () => void | Promise<void>
  unregisterAgentLoop?: () => void | Promise<void>
  unregisterDocuments?: () => void | Promise<void>
  entityRegistryFiber?: Fiber
  agentRegistryFiber?: Fiber
  sessionRegistryFiber?: Fiber
  agentSessionDetailReferenceFiber?: Fiber
  agentDetailNavigationFiber?: Fiber
  approvalServiceFiber?: Fiber
  agentAdmissionReservationFiber?: Fiber
  agentAdmissionTargetOriginFiber?: Fiber
  agentAdmissionTargetReservationFiber?: Fiber
  agentAdmissionBootstrapTargetFiber?: Fiber
  agentAdmissionBootstrapReservationFiber?: Fiber
  agentAdmissionBootstrapRoomTargetFiber?: Fiber
  agentAdmissionBootstrapRoomReservationFiber?: Fiber
  agentAdmissionBootstrapRouteDeclarationFiber?: Fiber
  agentAdmissionBootstrapRouteReservationFiber?: Fiber
  agentPageAdmissionTargetFiber?: Fiber
  agentPageAdmissionReservationFiber?: Fiber
  agentPageAdmissionRouteDeclarationFiber?: Fiber
  agentPageAdmissionRouteReservationFiber?: Fiber
  agentPageFreshRoomNavigationFiber?: Fiber
  unregisterAgentSessionMigration?: () => void
  fiber?: Fiber
  status: ManagerPluginStatus
  error?: string
  blockedReason?: string
  generationContext?: Record<PropertyKey, unknown>
  generationView?: PluginGenerationView
  connectorClient?: CordisXBoundConnectorClient
  agentLoopClient?: CompatibleBoundAgentLoopClient
  hostDomWorker?: HostDomWorkerBoundary
  documentsClient?: CordisXOwnerDocumentsV1 & { dispose(): void }
}

export function topologicalActivationOrder(
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

export function committedActivation(candidate: CordisXPluginActivationRecordV1): CordisXPluginActivationRecordV1 {
  const { transactionId: _transactionId, ...record } = candidate
  return {
    ...record,
    recordKind: 'active',
    lastGoodRevision: candidate.revision,
  }
}

export interface RendererGenerationTransaction {
  readonly handle: PluginGenerationTransitionHandle
  readonly readiness?: PluginGenerationReadinessReceipt
  readonly affectedPluginIds: readonly string[]
  readonly previous: readonly PluginController[]
  readonly candidates: readonly PluginController[]
  readonly previousActivation: CordisXPluginActivationRecordV1
  readonly candidateActivation: CordisXPluginActivationRecordV1
  publication?: PluginGenerationPublication
  failedStage?: boolean
  finalizedRollbackStarted?: boolean
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
  readonly developmentPackage?: {
    readonly id: string
    readonly version: string
    readonly digest: `sha256:${string}`
    readonly identitySource: string
    readonly readme?: string
    /** Launcher-authoritative manifest captured with this exact local build. */
    readonly manifest?: CordisXBrowserPlugin['manifest']
    readonly development: CordisXLocalDevelopmentSnapshot
  }
  /** Host-only source held as data and executed solely in the isolated Host DOM worker. */
  readonly isolatedArtifactSource?: string
  readonly authorizationDecision?:
    | CordisXPermissionAuthorizationDecisionV1
    | CordisXPermissionAuthorizationDecisionV2
    | CordisXPermissionAuthorizationDecisionV4
  /** Host-private activation lease; never projected to plugins. */
  readonly ownerDocumentBindings?: readonly {
    readonly source: string
    readonly pluginId: string
    readonly moduleGeneration: string
    readonly installationId?: string
    readonly pluginGeneration?: number
    readonly token: string
  }[]
}

export interface CordisXRuntimeHandle extends ManagerModel {
  readonly version: string
  readonly pluginIds: readonly string[]
  execute(owner: string, reference: CordisXCommandReference, invocationKey?: string): Promise<unknown>
  navigate(owner: string, reference: CordisXRouteReference): Promise<void>
  setExtensionPointPolicy(source: string, pluginId: string, pointId: string, policy: CordisXPointPolicy): Promise<void>
  setExtensionPointPolicies(
    source: string,
    pluginId: string,
    policies: readonly { readonly pointId: string; readonly policy: CordisXPointPolicy }[],
  ): Promise<void>
  permissionAuthorizationPlan(id: string): CordisXPermissionAuthorizationPlanV1
  authorizePlugin(id: string, decision: CordisXPermissionAuthorizationDecisionV1): Promise<void>
  permissionAuthorizationPlanV2(id: string): CordisXPermissionAuthorizationPlanV2 | undefined
  authorizePluginV2(id: string, decision: CordisXPermissionAuthorizationDecisionV2): Promise<void>
  permissionAuthorizationPlanV4(id: string): CordisXPermissionAuthorizationPlanV4 | undefined
  authorizePluginV4(id: string, decision: CordisXPermissionAuthorizationDecisionV4): Promise<void>
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
    modules?: Readonly<Record<string, CordisXPluginModule>>,
  ): Promise<PluginGenerationReadinessReceipt>
  publishPluginMutation(transactionId: string): Promise<PluginGenerationPublication>
  completePluginMutation(transactionId: string): Promise<RendererGenerationCleanupObservation>
  finalizePluginMutation(transactionId: string): Promise<void>
  rollbackPluginMutation(transactionId: string): Promise<RendererGenerationCleanupObservation>
  commitPluginMutation(transactionId: string): Promise<void>
  abortPluginMutation(transactionId: string): Promise<void>
  reloadPluginGeneration(pluginId: string, moduleGeneration: string, runtimeGeneration: string): Promise<void>
  updateLocalDevelopmentStatus(status: CordisXLocalDevelopmentSnapshot): boolean
  adoptPluginBundleSnapshot(
    snapshot: CordisXPluginBundleManagerSnapshotV1,
  ): Readonly<{ revision: number; pluginRevision: number }>
  /** Host-private debug projection. Plugins and public runtime snapshots cannot access it. */
  playgroundMockAgentLoop?(): PlaygroundMockAgentLoopSnapshot
  /** Host-private native task projection read directly from the Playground Session authority. */
  playgroundAgentSessions?(): PlaygroundMockAgentLoopSnapshot | undefined
  /** Host-private destructive clear plus zero-count readback for this loopback Playground's mock tasks and ledgers. */
  resetPlaygroundMockAgentLoop?(): Readonly<{ before: number; after: number }>
  /** Host-private, loopback-Playground-only forwarding client. It never exposes the Room owner document. */
  readonly playgroundRoomSimulationBridge?: PlaygroundRoomSimulationForwardingClient
  /** Host-private Playground chrome projection of the one active route-history adapter. */
  playgroundRouteHistory?(): Readonly<{
    available: boolean
    canGoBack: boolean
    canGoForward: boolean
    reason?: string
  }>
  subscribePlaygroundRouteHistory?(listener: () => void): () => void
  goPlaygroundRouteHistory?(delta: -1 | 1): Promise<void>
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
  var __cordisxRuntime: CordisXRuntimeHandle | undefined
  // The production composition aliases its outer handshake to the serialized
  // runtime boot while its graph modules load.
  var __cordisxCompositionBoot: Promise<CordisXRuntimeHandle> | undefined
  var __cordisxBoot: Promise<CordisXRuntimeHandle> | undefined
  var __cordisxBootGeneration: string | undefined
  var __cordisxRequestedGeneration: string | undefined
  var __cordisxPendingPluginModuleV1: CordisXPluginModule | undefined
  var __cordisxPendingPluginModuleFactoryV1: ((console: CordisXPluginConsoleFacade) => CordisXPluginModule) | undefined
}

export function pluginFromModule(module: CordisXPluginModule): Plugin {
  if (typeof module.apply === 'function') return module as Plugin.Object
  const fallback = module.default
  if (typeof fallback === 'function') return fallback as Plugin
  if (
    fallback !== null && typeof fallback === 'object' && typeof (fallback as { apply?: unknown }).apply === 'function'
  ) {
    return fallback as Plugin.Object
  }
  throw new Error('CordisX plugin module must export apply() or a default Cordis plugin')
}

export function pluginInject(module: CordisXPluginModule | undefined): readonly string[] {
  if (module === undefined || module.inject === undefined) return []
  if (Array.isArray(module.inject)) return module.inject.filter((value): value is string => typeof value === 'string')
  return Object.keys(module.inject)
}

export function pluginReadmeSummary(readme: string | undefined): string | undefined {
  if (readme === undefined) return undefined
  const paragraphs = readme.replace(/\r\n?/g, '\n').split(/\n\s*\n/)
  for (const paragraph of paragraphs) {
    const lines = paragraph.split('\n').map(line => line.trim()).filter(Boolean)
    if (
      lines.length === 0
      || lines.every(line =>
        line.startsWith('#') || line.startsWith('![') || line.startsWith('<') || line.startsWith('```')
      )
      || lines[0]?.startsWith('---') === true
    ) continue
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

export function pluginDescriptionFields(readme: string | undefined): { readonly description?: string } {
  const description = pluginReadmeSummary(readme)
  return description === undefined ? {} : { description }
}

export function localizedPluginText(value: unknown): CordisXLocalizedText | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Partial<CordisXLocalizedText>
  return typeof candidate.key === 'string' ? candidate as CordisXLocalizedText : undefined
}

export function pluginPresentation(
  controller: PluginController,
  readme: string | undefined,
  i18n: CordisXI18nService | undefined,
): Pick<ManagerPluginSnapshot, 'name' | 'description'> {
  const fallbackName = controller.manifest.name ?? controller.item.module?.name ?? controller.item.id
  const presentation = controller.item.module?.presentation
  const nameMessage = localizedPluginText(presentation?.name)
  const descriptionMessage = localizedPluginText(presentation?.description)
  const nameSite = `manager-plugin:${controller.item.id}:name`
  const descriptionSite = `manager-plugin:${controller.item.id}:description`
  const name = nameMessage === undefined
    ? fallbackName
    : i18n?.resolveFor(controller.item.id, nameMessage, nameSite).text ?? nameMessage.fallback ?? fallbackName
  if (nameMessage === undefined) i18n?.clearDiagnosticSite(controller.item.id, nameSite)
  if (descriptionMessage === undefined) {
    i18n?.clearDiagnosticSite(controller.item.id, descriptionSite)
    return { name, ...pluginDescriptionFields(readme) }
  }
  const description = i18n?.resolveFor(controller.item.id, descriptionMessage, descriptionSite).text
    ?? descriptionMessage.fallback
  return { name, ...(description === undefined ? {} : { description }) }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function manifestUsesHostDom(
  manifest:
    | CordisXPluginManifestV1
    | CordisXPluginManifestV4
    | CordisXPluginManifestV5
    | CordisXPluginManifestV6
    | CordisXPluginManifestV7
    | CordisXPluginManifestV8
    | CordisXPluginManifestV9
    | CordisXPluginManifestV10,
): manifest is
  | CordisXPluginManifestV5
  | CordisXPluginManifestV6
  | CordisXPluginManifestV8
  | CordisXPluginManifestV9
  | CordisXPluginManifestV10
{
  return (
    manifest.schemaVersion === 5 || manifest.schemaVersion === 6 || manifest.schemaVersion === 8
    || manifest.schemaVersion === 9 || manifest.schemaVersion === 10
  )
    && manifest.capabilities.some(capability => (
      capability.name === 'ui.host-dom.read' || capability.name === 'ui.host-dom.modify'
    ))
}

export function manifestUsesTransientCanvas(
  manifest:
    | CordisXPluginManifestV1
    | CordisXPluginManifestV4
    | CordisXPluginManifestV5
    | CordisXPluginManifestV6
    | CordisXPluginManifestV7
    | CordisXPluginManifestV8
    | CordisXPluginManifestV9
    | CordisXPluginManifestV10,
): manifest is CordisXPluginManifestV7 {
  return manifest.schemaVersion === 7
    && manifest.execution.realm === 'isolated-worker'
    && manifest.execution.interfaces.includes('ui.transient-canvas/v1')
}

export function controllerHasRuntimeModule(controller: PluginController): boolean {
  return controller.item.module !== undefined || controller.item.isolatedArtifactSource !== undefined
}

export function createController(item: RuntimeBrowserPlugin, pluginConsole: PluginConsoleAspect): PluginController {
  const identity = Object.freeze({ source: item.source, id: item.id })
  const activation = 1
  const pluginGeneration = item.package?.moduleGeneration
    ?? item.artifactGeneration
    ?? `${pluginConsole.generation}:${item.id}:bundled`
  const principal = pluginConsole.issue(identity, pluginGeneration)
  try {
    const isolated = item.isolatedArtifactSource !== undefined
    const module = isolated ? undefined : item.moduleFactory?.(pluginConsole.consoleFacade(principal)) ?? item.module
    const boundItem: RuntimeBrowserPlugin = module === undefined || module === item.module ? item : { ...item, module }
    const manifest = normalizePluginManifest(item.manifest ?? module?.manifest, item.id)
    if (
      isolated
      && (item.manifest === undefined || (!manifestUsesHostDom(manifest) && !manifestUsesTransientCanvas(manifest)))
    ) {
      throw new Error('isolated artifact requires an authoritative isolated-worker manifest')
    }
    return {
      item: boundItem,
      identity,
      principal,
      activation,
      principalLive: true,
      manifest,
      status: !item.enabled || (!isolated && module === undefined) ? 'configured-disabled' : 'active',
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

export function readBlockedPlugins(): Set<string> {
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

export function writeBlockedPlugins(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(BLOCKED_PLUGINS_KEY, JSON.stringify([...ids].sort()))
  } catch {
    // Storage may be unavailable in hardened profiles; runtime blocking still works.
  }
}

export interface CordisXStartOptions {
  readonly previousRuntimeDisposed?: boolean
  readonly disposePreparedSharedReactRuntime?: () => void
}

export function createRuntimeClosureScope(accessors: any): any {
  return new Proxy(accessors, {
    get(target, property) {
      const accessor = target[property]
      return Array.isArray(accessor) ? accessor[0]() : accessor
    },
    set(target, property, value) {
      const accessor = target[property]
      if (!Array.isArray(accessor)) return false
      accessor[1](value)
      return true
    },
  })
}
