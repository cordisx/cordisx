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
import type { RuntimeClosureScope } from './runtime-closure-scope.js'
import {
  controllerHasRuntimeModule,
  CordisXRuntimeHandle,
  errorMessage,
  RendererGenerationCleanupObservation,
} from './runtime-shared.js'

export const createRuntimeRecoverPluginMutation = (
  runtimeScope: RuntimeClosureScope,
  input: RendererGenerationCleanupObservation,
): Promise<RendererGenerationCleanupObservation> => {
  const task = runtimeScope.operation.then(() => {
    if (runtimeScope.disposed) {
      throw new Error('CordisX runtime is disposed')
    }
    if (runtimeScope.generationTransactions()!.size !== 0) {
      throw new Error('plugin generation recovery conflicts with a live transaction')
    }
    if (
      input.registryEpoch !== runtimeScope.generationVisibility()!.registryEpoch()
      || input.active.profileId !== runtimeScope.currentActivation.profileId
      || input.active.plugins.length !== runtimeScope.currentActivation.plugins.length
    ) {
      throw new Error('plugin generation recovery scope is stale')
    }
    const live = new Map(runtimeScope.currentActivation.plugins.map(plugin => [plugin.id, plugin]))
    for (const plugin of input.active.plugins) {
      const current = live.get(plugin.id)
      if (
        current === undefined
        || current.version !== plugin.version
        || current.digest !== plugin.digest
        || current.moduleGeneration !== plugin.moduleGeneration
        || current.enabled !== plugin.enabled
        || JSON.stringify(current.dependencies) !== JSON.stringify(plugin.dependencies)
        || current.canonicalSource !== plugin.canonicalSource
      ) {
        throw new Error('plugin generation recovery closure is stale')
      }
    }
    const disposedGenerations = new Map(input.disposedAfter.plugins.map(plugin => [plugin.id, plugin.moduleGeneration]))
    for (const controller of runtimeScope.projectedControllers()!()) {
      const candidateGeneration = disposedGenerations.get(controller.item.id)
      if (
        candidateGeneration !== undefined
        && candidateGeneration === runtimeScope.moduleGenerationOf()!(controller)
        && candidateGeneration !== live.get(controller.item.id)?.moduleGeneration
      ) {
        throw new Error('published candidate generation survived process recovery')
      }
    }
    return structuredClone(input)
  })
  runtimeScope.operation = task.catch(() => {})
  return task
}

export const createRuntimeAdoptRecoveredActivation = (
  runtimeScope: RuntimeClosureScope,
  active: CordisXPluginActivationRecordV1,
  registryEpoch: number,
): Promise<void> => {
  const task = runtimeScope.operation.then(() => {
    if (runtimeScope.disposed) {
      throw new Error('CordisX runtime is disposed')
    }
    if (active.runtimeGeneration !== runtimeScope.generation()!) {
      throw new Error('recovered activation runtime generation is stale')
    }
    runtimeScope.generationVisibility()!.adoptRecoveredActivation(active, registryEpoch)
    runtimeScope.currentActivation = active
  })
  runtimeScope.operation = task.catch(() => {})
  return task
}

export const createRuntimeReloadPluginGeneration = (
  runtimeScope: RuntimeClosureScope,
  pluginId: string,
  moduleGeneration: string,
  runtimeGeneration: string,
): Promise<void> => {
  const task = runtimeScope.operation.then(async () => {
    if (runtimeScope.disposed) {
      throw new Error('CordisX runtime is disposed')
    }
    if (runtimeGeneration !== runtimeScope.generation()!) {
      throw new Error('stale CordisX runtime generation')
    }
    const controller = runtimeScope.activeController()!(pluginId)
    if (controller === undefined || controller.item.package?.moduleGeneration !== moduleGeneration) {
      throw new Error('stale plugin module generation')
    }
    if (!controller.item.enabled || !controllerHasRuntimeModule(controller)) {
      throw new Error('plugin is disabled')
    }
    await runtimeScope.disposeControllerFiber()!(controller, 'owner-disposed')
    try {
      await runtimeScope.mountPlugin()!(controller)
    } catch (error) {
      await runtimeScope.mountPlugin()!(controller).catch(rollbackError => {
        controller.status = 'failed'
        controller.error = `rollback-failed: ${errorMessage(rollbackError)}`
      })
      throw error
    } finally {
      runtimeScope.notify()!()
    }
  })
  runtimeScope.operation = task.catch(() => {})
  return task
}

export const createRuntimeUpdateLocalDevelopmentStatus = (
  runtimeScope: RuntimeClosureScope,
  status: CordisXLocalDevelopmentSnapshot,
): boolean => {
  runtimeScope.localDevelopment()!.set(status.sourcePath, structuredClone(status))
  runtimeScope.notify()!()
  return true
}

export const createRuntimeAdoptPluginBundleSnapshot = (
  runtimeScope: RuntimeClosureScope,
  snapshot: CordisXPluginBundleManagerSnapshotV1,
): Readonly<{ revision: number; pluginRevision: number }> => {
  if (
    snapshot.profileId !== runtimeScope.metadata()!.profileId
    || snapshot.runtimeGeneration !== runtimeScope.generation()!
    || snapshot.pluginRevision !== runtimeScope.currentActivation.revision
  ) {
    throw new Error('plugin bundle snapshot does not match the current renderer generation')
  }
  if (
    runtimeScope.currentPluginBundles !== undefined && snapshot.revision < runtimeScope.currentPluginBundles.revision
  ) {
    throw new Error('plugin bundle snapshot revision regressed')
  }
  runtimeScope.currentPluginBundles = snapshot
  runtimeScope.notify()!('plugin-bundles')
  return { revision: snapshot.revision, pluginRevision: snapshot.pluginRevision }
}

export const createRuntimeDispose = async (runtimeScope: RuntimeClosureScope): Promise<void> => {
  if (runtimeScope.disposed) {
    return
  }
  runtimeScope.disposed = true
  runtimeScope.agentRuntimeRouteDisposed = true
  runtimeScope.scenarioSessionScopeAuthority!?.dispose()
  if (runtimeScope.activeAgentRuntimeRouteInstance !== undefined) {
    runtimeScope.broker()!.revokeAgentRuntimeRoute(runtimeScope.activeAgentRuntimeRouteInstance)
  }
  runtimeScope.activeAgentRuntimeRouteInstance = undefined
  runtimeScope.broker()!.clearAgentRuntimeConnection()
  runtimeScope.disposeAgentPermissionFences()!()
  runtimeScope.certifiedPermissionChannel?.dispose()
  runtimeScope.certifiedPermissionChannel = undefined
  await runtimeScope.disposeInternalBootstrap?.()
  runtimeScope.disposeInternalBootstrap = undefined
  runtimeScope.disposeManager?.()
  runtimeScope.disposeManager = undefined
  runtimeScope.disposeI18nSubscription?.()
  runtimeScope.disposeI18nSubscription = undefined
  runtimeScope.disposePermissionSubscription?.()
  runtimeScope.disposePermissionSubscription = undefined
  runtimeScope.disposeExtensionPointSubscription?.()
  runtimeScope.disposeExtensionPointSubscription = undefined
  for (const unsubscribe of runtimeScope.registrySubscriptions()!.splice(0)) {
    unsubscribe()
  }
  await runtimeScope.operation
  for (const controller of [...runtimeScope.controllers()!].reverse()) {
    await controller.hostDomWorker?.dispose()
    delete controller.hostDomWorker
    controller.agentLoopClient?.dispose()
    delete controller.agentLoopClient
    controller.httpClient?.dispose()
    delete controller.httpClient
    await controller.unregisterHttp?.()
    delete controller.unregisterHttp
    controller.unregisterNotifications?.()
    delete controller.unregisterNotifications
    controller.restrictedContent?.dispose()
    await controller.unregisterRestrictedContent?.()
    delete controller.restrictedContent
    delete controller.unregisterRestrictedContent
    controller.agentLoopControl?.dispose()
    await controller.unregisterAgentLoopControl?.()
    delete controller.agentLoopControl
    delete controller.unregisterAgentLoopControl
    await controller.unregisterAgentLoop?.()
    delete controller.unregisterAgentLoop
    await controller.agentPageFreshRoomNavigationFiber?.dispose()
    delete controller.agentPageFreshRoomNavigationFiber
    await controller.agentPageAdmissionRouteReservationFiber?.dispose()
    delete controller.agentPageAdmissionRouteReservationFiber
    await controller.agentPageAdmissionRouteDeclarationFiber?.dispose()
    delete controller.agentPageAdmissionRouteDeclarationFiber
    await controller.agentPageAdmissionReservationFiber?.dispose()
    delete controller.agentPageAdmissionReservationFiber
    await controller.agentPageAdmissionTargetFiber?.dispose()
    delete controller.agentPageAdmissionTargetFiber
    await controller.agentAdmissionBootstrapRouteReservationFiber?.dispose()
    delete controller.agentAdmissionBootstrapRouteReservationFiber
    await controller.agentAdmissionBootstrapRouteDeclarationFiber?.dispose()
    delete controller.agentAdmissionBootstrapRouteDeclarationFiber
    await controller.agentAdmissionBootstrapReservationFiber?.dispose()
    delete controller.agentAdmissionBootstrapReservationFiber
    await controller.agentAdmissionBootstrapTargetFiber?.dispose()
    delete controller.agentAdmissionBootstrapTargetFiber
    await controller.agentAdmissionBootstrapRoomReservationFiber?.dispose()
    delete controller.agentAdmissionBootstrapRoomReservationFiber
    await controller.agentAdmissionBootstrapRoomTargetFiber?.dispose()
    delete controller.agentAdmissionBootstrapRoomTargetFiber
    await controller.agentAdmissionTargetReservationFiber?.dispose()
    delete controller.agentAdmissionTargetReservationFiber
    await controller.agentAdmissionTargetOriginFiber?.dispose()
    delete controller.agentAdmissionTargetOriginFiber
    await controller.agentAdmissionReservationFiber?.dispose()
    delete controller.agentAdmissionReservationFiber
    await controller.approvalServiceFiber?.dispose()
    delete controller.approvalServiceFiber
    await controller.agentDetailNavigationFiber?.dispose()
    delete controller.agentDetailNavigationFiber
    await controller.agentSessionDetailReferenceFiber?.dispose()
    delete controller.agentSessionDetailReferenceFiber
    await controller.sessionRegistryFiber?.dispose()
    delete controller.sessionRegistryFiber
    await controller.agentRegistryFiber?.dispose()
    delete controller.agentRegistryFiber
    await controller.entityRegistryFiber?.dispose()
    delete controller.entityRegistryFiber
    controller.unregisterAgentSessionMigration?.()
    delete controller.unregisterAgentSessionMigration
    controller.documentsClient?.dispose()
    delete controller.documentsClient
    controller.unregisterAgentTools?.()
    delete controller.unregisterAgentTools
    await controller.unregisterDocuments?.()
    delete controller.unregisterDocuments
    runtimeScope.agentRuntime()!.releaseOwner(
      controller.identity,
      'generation-replaced',
      runtimeScope.moduleGenerationOf()!(controller),
    )
    await controller.fiber?.dispose()
    runtimeScope.retirePrincipal()!(controller, 'Plugin disposed with runtime generation')
    delete controller.fiber
  }
  runtimeScope.generationTransactions()!.clear()
  runtimeScope.finalizedTransactions()!.clear()
  runtimeScope.rollbackReceipts()!.clear()
  runtimeScope.configBridge()!?.dispose()
  runtimeScope.serviceConfigBridge()!?.dispose()
  runtimeScope.iconThemePreferenceBridge()!?.dispose()
  runtimeScope.disposeIconThemePreferenceSubscription?.()
  runtimeScope.disposeIconThemePreferenceSubscription = undefined
  runtimeScope.lifecycleBridge()!?.dispose()
  runtimeScope.managerContentConfigAuthority?.dispose()
  runtimeScope.managerContentConfigAuthority = undefined
  runtimeScope.configRenderers()!.dispose()
  runtimeScope.configuration()!.dispose()
  runtimeScope.unbindIconThemeRegistry()!()
  runtimeScope.adapterHandle?.dispose()
  runtimeScope.adapterHandle = undefined
  runtimeScope.transientCanvasCoordinator?.dispose()
  runtimeScope.transientCanvasCoordinator = undefined
  runtimeScope.undeclareManagerContentOutlet?.()
  runtimeScope.undeclareManagerContentOutlet = undefined
  runtimeScope.undeclareManagerOutlet?.()
  runtimeScope.undeclareManagerOutlet = undefined
  await runtimeScope.slotFiber?.dispose()
  runtimeScope.slotFiber = undefined
  await runtimeScope.configRendererFiber?.dispose()
  runtimeScope.configRendererFiber = undefined
  await runtimeScope.iconThemeFiber?.dispose()
  runtimeScope.iconThemeFiber = undefined
  await runtimeScope.visualFiber?.dispose()
  runtimeScope.visualFiber = undefined
  await runtimeScope.channelManagerFiber?.dispose()
  runtimeScope.channelManagerFiber = undefined
  await runtimeScope.playgroundRoomSimulationBridgeFiber?.dispose()
  runtimeScope.playgroundRoomSimulationBridgeFiber = undefined
  runtimeScope.playgroundRoomSimulationBridgeRegistry()!?.dispose()
  await runtimeScope.settingsFiber?.dispose()
  runtimeScope.settingsFiber = undefined
  await runtimeScope.managerContentFiber?.dispose()
  runtimeScope.managerContentFiber = undefined
  await runtimeScope.routeFiber?.dispose()
  runtimeScope.routeFiber = undefined
  runtimeScope.routeHistory()!.dispose()
  await runtimeScope.pageFiber?.dispose()
  runtimeScope.pageFiber = undefined
  await runtimeScope.agentConversationShellFiber?.dispose()
  runtimeScope.agentConversationShellFiber = undefined
  runtimeScope.selectedNavigationActions()!.dispose()
  if (runtimeScope.ownsSharedReactRuntime) {
    runtimeScope.sharedReactRuntime?.dispose()
  } else {
    runtimeScope.disposePreparedSharedReactRuntime?.()
  }
  runtimeScope.disposePreparedSharedReactRuntime = undefined
  runtimeScope.sharedReactRuntime = undefined
  runtimeScope.ownsSharedReactRuntime = false
  await runtimeScope.commandFiber?.dispose()
  runtimeScope.commandFiber = undefined
  await runtimeScope.platformFiber?.dispose()
  runtimeScope.platformFiber = undefined
  await runtimeScope.systemPromptFiber?.dispose()
  runtimeScope.systemPromptFiber = undefined
  runtimeScope.connectorBroker()!.disposeAll()
  runtimeScope.agentLoopBroker()!.dispose()
  runtimeScope.agentLoopBrokerV2()!.dispose()
  runtimeScope.agentLoopBrokerV4()!.dispose()
  runtimeScope.disposeAgentDetailHistoryReturn()!
  runtimeScope.disposeAgentRouteHistory()!()
  runtimeScope.disposePageAdmissionActivation()!
  runtimeScope.disposeAgentRouteFences()!()
  await runtimeScope.agentSessionRuntime.dispose()
  runtimeScope.playgroundAgentSessionPersistence()!?.dispose()
  runtimeScope.ownerDocumentBroker()!.dispose()
  await runtimeScope.agentRuntime()!.dispose()
  runtimeScope.bindingPlatformAdapter?.dispose()
  runtimeScope.bindingPlatformAdapter = undefined
  if (runtimeScope.permissionStore()! instanceof BindingPermissionPolicyStore) {
    ;(runtimeScope.permissionStore()! as BindingPermissionPolicyStore).dispose()
  }
  for (const remove of runtimeScope.disposeExtensionPointCatalogs()!.splice(0).reverse()) {
    await remove()
  }
  runtimeScope.unregisterManagerPointCatalog?.()
  runtimeScope.unregisterManagerPointCatalog = undefined
  await runtimeScope.i18nFiber?.dispose()
  runtimeScope.i18nFiber = undefined
  runtimeScope.listeners()!.clear()
  for (const controller of runtimeScope.controllers()!) {
    controller.unregisterPermissions?.()
  }
  for (const controller of runtimeScope.controllers()!) {
    controller.unregisterExtensionPoints?.()
  }
  runtimeScope.hostDomAuthority()!.dispose()
  runtimeScope.broker()!.dispose()
  window.removeEventListener('error', runtimeScope.recordUnknownError()!)
  window.removeEventListener('unhandledrejection', runtimeScope.recordUnknownError()!)
  runtimeScope.disconnectPluginConsoleVisibility()!()
  runtimeScope.pluginConsole()!.dispose()
  runtimeScope.extensionPointBroker()!.dispose()
  runtimeScope.extensionPointDescriptors()!.dispose()
  runtimeScope.iconThemeRegistry()!.dispose()
  runtimeScope.settingsProjectionSites.clear()
  runtimeScope.settingsNavigationProjectionSites.clear()
  runtimeScope.extensionContributionProjectionSites.clear()
  if (globalThis.__cordisxRuntime === runtimeScope.handle()!) {
    globalThis.__cordisxRuntime = undefined
  }
  document.documentElement.removeAttribute('data-cordisx-ready')
}

export const createRuntimeHandle = (runtimeScope: RuntimeClosureScope): CordisXRuntimeHandle => ({
  version: runtimeScope.metadata()!.version,
  get pluginIds() {
    return runtimeScope.projectedControllers()!().map(controller => controller.item.id)
  },
  ...(runtimeScope.browserHostedPlayground()!
    ? {
      playgroundRouteHistory: () => {
        const snapshot = runtimeScope.routeHistory()!.snapshot()
        return Object.freeze({
          available: snapshot.available,
          canGoBack: snapshot.available && snapshot.canGoBack === true,
          canGoForward: snapshot.available && snapshot.canGoForward === true,
          ...(snapshot.reason === undefined ? {} : { reason: snapshot.reason }),
        })
      },
      subscribePlaygroundRouteHistory: (listener: () => void) => runtimeScope.routeHistory()!.subscribe(listener),
      goPlaygroundRouteHistory: async (delta: -1 | 1) => {
        await runtimeScope.routeHistory()!.go(delta)
      },
    }
    : {}),
  ...(runtimeScope.playgroundRoomSimulationBridgeRegistry()! === undefined ? {} : {
    playgroundRoomSimulationBridge: runtimeScope.playgroundRoomSimulationBridgeRegistry()!.client,
  }),
  execute: (owner, reference, invocationKey) => {
    if (runtimeScope.commandService === undefined) {
      return Promise.reject(new Error('CordisX commands are not ready'))
    }
    return runtimeScope.commandService.executeFor(owner, reference, invocationKey)
  },
  navigate: async (owner, reference) => {
    if (runtimeScope.routeService === undefined) {
      return Promise.reject(new Error('CordisX routes are not ready'))
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await runtimeScope.routeService.navigateFor(owner, reference)
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'permission.review-pending') {
          throw error
        }
        const controller = runtimeScope.activeControllers()!().find(candidate => candidate.item.id === owner)
        if (controller === undefined) {
          throw error
        }
        const decisions = await runtimeScope.broker()!.reviewPendingDomAccess(
          controller.identity,
          runtimeScope.moduleGenerationOf()!(controller),
          controller.generationView,
        )
        if (decisions.length === 0) {
          throw error
        }
        const denied = decisions.find(decision => !decision.authorized)
        if (denied !== undefined) {
          throw new Error(denied.reason)
        }
      }
    }
    throw new Error('permission.review-retry-exhausted')
  },
  mountSettingsTab: (id, panelBody) => {
    if (runtimeScope.routeService === undefined || runtimeScope.slotService === undefined) {
      return Promise.reject(new Error('CordisX manager settings are not ready'))
    }
    const registration = runtimeScope.slotService.snapshot().find(item =>
      item.surface === 'manager.settings.tabs'
      && item.qualifiedId === id && item.valid && item.visible && item.authorized && !item.pending && !item.disabled
    )
    if (registration === undefined) {
      return Promise.reject(new Error(`manager settings tab ${id} is not activatable`))
    }
    const item = registration.item as CordisXManagerSettingsTabItem
    return runtimeScope.routeService.mountManagerSettingsFor(
      registration.owner,
      item.route,
      registration.qualifiedId,
      panelBody,
    )
  },
  closeSettingsTabContent: () => runtimeScope.routeService?.closeManagerSettings() ?? Promise.resolve(),
  managerContentPresentation: (id, reference) => {
    if (runtimeScope.routeService === undefined || runtimeScope.slotService === undefined) {
      return undefined
    }
    const registration = runtimeScope.slotService.snapshot().find(item =>
      item.surface === 'manager.settings.navigation-items'
      && item.qualifiedId === id && item.valid && item.visible && item.authorized && !item.pending && !item.disabled
    )
    if (registration === undefined) {
      return undefined
    }
    return runtimeScope.routeService.managerContentPresentationFor(registration.owner, reference)
  },
  mountManagerContent: (id, reference, container, navigation) => {
    if (runtimeScope.routeService === undefined || runtimeScope.slotService === undefined) {
      return Promise.reject(new Error('CordisX manager content is not ready'))
    }
    const registration = runtimeScope.slotService.snapshot().find(item =>
      item.surface === 'manager.settings.navigation-items'
      && item.qualifiedId === id && item.valid && item.visible && item.authorized && !item.pending && !item.disabled
      && (item.group === 'before-settings' || item.group === 'after-settings')
    )
    if (registration === undefined) {
      return Promise.reject(new Error(`manager content item ${id} is not activatable`))
    }
    return runtimeScope.routeService.mountManagerContentFor(
      registration.owner,
      reference,
      registration.qualifiedId,
      container,
      {
        navigate: (next: CordisXRouteReference) => navigation.navigate(next),
        back: () => navigation.back(),
        close: () => navigation.back(),
      },
    )
  },
  closeManagerContent: () => runtimeScope.routeService?.closeManagerContent() ?? Promise.resolve(),
  pluginConsole: (id) => {
    const controller = runtimeScope.activeController()!(id)
    if (controller === undefined) {
      throw new Error(`unknown CordisX plugin: ${id}`)
    }
    return runtimeScope.pluginConsole()!.query(controller.identity)
  },
  clearPluginConsole: (id) => {
    const controller = runtimeScope.activeController()!(id)
    if (controller === undefined) {
      throw new Error(`unknown CordisX plugin: ${id}`)
    }
    runtimeScope.pluginConsole()!.clear(controller.identity)
  },
  subscribePluginConsole: listener => runtimeScope.pluginConsole()!.subscribe(listener),
  setExtensionPointPolicy: runtimeScope.setExtensionPointPolicy()!,
  setExtensionPointPolicies: runtimeScope.setExtensionPointPolicies()!,
  setExtensionPointControlAuthorization: runtimeScope.setExtensionPointControlAuthorization()!,
  setExtensionPointControlGroupChoice: runtimeScope.setExtensionPointControlGroupChoice()!,
  permissionAuthorizationPlan: runtimeScope.permissionAuthorizationPlan()!,
  authorizePlugin: runtimeScope.authorizePlugin()!,
  permissionAuthorizationPlanV2: runtimeScope.permissionAuthorizationPlanV2()!,
  authorizePluginV2: runtimeScope.authorizePluginV2()!,
  permissionAuthorizationPlanV4: id => {
    const controller = runtimeScope.activeController()!(id)
    return controller === undefined
      ? undefined
      : runtimeScope.broker()!.authorizationPlanV4(controller.identity, 'enable', controller.generationView)
  },
  authorizePluginV4: runtimeScope.authorizePluginV4()!,
  activePluginGeneration: () => structuredClone(runtimeScope.currentActivation),
  generationNotificationTrace: () => runtimeScope.generationNotificationTrace()!.map(item => ({ ...item })),
  settleRegistryProjection: runtimeScope.settleRegistryProjection()!,
  requestPluginLifecycle: (
    lifecycleOperation: CordisXPluginLifecycleOperationV1,
  ): Promise<CordisXPluginLifecycleResultV1> => {
    if (runtimeScope.lifecycleBridge()! === undefined) {
      return Promise.reject(new Error('plugin lifecycle operations are unavailable'))
    }
    return runtimeScope.lifecycleBridge()!.request(runtimeScope.currentActivation.revision, lifecycleOperation)
  },
  requestPluginBundleLifecycle: async (
    operation: CordisXPluginBundleLifecycleOperationV1,
  ): Promise<CordisXPluginBundleLifecycleResultV1> => {
    if (runtimeScope.lifecycleBridge()! === undefined || runtimeScope.currentPluginBundles === undefined) {
      throw new Error('plugin bundle lifecycle operations are unavailable')
    }
    const result = await runtimeScope.lifecycleBridge()!.bundleRequest(runtimeScope.currentPluginBundles, operation)
    runtimeScope.currentPluginBundles = await runtimeScope.lifecycleBridge()!.bundleSnapshot()
    if (result.outcome === 'applied') {
      const effective = new Map(
        runtimeScope.currentPluginBundles.bundles.flatMap(bundle => bundle.permissions).map(permission => [
          `${permission.pluginId}\u0000${permission.permissionId}`,
          permission,
        ]),
      )
      const runtimePermissions = runtimeScope.broker()!.snapshots()
      for (const permission of effective.values()) {
        const runtimePermission = runtimePermissions.find(item =>
          item.identity.id === permission.pluginId
          && item.capability === permission.capability && JSON.stringify(item.scope) === permission.scopeLabel
        )
        if (runtimePermission !== undefined) {
          await runtimeScope.setPermissionPolicy()!(
            permission.pluginId,
            permission.capability as CordisXPermissionCapabilityV4,
            permission.effectivePolicy,
            runtimePermission.scope,
          )
        }
      }
    }
    runtimeScope.notify()!('plugin-bundles')
    return result
  },
  permissionLifecycleReviewPlanV2: target => {
    if (runtimeScope.lifecycleBridge()! === undefined) {
      return Promise.reject(new Error('plugin lifecycle operations are unavailable'))
    }
    return runtimeScope.lifecycleBridge()!.permissionReviewPlanV2(runtimeScope.currentActivation.revision, target)
  },
  applyPermissionLifecycleReviewV2: decision => {
    if (runtimeScope.lifecycleBridge()! === undefined) {
      return Promise.reject(new Error('plugin lifecycle operations are unavailable'))
    }
    return runtimeScope.lifecycleBridge()!.applyPermissionReviewV2(runtimeScope.currentActivation.revision, decision)
  },
  permissionLifecycleReviewPlanV4: target => {
    if (runtimeScope.lifecycleBridge()! === undefined) {
      return Promise.reject(new Error('plugin lifecycle operations are unavailable'))
    }
    return runtimeScope.lifecycleBridge()!.permissionReviewPlanV4(runtimeScope.currentActivation.revision, target)
  },
  applyPermissionLifecycleReviewV4: decision => {
    if (runtimeScope.lifecycleBridge()! === undefined) {
      return Promise.reject(new Error('plugin lifecycle operations are unavailable'))
    }
    return runtimeScope.lifecycleBridge()!.applyPermissionReviewV4(runtimeScope.currentActivation.revision, decision)
  },
  stagePluginMutation: runtimeScope.stagePluginMutation()!,
  publishPluginMutation: runtimeScope.publishPluginMutation()!,
  completePluginMutation: runtimeScope.completePluginMutation()!,
  finalizePluginMutation: runtimeScope.finalizePluginMutation()!,
  rollbackPluginMutation: runtimeScope.rollbackPluginMutation()!,
  recoverPluginMutation: runtimeScope.recoverPluginMutation()!,
  adoptRecoveredActivation: runtimeScope.adoptRecoveredActivation()!,
  commitPluginMutation: runtimeScope.commitPluginMutation()!,
  abortPluginMutation: runtimeScope.abortPluginMutation()!,
  reloadPluginGeneration: runtimeScope.reloadPluginGeneration()!,
  updateLocalDevelopmentStatus: runtimeScope.updateLocalDevelopmentStatus()!,
  adoptPluginBundleSnapshot: runtimeScope.adoptPluginBundleSnapshot()!,
  ...(runtimeScope.metadata()!.hostKind === 'playground'
    ? {
      playgroundAgentSessions: () =>
        projectPlaygroundAgentSessions(runtimeScope.agentSessionRuntime.playgroundProjection()),
    }
    : {}),
  ...(runtimeScope.playgroundMockAgentLoop()! === undefined ? {} : {
    playgroundMockAgentLoop: () => runtimeScope.playgroundMockAgentLoop()!.snapshot(),
    resetPlaygroundMockAgentLoop: () => {
      const before = runtimeScope.playgroundMockAgentLoop()!.snapshot().tasks.length
      runtimeScope.agentLoopBrokerV2()!.resetPlaygroundState()
      runtimeScope.agentLoopBrokerV4()!.resetPlaygroundState()
      runtimeScope.playgroundMockAgentLoopV4Transport()!?.resetPlaygroundState()
      runtimeScope.playgroundMockAgentLoop()!.resetPlaygroundState()
      try {
        document.defaultView?.sessionStorage.removeItem(runtimeScope.simulatorSessionKey()!)
        document.defaultView?.sessionStorage.removeItem(`${runtimeScope.simulatorSessionKey()!}:agent-loop-v2-ledger`)
        document.defaultView?.sessionStorage.removeItem(`${runtimeScope.simulatorSessionKey()!}:agent-loop-v4-ledger`)
      } catch { /* optional browser session storage */ }
      return Object.freeze({ before, after: runtimeScope.playgroundMockAgentLoop()!.snapshot().tasks.length })
    },
  }),
  snapshot: runtimeScope.publicSnapshot()!,
  setPluginBlocked: runtimeScope.setPluginBlocked()!,
  updatePluginConfig: runtimeScope.updatePluginConfig()!,
  listServiceConfigs: async (pluginId: string): Promise<readonly HostServiceConfigDescriptor[]> => {
    if (runtimeScope.serviceConfigBridge()! === undefined) {
      return []
    }
    return await runtimeScope.serviceConfigBridge()!.list(pluginId)
  },
  updateServiceConfig: async (mutation: HostServiceConfigMutation): Promise<HostServiceConfigMutationResult> => {
    if (runtimeScope.serviceConfigBridge()! === undefined) {
      throw new Error('service-config-unavailable')
    }
    return await runtimeScope.serviceConfigBridge()!.mutate(mutation)
  },
  mountConfigRenderer: (pluginId, field, container, setDraft) =>
    runtimeScope.configRenderers()!.mount(pluginId, field, container, setDraft),
  setPermissionPolicy: runtimeScope.setPermissionPolicy()!,
  subscribe: runtimeScope.subscribe()!,
  dispose: runtimeScope.dispose()!,
})

export const createRuntimeManagerModel = (runtimeScope: RuntimeClosureScope): ManagerModel => ({
  ...runtimeScope.handle()!,
  snapshot: runtimeScope.managerSnapshot()!,
  iconThemePreferenceWritable: runtimeScope.iconThemePreferenceBridge()! !== undefined,
  selectIconTheme: (expectedProfileRevision, candidate) =>
    selectAndPersistIconTheme(
      runtimeScope.iconThemeRegistry()!,
      runtimeScope.iconThemePreferenceBridge()!,
      runtimeScope.generation()!,
      expectedProfileRevision,
      candidate,
    ),
})
