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
  cloneRendererValue,
  committedActivation,
  controllerHasRuntimeModule,
  createController,
  PluginController,
  RendererGenerationCleanupObservation,
  RendererPluginMutation,
  RuntimeBrowserPlugin,
  topologicalActivationOrder,
  writeBlockedPlugins,
} from './runtime-shared.js'

export const createRuntimeSetExtensionPointControlAuthorization = (
  runtimeScope: RuntimeClosureScope,
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
): Promise<void> => {
  const task = runtimeScope.operation.then(async () => {
    if (runtimeScope.disposed) {
      throw new Error('CordisX runtime is disposed')
    }
    const controller = runtimeScope.activeController()!(reference.pluginId, reference.source)
    if (controller === undefined) {
      throw new Error(`unknown CordisX plugin identity: ${reference.source} / ${reference.pluginId}`)
    }
    await runtimeScope.broker()!.setDomPolicy(
      controller.identity,
      reference.pointId,
      policy === 'allow' ? 'allow-persistent' : policy === 'deny' ? 'deny-persistent' : 'ask',
    )
    runtimeScope.slotService?.invalidatePointPolicies()
    await runtimeScope.routeService?.invalidatePointPolicies()
    runtimeScope.notify()!('controlled-surface-policy')
  })
  runtimeScope.operation = task.catch(() => {})
  return task
}

export const createRuntimeSetExtensionPointControlGroupChoice = (
  runtimeScope: RuntimeClosureScope,
  expectedPolicyRevision: number,
  choice: ControlledSurfaceGroupChoice,
): Promise<void> => {
  const task = runtimeScope.operation.then(async () => {
    if (runtimeScope.disposed) {
      throw new Error('CordisX runtime is disposed')
    }
    if (runtimeScope.slotService === undefined) {
      throw new Error('controlled surface runtime is unavailable')
    }
    runtimeScope.slotService.setControlGroupChoice(expectedPolicyRevision, choice)
    runtimeScope.notify()!('controlled-surface-selection')
  })
  runtimeScope.operation = task.catch(() => {})
  return task
}

export const createRuntimePermissionAuthorizationPlan = (
  runtimeScope: RuntimeClosureScope,
  id: string,
): CordisXPermissionAuthorizationPlanV1 => {
  const controller = runtimeScope.activeController()!(id)
  if (controller === undefined) {
    throw new Error(`unknown CordisX plugin: ${id}`)
  }
  return runtimeScope.broker()!.authorizationPlan(controller.identity, 'enable')
}

export const createRuntimePermissionAuthorizationPlanV2 = (
  runtimeScope: RuntimeClosureScope,
  id: string,
): CordisXPermissionAuthorizationPlanV2 | undefined => {
  const controller = runtimeScope.activeController()!(id)
  if (controller === undefined) {
    throw new Error(`unknown CordisX plugin: ${id}`)
  }
  return controller.manifest.schemaVersion === 4
    ? runtimeScope.broker()!.authorizationPlanV2(controller.identity, 'enable', controller.generationView)
    : undefined
}

export const createRuntimeAuthorizePluginWith = (
  runtimeScope: RuntimeClosureScope,
  id: string,
  authorize: (controller: PluginController) => Promise<void>,
): Promise<void> => {
  const task = runtimeScope.operation.then(async () => {
    if (runtimeScope.disposed) {
      throw new Error('CordisX runtime is disposed')
    }
    const controller = runtimeScope.activeController()!(id)
    if (controller === undefined) {
      throw new Error(`unknown CordisX plugin: ${id}`)
    }
    if (!controller.item.enabled || !controllerHasRuntimeModule(controller)) {
      throw new Error(`plugin ${id} is disabled in cordisx.config.json and is not bundled`)
    }
    await authorize(controller)
    runtimeScope.blockedPlugins()!.delete(id)
    writeBlockedPlugins(runtimeScope.blockedPlugins()!)
    const blockedReason = runtimeScope.requiredBlockReason()!(controller)
    if (blockedReason !== undefined) {
      await runtimeScope.disposeControllerFiber()!(controller, 'owner-disposed')
      controller.status = 'permission-blocked'
      controller.blockedReason = blockedReason
      runtimeScope.notify()!()
      return
    }
    if (controller.fiber === undefined && controller.hostDomWorker === undefined) {
      await runtimeScope.mountPlugin()!(controller)
    }
    runtimeScope.notify()!()
  })
  runtimeScope.operation = task.catch(() => {})
  return task
}

export const createRuntimeAuthorizePlugin = (
  runtimeScope: RuntimeClosureScope,
  id: string,
  decision: CordisXPermissionAuthorizationDecisionV1,
): Promise<void> =>
  runtimeScope.authorizePluginWith()!(id, async (controller) => {
    await runtimeScope.broker()!.authorizeActivation(controller.identity, decision, 'enable', controller.generationView)
  })

export const createRuntimeAuthorizePluginV2 = (
  runtimeScope: RuntimeClosureScope,
  id: string,
  decision: CordisXPermissionAuthorizationDecisionV2,
): Promise<void> =>
  runtimeScope.authorizePluginWith()!(id, async (controller) => {
    if (controller.manifest.schemaVersion !== 4) {
      throw new Error(`plugin ${id} does not use permission v2`)
    }
    await runtimeScope.broker()!.authorizeActivationV2(
      controller.identity,
      decision,
      'enable',
      controller.generationView,
    )
  })

export const createRuntimeAuthorizePluginV4 = (
  runtimeScope: RuntimeClosureScope,
  id: string,
  decision: CordisXPermissionAuthorizationDecisionV4,
): Promise<void> =>
  runtimeScope.authorizePluginWith()!(id, async (controller) => {
    if (
      controller.manifest.schemaVersion !== 5 && controller.manifest.schemaVersion !== 6
      && controller.manifest.schemaVersion !== 7 && controller.manifest.schemaVersion !== 8
      && controller.manifest.schemaVersion !== 9
      && (controller.manifest.schemaVersion !== 10 && controller.manifest.schemaVersion !== 11
        && controller.manifest.schemaVersion !== 12 && controller.manifest.schemaVersion !== 13)
    ) {
      throw new Error(`plugin ${id} does not use permission v4`)
    }
    await runtimeScope.broker()!.authorizeActivationV4(
      controller.identity,
      decision,
      'enable',
      controller.generationView,
    )
  })

export const createRuntimeCandidateController = (
  runtimeScope: RuntimeClosureScope,
  handle: PluginGenerationTransitionHandle,
  mutation: RendererPluginMutation,
  pluginId: string,
  module?: CordisXPluginModule,
  moduleFactory?: (console: CordisXPluginConsoleFacade) => CordisXPluginModule,
  modules?: Readonly<Record<string, CordisXPluginModule>>,
): { readonly controller: PluginController; readonly registerAuthority: boolean } => {
  const activation = mutation.candidate.plugins.find(item => item.id === pluginId)
  if (activation === undefined) {
    throw new Error(`candidate is missing affected plugin ${pluginId}`)
  }
  const existing = runtimeScope.activeController()!(pluginId)
  const replacesTarget = pluginId === mutation.targetId
    && (mutation.operation === 'install' || mutation.operation === 'update' || mutation.operation === 'enable')
  const replacementPackage = mutation.package ?? mutation.developmentPackage
  const replacementId = mutation.package?.manifest.id ?? mutation.developmentPackage?.id
  const replacementVersion = mutation.package?.manifest.version ?? mutation.developmentPackage?.version
  if (!replacesTarget && existing === undefined) {
    throw new Error(`affected plugin ${pluginId} is not active`)
  }
  if (
    replacesTarget && (replacementPackage === undefined
      || (module === undefined && moduleFactory === undefined && modules?.[pluginId] === undefined
        && mutation.isolatedArtifactSource === undefined))
  ) {
    throw new Error('candidate package module is unavailable')
  }
  if (
    replacesTarget && (replacementId !== pluginId
      || replacementPackage!.digest !== activation.digest
      || replacementVersion !== activation.version)
  ) {
    throw new Error('candidate package does not match the activation tuple')
  }
  const descriptor = existing === undefined
    ? undefined
    : runtimeScope.configuration()!.descriptor(pluginId, runtimeScope.i18nService?.getSnapshot().locale ?? 'en')
  const graphModule = modules?.[pluginId]
  const candidateModule = graphModule ?? (replacesTarget ? module : existing!.item.module)
  const candidateModuleFactory = graphModule === undefined
    ? replacesTarget ? moduleFactory : existing!.item.moduleFactory
    : undefined
  const candidateIsolatedArtifactSource = replacesTarget
    ? mutation.isolatedArtifactSource
    : existing!.item.isolatedArtifactSource
  const candidateManifest = replacesTarget
    ? mutation.package?.manifest.runtimeManifest ?? mutation.developmentPackage?.manifest
    : existing!.item.manifest
  const item: RuntimeBrowserPlugin = {
    id: pluginId,
    source: replacesTarget ? replacementPackage!.identitySource : existing!.item.source,
    enabled: activation.enabled,
    ...(candidateModule === undefined ? {} : { module: candidateModule }),
    ...(candidateModuleFactory === undefined ? {} : { moduleFactory: candidateModuleFactory }),
    ...(candidateIsolatedArtifactSource === undefined
      ? {}
      : { isolatedArtifactSource: candidateIsolatedArtifactSource }),
    ...(replacesTarget
      ? mutation.developmentPackage === undefined ? {} : { development: mutation.developmentPackage.development }
      : existing!.item.development === undefined
      ? {}
      : { development: existing!.item.development }),
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
      ? replacementPackage!.readme === undefined ? {} : { readme: replacementPackage!.readme }
      : existing!.item.readme === undefined
      ? {}
      : { readme: existing!.item.readme }),
    ...(!replacesTarget && existing!.item.readmes !== undefined ? { readmes: existing!.item.readmes } : {}),
  }
  const controller = createController(item, runtimeScope.pluginConsole()!)
  if (replacesTarget && mutation.developmentPackage !== undefined && controller.status === 'failed') {
    throw new Error(
      `local development candidate ${pluginId} is invalid: ${controller.error ?? 'module initialization failed'}`,
    )
  }
  if (
    replacesTarget && mutation.developmentPackage !== undefined
    && (controller.manifest.schemaVersion === 4 || controller.manifest.schemaVersion === 5
      || controller.manifest.schemaVersion === 6 || controller.manifest.schemaVersion === 7
      || controller.manifest.schemaVersion === 8 || controller.manifest.schemaVersion === 9
      || (controller.manifest.schemaVersion === 10 || controller.manifest.schemaVersion === 11
        || controller.manifest.schemaVersion === 12 || controller.manifest.schemaVersion === 13))
    && controller.manifest.services.length > 0
  ) {
    throw new Error('local development phase 1 is renderer-only; manifest services are unavailable')
  }
  controller.generationContext = runtimeScope.generationVisibility()!.context(handle, pluginId)
  const candidateContext = runtimeScope.ctx.extend({
    [CORDISX_PLUGIN_ID]: controller.item.id,
    [CORDISX_PLUGIN_SOURCE]: controller.item.source,
    [CORDISX_PLUGIN_GENERATION]: runtimeScope.moduleGenerationOf()!(controller),
    ...controller.generationContext,
  })
  controller.generationView = runtimeScope.generationVisibility()!.view(candidateContext)
  return { controller, registerAuthority: true }
}

export const createRuntimeDisposeControllers = async (
  runtimeScope: RuntimeClosureScope,
  items: readonly PluginController[],
  activation: CordisXPluginActivationRecordV1,
  disposedAfter: string[],
): Promise<void> => {
  const byId = new Map(items.map(controller => [controller.item.id, controller]))
  const order = topologicalActivationOrder(activation, new Set(byId.keys())).reverse()
  let failure: unknown
  for (const id of order) {
    if (disposedAfter.includes(id)) {
      continue
    }
    const controller = byId.get(id)
    if (controller === undefined) {
      continue
    }
    try {
      await runtimeScope.disposeControllerFiber()!(controller, 'generation-replaced')
    } catch (error) {
      failure ??= error
    } finally {
      runtimeScope.unregisterController()!(controller)
      disposedAfter.push(id)
    }
  }
  if (failure !== undefined) {
    throw failure
  }
}

export const createRuntimeOrderControllersFor = (
  runtimeScope: RuntimeClosureScope,
  activation: CordisXPluginActivationRecordV1,
): void => {
  const order = new Map(activation.plugins.map((plugin, index) => [plugin.id, index]))
  const generation = new Map(activation.plugins.map(plugin => [plugin.id, plugin.moduleGeneration]))
  runtimeScope.controllers()!.sort((left, right) => {
    const byPlugin = (order.get(left.item.id) ?? Number.MAX_SAFE_INTEGER)
      - (order.get(right.item.id) ?? Number.MAX_SAFE_INTEGER)
    if (byPlugin !== 0) {
      return byPlugin
    }
    const expected = generation.get(left.item.id)
    if (runtimeScope.moduleGenerationOf()!(left) === expected) {
      return -1
    }
    if (runtimeScope.moduleGenerationOf()!(right) === expected) {
      return 1
    }
    return 0
  })
}

export const createRuntimeRestoreControllers = async (
  runtimeScope: RuntimeClosureScope,
  items: readonly PluginController[],
  activation: CordisXPluginActivationRecordV1,
  disposedAfter: string[],
  publication?: PluginGenerationPublication,
): Promise<void> => {
  const byId = new Map(items.map(controller => [controller.item.id, controller]))
  for (const id of topologicalActivationOrder(activation, new Set(disposedAfter))) {
    const controller = byId.get(id)
    if (controller === undefined || !disposedAfter.includes(id)) {
      continue
    }
    if (publication !== undefined) {
      controller.generationContext = runtimeScope.generationVisibility()!.retiringContext(publication, id)
      const rollbackContext = runtimeScope.ctx.extend({
        [CORDISX_PLUGIN_ID]: controller.item.id,
        [CORDISX_PLUGIN_SOURCE]: controller.item.source,
        [CORDISX_PLUGIN_GENERATION]: runtimeScope.moduleGenerationOf()!(controller),
        ...controller.generationContext,
      })
      controller.generationView = runtimeScope.generationVisibility()!.view(rollbackContext)
    }
    if (!runtimeScope.controllers()!.includes(controller)) {
      runtimeScope.registerController()!(controller)
      runtimeScope.controllers()!.push(controller)
    }
    const item = activation.plugins.find(plugin => plugin.id === id)
    if (item?.enabled === true && !runtimeScope.blockedPlugins()!.has(id)) {
      await runtimeScope.mountPlugin()!(controller)
    }
    const index = disposedAfter.indexOf(id)
    if (index >= 0) {
      disposedAfter.splice(index, 1)
    }
  }
}

export const createRuntimeStagePluginMutation = (
  runtimeScope: RuntimeClosureScope,
  mutation: RendererPluginMutation,
  module?: CordisXPluginModule,
  moduleFactory?: (console: CordisXPluginConsoleFacade) => CordisXPluginModule,
  modules?: Readonly<Record<string, CordisXPluginModule>>,
): Promise<PluginGenerationReadinessReceipt> => {
  const task = runtimeScope.operation.then(async () => {
    if (runtimeScope.disposed) {
      throw new Error('CordisX runtime is disposed')
    }
    if (
      mutation.previous.runtimeGeneration !== runtimeScope.generation()!
      || mutation.candidate.runtimeGeneration !== runtimeScope.generation()!
    ) {
      throw new Error('stale CordisX runtime generation')
    }
    if (
      mutation.candidate.lastGoodRevision !== mutation.previous.revision
      || mutation.candidate.revision !== mutation.previous.revision + 1
    ) {
      throw new Error('invalid plugin activation revision transition')
    }
    if (runtimeScope.rollbackReceipts()!.has(mutation.transactionId)) {
      throw new Error('plugin generation transaction is already rolled back')
    }
    if (runtimeScope.finalizedTransactions()!.has(mutation.transactionId)) {
      throw new Error('plugin generation transaction is already finalized')
    }
    if (runtimeScope.generationTransactions()!.has(mutation.transactionId)) {
      throw new Error('plugin generation transaction already exists')
    }
    const handle = runtimeScope.generationVisibility()!.begin(
      mutation.transactionId,
      mutation.previous,
      mutation.candidate,
      mutation.transactionEpoch,
    )
    const supplied = new Set(mutation.affectedPluginIds)
    if (
      supplied.size !== handle.affectedPluginIds.length
      || handle.affectedPluginIds.some(id => !supplied.has(id))
      || !handle.affectedPluginIds.includes(mutation.targetId)
    ) {
      runtimeScope.generationVisibility()!.abort(handle)
      throw new Error('affected plugin set does not match the Host dependency closure')
    }
    const affected = new Set(handle.affectedPluginIds)
    if (
      modules !== undefined
      && Object.keys(modules).some(id => !affected.has(id) || !mutation.candidate.plugins.some(item => item.id === id))
    ) {
      runtimeScope.generationVisibility()!.abort(handle)
      throw new Error('candidate browser graph modules do not match the Host dependency closure')
    }
    runtimeScope.ownerDocumentBroker()!.registerBindings(mutation.ownerDocumentBindings ?? [])
    runtimeScope.registerEntityBindings()!(mutation.ownerDocumentBindings)
    const previous = runtimeScope.activeControllers()!().filter(controller => affected.has(controller.item.id))
    const candidates: PluginController[] = []
    runtimeScope.notificationsSuppressed = true
    try {
      for (const id of handle.affectedPluginIds) {
        if (!mutation.candidate.plugins.some(item => item.id === id)) {
          continue
        }
        const candidate = runtimeScope.candidateController()!(handle, mutation, id, module, moduleFactory, modules)
        runtimeScope.registerController()!(candidate.controller, candidate.registerAuthority)
        runtimeScope.controllers()!.push(candidate.controller)
        candidates.push(candidate.controller)
        if (
          candidate.controller.item.id === mutation.targetId
          && mutation.authorizationDecision !== undefined
          && (mutation.operation === 'install' || mutation.operation === 'update'
            || mutation.operation === 'enable')
        ) {
          if (mutation.authorizationDecision.schemaVersion === 4) {
            if (
              candidate.controller.manifest.schemaVersion !== 5 && candidate.controller.manifest.schemaVersion !== 6
              && candidate.controller.manifest.schemaVersion !== 7
              && candidate.controller.manifest.schemaVersion !== 8 && candidate.controller.manifest.schemaVersion !== 9
              && (candidate.controller.manifest.schemaVersion !== 10
                && candidate.controller.manifest.schemaVersion !== 11
                && candidate.controller.manifest.schemaVersion !== 12
                && candidate.controller.manifest.schemaVersion !== 13)
            ) {
              throw new Error(
                'permission v4 decision requires manifest-v5, manifest-v6, manifest-v7 through manifest-v12',
              )
            }
            await runtimeScope.broker()!.authorizeActivationV4(
              candidate.controller.identity,
              mutation.authorizationDecision,
              mutation.operation as 'install' | 'update' | 'enable',
              candidate.controller.generationView,
            )
          } else if (mutation.authorizationDecision.schemaVersion === 2) {
            if (candidate.controller.manifest.schemaVersion !== 4) {
              throw new Error('permission v2 decision requires manifest-v4')
            }
            await runtimeScope.broker()!.authorizeActivationV2(
              candidate.controller.identity,
              mutation.authorizationDecision,
              mutation.operation as 'install' | 'update' | 'enable',
              candidate.controller.generationView,
            )
          } else {
            await runtimeScope.broker()!.authorizeActivation(
              candidate.controller.identity,
              mutation.authorizationDecision,
              mutation.operation as 'install' | 'update' | 'enable',
              candidate.controller.generationView,
            )
          }
        }
      }
      await runtimeScope.broker()!.settled()
      const candidateById = new Map(candidates.map(controller => [controller.item.id, controller]))
      for (const id of topologicalActivationOrder(mutation.candidate, affected)) {
        const activation = mutation.candidate.plugins.find(item => item.id === id)
        const controller = candidateById.get(id)
        if (activation?.enabled !== true || controller === undefined) {
          continue
        }
        if (runtimeScope.blockedPlugins()!.has(id)) {
          throw new Error(`candidate plugin ${id} is blocked`)
        }
        await runtimeScope.mountPlugin()!(controller)
        if (controller.status !== 'active') {
          throw new Error(
            `candidate plugin ${id} is not ready: ${controller.blockedReason ?? controller.error ?? controller.status}`,
          )
        }
      }
      const readiness = runtimeScope.generationVisibility()!.confirmReadiness(handle)
      if (
        (mutation.expectedRegistryEpoch !== undefined
          && readiness.expectedRegistryEpoch !== mutation.expectedRegistryEpoch)
        || (mutation.afterRegistryEpoch !== undefined
          && readiness.afterRegistryEpoch !== mutation.afterRegistryEpoch)
      ) {
        throw new Error('shared registry epoch does not match the Host activation plan')
      }
      runtimeScope.generationTransactions()!.set(mutation.transactionId, {
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
      await runtimeScope.disposeControllers()!(candidates, mutation.candidate, disposedCandidates).catch(() =>
        undefined
      )
      runtimeScope.generationTransactions()!.set(mutation.transactionId, {
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
      runtimeScope.notificationsSuppressed = false
    }
  })
  runtimeScope.operation = task.catch(() => {})
  return task
}

export const createRuntimePublishPluginMutation = (
  runtimeScope: RuntimeClosureScope,
  transactionId: string,
): Promise<PluginGenerationPublication> => {
  const task = runtimeScope.operation.then(async () => {
    const transaction = runtimeScope.generationTransactions()!.get(transactionId)
    if (transaction === undefined) {
      throw new Error('unknown plugin generation transaction')
    }
    if (transaction.failedStage || transaction.readiness === undefined) {
      throw new Error('plugin generation readiness failed')
    }
    if (transaction.publication === undefined) {
      const barrier = runtimeScope.generationVisibility()!.preparePublish(transaction.handle, transaction.readiness)
      runtimeScope.notificationsSuppressed = true
      try {
        runtimeScope.orderControllersFor()!(transaction.candidateActivation)
        transaction.publication = runtimeScope.generationVisibility()!.publish(barrier)
        runtimeScope.currentActivation = transaction.candidateActivation
        await runtimeScope.routeService?.settled()
        await runtimeScope.broker()!.settled()
        await runtimeScope.drainSuppressedNotifications()!()
        runtimeScope.notifyBatch()!()
        // Let synchronous subscribers enqueue their projection microtasks while
        // registry-local notifications are still suppressed. Drain the finite
        // projection/diagnostic microtask cascade without yielding a macrotask.
        await runtimeScope.drainBatchSubscriberMicrotasks()!()
      } finally {
        runtimeScope.notificationsSuppressed = false
      }
    }
    return transaction.publication
  })
  runtimeScope.operation = task.catch(() => {})
  return task
}

export const createRuntimeCompletePluginMutation = (
  runtimeScope: RuntimeClosureScope,
  transactionId: string,
): Promise<RendererGenerationCleanupObservation> => {
  const task = runtimeScope.operation.then(async () => {
    const transaction = runtimeScope.generationTransactions()!.get(transactionId)
    if (transaction?.publication === undefined) {
      throw new Error('plugin generation is not published')
    }
    runtimeScope.notificationsSuppressed = true
    try {
      await runtimeScope.disposeControllers()!(
        transaction.previous,
        transaction.previousActivation,
        transaction.disposedAfter,
      )
      await runtimeScope.drainSuppressedNotifications()!()
    } finally {
      runtimeScope.notificationsSuppressed = false
    }
    return {
      transactionId,
      transactionEpoch: transaction.publication.transactionEpoch,
      registryEpoch: transaction.publication.registryEpoch,
      active: transaction.candidateActivation,
      disposedAfter: transaction.previousActivation,
    }
  })
  runtimeScope.operation = task.catch(() => {})
  return task
}

export const createRuntimeFinalizePluginMutation = (
  runtimeScope: RuntimeClosureScope,
  transactionId: string,
): Promise<void> => {
  const task = runtimeScope.operation.then(() => {
    if (runtimeScope.finalizedTransactions()!.has(transactionId)) {
      return
    }
    const transaction = runtimeScope.generationTransactions()!.get(transactionId)
    if (transaction?.publication === undefined || transaction.disposedAfter.length !== transaction.previous.length) {
      throw new Error('plugin generation cleanup is incomplete')
    }
    runtimeScope.generationVisibility()!.completeLastGood(transaction.publication)
    runtimeScope.currentActivation = committedActivation(transaction.candidateActivation)
    runtimeScope.generationTransactions()!.delete(transactionId)
    runtimeScope.rememberFinalizedTransaction()!(transactionId, transaction)
  })
  runtimeScope.operation = task.catch(() => {})
  return task
}

export const createRuntimeCommitPluginMutation = async (
  runtimeScope: RuntimeClosureScope,
  transactionId: string,
): Promise<void> => {
  await runtimeScope.publishPluginMutation()!(transactionId)
  await runtimeScope.completePluginMutation()!(transactionId)
  await runtimeScope.finalizePluginMutation()!(transactionId)
}

export const createRuntimeRollbackPluginMutation = (
  runtimeScope: RuntimeClosureScope,
  transactionId: string,
): Promise<RendererGenerationCleanupObservation> => {
  const task = runtimeScope.operation.then(async () => {
    const cached = runtimeScope.rollbackReceipts()!.get(transactionId)
    if (cached !== undefined) {
      return cloneRendererValue(cached)
    }
    const liveTransaction = runtimeScope.generationTransactions()!.get(transactionId)
    const finalizedTransaction = runtimeScope.finalizedTransactions()!.get(transactionId)
    const transaction = liveTransaction ?? finalizedTransaction
    if (transaction === undefined) {
      throw new Error('unknown plugin generation transaction')
    }
    const disposedCandidates: string[] = []
    if (transaction.publication === undefined) {
      runtimeScope.notificationsSuppressed = true
      try {
        await runtimeScope.disposeControllers()!(
          transaction.candidates,
          transaction.candidateActivation,
          disposedCandidates,
        )
        await runtimeScope.drainSuppressedNotifications()!()
        const registryEpoch = runtimeScope.generationVisibility()!.rollbackUnpublished(transaction.handle)
        runtimeScope.generationTransactions()!.delete(transactionId)
        return runtimeScope.rememberRollbackReceipt()!({
          transactionId,
          transactionEpoch: transaction.handle.transactionEpoch,
          registryEpoch,
          active: transaction.previousActivation,
          disposedAfter: transaction.candidateActivation,
        })
      } finally {
        runtimeScope.notificationsSuppressed = false
      }
    } else {
      runtimeScope.notificationsSuppressed = true
      try {
        if (finalizedTransaction !== undefined && transaction.finalizedRollbackStarted !== true) {
          runtimeScope.generationVisibility()!.rollbackLastGood(transaction.publication)
          runtimeScope.currentActivation = transaction.previousActivation
          transaction.finalizedRollbackStarted = true
        }
        if (finalizedTransaction !== undefined) {
          for (const controller of transaction.previous) {
            delete controller.generationContext
            delete controller.generationView
          }
        }
        await runtimeScope.restoreControllers()!(
          transaction.previous,
          transaction.previousActivation,
          transaction.disposedAfter,
          finalizedTransaction === undefined ? transaction.publication : undefined,
        )
        runtimeScope.orderControllersFor()!(transaction.previousActivation)
        if (finalizedTransaction === undefined) {
          runtimeScope.generationVisibility()!.rollback(transaction.publication)
          runtimeScope.currentActivation = transaction.previousActivation
        }
        await runtimeScope.disposeControllers()!(
          transaction.candidates,
          transaction.candidateActivation,
          disposedCandidates,
        )
        await runtimeScope.routeService?.settled()
        await runtimeScope.broker()!.settled()
        if (finalizedTransaction === undefined) {
          runtimeScope.generationVisibility()!.completeRollback(transaction.publication)
        }
        await runtimeScope.drainSuppressedNotifications()!()
        runtimeScope.notifyBatch()!()
        await runtimeScope.drainBatchSubscriberMicrotasks()!()
      } finally {
        runtimeScope.notificationsSuppressed = false
      }
    }
    runtimeScope.generationTransactions()!.delete(transactionId)
    runtimeScope.finalizedTransactions()!.delete(transactionId)
    return runtimeScope.rememberRollbackReceipt()!({
      transactionId,
      transactionEpoch: transaction.handle.transactionEpoch,
      registryEpoch: runtimeScope.generationVisibility()!.registryEpoch(),
      active: transaction.previousActivation,
      disposedAfter: transaction.candidateActivation,
    })
  })
  runtimeScope.operation = task.catch(() => {})
  return task
}
