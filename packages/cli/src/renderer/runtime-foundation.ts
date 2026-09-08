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
  agentRuntimePermissionManifestVersion,
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
import { createHostAgentTaskDetailsNavigator } from './host-ui/AgentTaskDetailsNavigator.js'
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
  channelManagerCapabilityProvider,
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
  controllerHasRuntimeModule,
  isExplicitLocalDevelopmentArtifact,
  manifestUsesHostDom,
  MAX_ROLLBACK_RECEIPTS,
  PluginController,
  RendererGenerationCleanupObservation,
  RendererGenerationTransaction,
} from './runtime-shared.js'

export const createRuntimeRecordUnknownError = (runtimeScope: RuntimeClosureScope, event: Event): void => {
  const candidate = event as Event & {
    readonly filename?: unknown
    readonly error?: unknown
    readonly reason?: unknown
  }
  const error = candidate.error ?? candidate.reason
  let evidence = typeof candidate.filename === 'string' ? candidate.filename : ''
  try {
    if (error instanceof Error && typeof error.stack === 'string') {
      evidence += `\n${error.stack}`
    } else if (error !== undefined) {
      evidence += `\n${String(error)}`
    }
  } catch { /* hostile rejection values do not affect the runtime */ }
  const matches = runtimeScope.pluginErrorOwners()!.filter(owner =>
    owner.source !== '' && evidence.includes(owner.source)
  )
  if (matches.length === 1) {
    runtimeScope.pluginConsole()!.recordBestEffortError(matches[0]!.principal, `window.${event.type}`, error)
  } else if (matches.length > 1) {
    runtimeScope.pluginConsole()!.recordUnattributedError(
      `${event.type}:${matches.map(owner => owner.identity.id).sort().join(',')}`,
    )
  }
}

export const createRuntimeDisconnectPluginConsoleVisibility = (runtimeScope: RuntimeClosureScope) =>
  runtimeScope.generationVisibility()!.connect({
    prepare: transition => {
      runtimeScope.consoleAffectedPluginIds = transition.affectedPluginIds
    },
    notify: () => runtimeScope.pluginConsole()!.visibilityChanged(runtimeScope.consoleAffectedPluginIds),
  })

export const createRuntimeBroker = (runtimeScope: RuntimeClosureScope) =>
  new PermissionBroker(
    runtimeScope.permissionStore()!,
    new BrowserPermissionPrompt(),
    () => new Date(),
    30000,
    runtimeScope.metadata()!.profileId,
    runtimeScope.generation()!,
    runtimeScope.generationVisibility()!,
    runtimeScope.pluginConsole()!,
    new BrowserPermissionAuthorizationPromptV2(document),
  )

export const createRuntimeHostDomAuthority = (runtimeScope: RuntimeClosureScope) =>
  new HostDomAuthority({
    hostGeneration: runtimeScope.generation()!,
    isolatedPluginBoundary: true,
    roots: createCordisXHostDomRootDefinitions(document),
  })

export const createRuntimeSimulatorPersistence = (runtimeScope: RuntimeClosureScope) => ({
  read: () => {
    try {
      return document.defaultView?.sessionStorage.getItem(runtimeScope.simulatorSessionKey()!) ?? undefined
    } catch {
      return undefined
    }
  },
  write: (value: string) => {
    try {
      document.defaultView?.sessionStorage.setItem(runtimeScope.simulatorSessionKey()!, value)
    } catch { /* unavailable browser storage */ }
  },
})

export const createRuntimeSimulatorV4Persistence = (runtimeScope: RuntimeClosureScope) => ({
  read: () => {
    try {
      return document.defaultView?.sessionStorage.getItem(`${runtimeScope.simulatorSessionKey()!}:agent-loop-v4-ledger`)
        ?? undefined
    } catch {
      return undefined
    }
  },
  write: (value: string) => {
    try {
      document.defaultView?.sessionStorage.setItem(`${runtimeScope.simulatorSessionKey()!}:agent-loop-v4-ledger`, value)
    } catch { /* unavailable browser storage */ }
  },
})

export const createRuntimeAgentLoopHost = (runtimeScope: RuntimeClosureScope) =>
  runtimeScope.playgroundMockAgentLoop()! ?? (runtimeScope.bindingPlatformAdapter === undefined
    ? new UnavailableAgentLoopHost()
    : new BindingAgentLoopHost(runtimeScope.bindingPlatformAdapter, runtimeScope.metadata()!.workspaceCwd))

export const createRuntimeAgentLoopBrokerV2 = (runtimeScope: RuntimeClosureScope) =>
  new CordisXAgentLoopBrokerV2(
    runtimeScope.agentLoopHost()!,
    undefined,
    runtimeScope.metadata()!.agentLoopBackend === 'mock'
      ? {
        providerKey: PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE,
        read: () => {
          try {
            return document.defaultView?.sessionStorage.getItem(
              `${runtimeScope.simulatorSessionKey()!}:agent-loop-v2-ledger`,
            )
              ?? undefined
          } catch {
            return undefined
          }
        },
        write: (value: string) => {
          try {
            document.defaultView?.sessionStorage.setItem(
              `${runtimeScope.simulatorSessionKey()!}:agent-loop-v2-ledger`,
              value,
            )
          } catch { /* unavailable browser storage */ }
        },
      }
      : undefined,
  )

export const createRuntimeAgentLoopBrokerV4 = (runtimeScope: RuntimeClosureScope) =>
  new CordisXAgentLoopBrokerV4(
    runtimeScope.playgroundMockAgentLoopV4Transport()! ?? runtimeScope.bindingPlatformAdapter,
    runtimeScope.agentLoopHost()!,
    runtimeScope.metadata()!.profileId,
    runtimeScope.generation()!,
  )

export const createRuntimePlaygroundAgentSessionPersistence = (runtimeScope: RuntimeClosureScope) =>
  runtimeScope.metadata()!.hostKind === 'playground'
    && runtimeScope.metadata()!.playgroundAgentSessionStoreToken! !== undefined
    ? BrowserPlaygroundAgentSessionPersistence.connect(
      runtimeScope.metadata()!.playgroundAgentSessionStoreToken!,
      runtimeScope.generation()!,
    )
    : undefined

export const createRuntimeAgentRuntimeConnection = (runtimeScope: RuntimeClosureScope): AgentRuntimeConnection =>
  Object.freeze({
    connectionId: runtimeScope.metadata()!.hostKind === 'playground'
      ? 'development-host-transport'
      : runtimeScope.desktopAgentSessionTransport()! === undefined
      ? 'unavailable-host-transport'
      : 'desktop-current-transport',
    generation: 1,
  })

export const createRuntimePlaygroundScenarioAgentRuntimeRoute = (runtimeScope: RuntimeClosureScope) =>
  runtimeScope.metadata()!.hostKind === 'playground'
    && runtimeScope.metadata()!.playgroundSessionScenarios?.enabled === true
    ? runtimeScope.broker()!.createPlaygroundScenarioAgentRuntimeRouteAuthority()
    : undefined

export const createRuntimeAgentOwnerForController = (
  runtimeScope: RuntimeClosureScope,
  controller: PluginController,
): AgentActiveRoute['owner'] => {
  const owner = runtimeScope.agentSessionRuntime.ownerForPlugin(
    controller.item.source,
    controller.item.id,
    runtimeScope.moduleGenerationOf()!(controller),
  )
  runtimeScope.agentOwnerControllers()!.set(runtimeScope.agentOwnerKey()!(owner), controller)
  return owner
}

export const createRuntimeControllerForAgentOwner = (
  runtimeScope: RuntimeClosureScope,
  owner: AgentActiveRoute['owner'],
): PluginController | undefined => {
  const controller = runtimeScope.agentOwnerControllers()!.get(runtimeScope.agentOwnerKey()!(owner))
  return controller !== undefined && controller.principalLive ? controller : undefined
}

export const createRuntimeActualAgentRuntimeRoute = (runtimeScope: RuntimeClosureScope):
  | Readonly<{
    readonly scope: AgentRuntimeRouteScope
    readonly owner: AgentActiveRoute['owner']
  }>
  | undefined =>
{
  const snapshot = runtimeScope.routeHistory()!.snapshot()
  const entry = snapshot.entry
  const route = entry === undefined ? undefined : runtimeScope.routeService?.agentRuntimeRouteFromHistory(entry)
  const controller = route === undefined
    ? undefined
    : runtimeScope.controllers()!.find(item => (item.item.source === route.owner.source
      && item.item.id === route.owner.pluginId
      && runtimeScope.moduleGenerationOf()!(item) === route.owner.moduleGeneration)
    )
  const sessionId = entry?.params.sessionId
  if (
    entry === undefined || controller === undefined || route === undefined || typeof sessionId !== 'string'
    || sessionId === '*'
  ) {
    return undefined
  }
  return Object.freeze({
    owner: runtimeScope.agentOwnerForController()!(controller),
    scope: Object.freeze({
      kind: 'host-route' as const,
      active: true as const,
      owner: Object.freeze({ source: controller.item.source, pluginId: controller.item.id }),
      routeId: route.id,
      routeInstanceId: `${entry.outlet}:${snapshot.key ?? 'unkeyed'}`,
      path: route.path,
      params: Object.freeze({ sessionId }),
    }),
  })
}

export const createRuntimeAgentRouteScopes = (runtimeScope: RuntimeClosureScope): AgentRouteSessionScopeAuthority => {
  const authority = new AgentRouteSessionScopeAuthority({
    activeRoute: (): AgentActiveRoute | undefined => {
      const supplementalOwner = runtimeScope.scenarioSessionScopeAuthority!?.supplementalOwner()
      if (supplementalOwner !== undefined) {
        const route = runtimeScope.scenarioSessionScopeAuthority!?.effectiveRoute()
        return route === undefined ? undefined : {
          owner: supplementalOwner,
          routeId: route.routeId,
          instanceId: route.routeInstanceId,
          params: route.params,
        }
      }
      const actual = runtimeScope.actualAgentRuntimeRoute()!()
      return actual === undefined ? undefined : {
        owner: actual.owner,
        routeId: actual.scope.routeId,
        instanceId: actual.scope.routeInstanceId,
        params: actual.scope.params,
      }
    },
    routes: owner => {
      const controller = runtimeScope.controllerForAgentOwner()!(owner)
      return controller === undefined ? [] : runtimeScope.routeService?.agentRuntimeRoutesForOwner({
        source: controller.item.source,
        pluginId: controller.item.id,
        moduleGeneration: runtimeScope.moduleGenerationOf()!(controller),
      }, controller.generationView) ?? []
    },
    decide: async (plan) => {
      const controller = runtimeScope.controllerForAgentOwner()!(plan.owner)
      if (controller === undefined) {
        return Object.freeze({ authorized: false })
      }
      const input = {
        identity: controller.identity,
        capability: plan.capability,
        sessionId: plan.scope.sessionIds[0],
        scopeSource: plan.scopeSource,
        connection: runtimeScope.agentRuntimeConnection()!,
      }
      const decision = runtimeScope.developmentAgentRuntimeAuthorization()! !== undefined
          && isExplicitLocalDevelopmentArtifact(controller.item)
        ? await runtimeScope.broker()!.authorizeDevelopmentAgentRuntime(
          runtimeScope.developmentAgentRuntimeAuthorization()!,
          input,
        )
        : await runtimeScope.broker()!.authorizeAgentRuntime(input)
      return Object.freeze({
        authorized: decision.authorized,
        ...(decision.lease === undefined ? {} : { leaseId: decision.lease.leaseId }),
      })
    },
    isLeaseActive: (owner, leaseId) => {
      const identity = runtimeScope.controllerForAgentOwner()!(owner)?.identity
      return identity !== undefined && runtimeScope.broker()!.isAgentRuntimeLeaseActive(identity, leaseId)
    },
    connectionGeneration: () => runtimeScope.agentRuntimeConnection()!.generation,
  })
  runtimeScope.broker()!.setAgentTaskScopeValidator((identity, capability, sessionId, source) => {
    const owner = source.kind === 'host-agent-task' ? source.owner : source.lease.taskSource.owner
    const controller = runtimeScope.controllerForAgentOwner()!(owner)
    return controller?.identity.source === identity.source && controller?.identity.id === identity.id
      && authority.tasks.validate(owner, capability, sessionId, source)
  }, async (_identity, capability, sessionId, source) => {
    const owner = source.kind === 'host-agent-task' ? source.owner : source.lease.taskSource.owner
    return await authority.tasks.readback(owner, capability, sessionId, source)
  })
  return authority
}

export const createRuntimeReconcileAgentRuntimeRoute = (runtimeScope: RuntimeClosureScope): void => {
  if (runtimeScope.agentRuntimeRouteDisposed || runtimeScope.reconcilingAgentRuntimeRoute) {
    return
  }
  runtimeScope.reconcilingAgentRuntimeRoute = true
  try {
    runtimeScope.scenarioSessionScopeAuthority!?.reconcileVisibleRoute()
    const route = runtimeScope.actualAgentRuntimeRoute()!()
    if (route === undefined) {
      if (runtimeScope.activeAgentRuntimeRouteInstance !== undefined) {
        runtimeScope.broker()!.revokeAgentRuntimeRoute(runtimeScope.activeAgentRuntimeRouteInstance)
      }
      runtimeScope.activeAgentRuntimeRouteInstance = undefined
      runtimeScope.agentRouteScopes()!.reconcileRoutes()
      return
    }
    if (
      runtimeScope.activeAgentRuntimeRouteInstance !== undefined
      && runtimeScope.activeAgentRuntimeRouteInstance !== route.scope.routeInstanceId
    ) {
      runtimeScope.broker()!.revokeAgentRuntimeRoute(runtimeScope.activeAgentRuntimeRouteInstance)
    }
    runtimeScope.broker()!.replaceAgentRuntimeRouteScope(route.scope)
    runtimeScope.activeAgentRuntimeRouteInstance = route.scope.routeInstanceId
    if (runtimeScope.scenarioSessionScopeAuthority!?.active() !== true) {
      runtimeScope.agentRouteScopes()!.reconcileRoutes()
    }
  } finally {
    runtimeScope.reconcilingAgentRuntimeRoute = false
  }
}

export const createRuntimeAgentSessionTransport = (runtimeScope: RuntimeClosureScope): CordisXPrivateAgentDriver =>
  runtimeScope.metadata()!.hostKind === 'playground'
    ? new DeterministicAgentSessionTransport({
      recoveredSessions: runtimeScope.recoveredPlaygroundSessions()!,
      ...(runtimeScope.metadata()!.playgroundSessionScenarios === undefined
        ? {}
        : { scenarioCatalog: runtimeScope.metadata()!.playgroundSessionScenarios }),
      ...(runtimeScope.playgroundRoomSimulationBridgeRegistry()! === undefined
        ? {}
        : { roomBridge: runtimeScope.playgroundRoomSimulationBridgeRegistry()!.client }),
      ...(runtimeScope.scenarioSessionScopeAuthority! === undefined
        ? {}
        : { scenarioSessionScope: runtimeScope.scenarioSessionScopeAuthority!.client }),
    })
    : runtimeScope.desktopAgentSessionTransport()! ?? new UnavailableAgentSessionTransport()

export const createRuntimeAgentDetailNavigator = (runtimeScope: RuntimeClosureScope) =>
  createHostAgentTaskDetailsNavigator(runtimeScope.routeHistory()!, window)

export const createRuntimeAgentDetailHistoryIdentity = (runtimeScope: RuntimeClosureScope) => {
  const state = window.history.state
  const key = state !== null && typeof state === 'object' && typeof (state as {
        key?: unknown
      }).key === 'string'
    ? (state as {
      readonly key: string
    }).key
    : undefined
  const index = state !== null && typeof state === 'object' && Number.isSafeInteger(
      (state as {
        idx?: unknown
      }).idx,
    )
    ? (state as {
      readonly idx: number
    }).idx
    : undefined
  return Object.freeze({
    path: window.location.pathname,
    ...(key === undefined ? {} : { key }),
    ...(index === undefined ? {} : { index }),
  })
}

export const createRuntimeRestoreAgentDetailReturn = (runtimeScope: RuntimeClosureScope) => {
  const pending = runtimeScope.pendingAgentDetailReturn
  const current = runtimeScope.agentDetailHistoryIdentity()!()
  const sameEntry = pending !== undefined
    && pending.identity.key !== undefined && pending.identity.index !== undefined
    && pending.identity.key === current.key && pending.identity.index === current.index
  if (pending === undefined || sameEntry || current.path === pending.identity.path && current.key === undefined) {
    return
  }
  runtimeScope.pendingAgentDetailReturn = undefined
  pending.restore()
}

export const createRuntimeDisposeAgentRouteFences = (runtimeScope: RuntimeClosureScope) =>
  runtimeScope.agentRouteScopes()!.subscribe((owner, sessionId, code) => {
    runtimeScope.scenarioSessionScopeAuthority!?.fenceSession(sessionId, code)
    runtimeScope.agentSessionRuntime.fenceSession(sessionId, code)
    if (code !== 'route-replaced') {
      runtimeScope.agentSessionRuntime.fenceOwner(owner, code)
    }
  })

export const createRuntimeDisposeAgentPermissionFences = (runtimeScope: RuntimeClosureScope) =>
  runtimeScope.broker()!.subscribeAgentRuntimePermissionFences(fence => {
    const owner = `${fence.identity.source}:${fence.identity.id}`
    runtimeScope.scenarioSessionScopeAuthority!?.fenceSession(fence.sessionId, fence.code)
    if (fence.code === 'route-replaced') {
      runtimeScope.agentRouteScopes()!.reconcileRoutes()
    } else {
      runtimeScope.agentRouteScopes()!.revoke(owner, fence.code)
    }
    runtimeScope.agentSessionRuntime.fenceSession(fence.sessionId, fence.code)
    if (fence.code !== 'route-replaced') {
      runtimeScope.agentSessionRuntime.fenceOwner(owner, fence.code)
    }
  })

export const createRuntimeBootstrapResult = async (runtimeScope: RuntimeClosureScope) =>
  await runtimeScope.internalBootstrap()!?.(Object.freeze({
    connectors: runtimeScope.connectorBroker()!,
    ...(runtimeScope.developmentPolicySeed()! === undefined ? {} : {
      agentRuntimePolicies: Object.freeze({
        seed: async (
          identity: CordisXPluginIdentity,
          entries: readonly Readonly<{
            capability: import('@cordisx/protocol/agents/v1').AgentRuntimeCapability
            sessionIds: readonly [
              string,
              ...string[],
            ]
            policy: 'ask' | 'allow-persistent' | 'deny-persistent'
          }>[],
        ) =>
          await runtimeScope.broker()!.seedAgentRuntimePolicies(
            runtimeScope.developmentPolicySeed()!,
            identity,
            entries,
          ),
      }),
    }),
  }))

export const createRuntimeExternalProviderStatuses = (runtimeScope: RuntimeClosureScope) =>
  runtimeScope.boundProviderStatuses()!.length > 0
    ? runtimeScope.boundProviderStatuses()!
    : runtimeScope.metadata()!.providers.map(provider => ({
      providerId: provider.id,
      displayName: provider.displayName,
      state: 'unavailable' as const,
    }))

export const createRuntimeCapabilityAvailability = (runtimeScope: RuntimeClosureScope) =>
  new CapabilityAvailabilityRegistry([
    platformAdapterCapabilityProvider(runtimeScope.agentAdapter()!.status(), {
      providerId: 'desktop-current-connection',
      kind: 'current-connection',
    }),
    ...externalProviderCapabilityProviders(runtimeScope.externalProviderStatuses()!),
    channelManagerCapabilityProvider(),
    ...hostLocalCapabilityProviders({
      agentStatus: runtimeScope.agentRuntime()!.status(),
      historyStatus: {
        hostId: 'cordisx-host',
        hostName: 'CordisX Host',
        mode: 'unavailable',
        adapterId: 'retired-agent-history',
        adapterVersion: 'none',
        profileId: runtimeScope.metadata()!.profileId,
        defaultPayloadPolicy: 'referenced',
        diagnostics: [{ code: 'history-unavailable', severity: 'info', count: 1 }],
        filesystemExposed: false,
        rawBridgeExposed: false,
      },
      configurationWritable: runtimeScope.configBridge()! !== undefined,
      packageLifecycleAvailable: runtimeScope.lifecycleBridge()! !== undefined,
    }),
  ])

export const createRuntimeExtensionPointBroker = (runtimeScope: RuntimeClosureScope) =>
  new ExtensionPointPolicyBroker(
    runtimeScope.extensionPointDescriptors()!,
    new MemoryExtensionPointPolicyStore(),
    runtimeScope.generation()!,
    runtimeScope.generationVisibility()!,
    {
      access: (identity, pointId, view) => runtimeScope.broker()!.domAccess(identity, pointId, view),
      policy: (identity, pointId) => runtimeScope.broker()!.domPolicy(identity, pointId),
      policies: () => runtimeScope.broker()!.domPolicies(),
    },
  )

export const createRuntimeModuleGenerationOf = (
  runtimeScope: RuntimeClosureScope,
  controller: PluginController,
): string => (controller.item.package?.moduleGeneration
  ?? controller.item.artifactGeneration
  ?? `${runtimeScope.generation()!}:${controller.item.id}:bundled`)

export const createRuntimeProjectedControllers = (runtimeScope: RuntimeClosureScope): PluginController[] =>
  runtimeScope.controllers()!.filter(controller => (runtimeScope.generationVisibility()!.projected({
    pluginId: controller.item.id,
    moduleGeneration: runtimeScope.moduleGenerationOf()!(controller),
  })))

export const createRuntimeActiveControllers = (runtimeScope: RuntimeClosureScope): PluginController[] =>
  runtimeScope.projectedControllers()!().filter(controller =>
    runtimeScope.generationVisibility()!.visible({
      pluginId: controller.item.id,
      moduleGeneration: runtimeScope.moduleGenerationOf()!(controller),
    })
  )

export const createRuntimeActiveController = (
  runtimeScope: RuntimeClosureScope,
  id: string,
  source?: string,
): PluginController | undefined =>
  runtimeScope.projectedControllers()!().find(
    controller => (controller.item.id === id && (source === undefined || controller.item.source === source)),
  )

export const createRuntimeRequiredBlockReason = (
  runtimeScope: RuntimeClosureScope,
  controller: PluginController,
): string | undefined => {
  if (
    (controller.manifest.schemaVersion === 11 || controller.manifest.schemaVersion === 12
      || controller.manifest.schemaVersion === 13)
    && controller.manifest.capabilities.some(item => item.name === 'usage.read' && item.required)
  ) {
    if (runtimeScope.metadata()!.agentHistoryBridgeToken === undefined) {
      return 'Required capability unavailable: usage.read'
    }
    if (runtimeScope.broker()!.usageDenied(controller.identity)) return 'Required capability denied: usage.read'
  }
  const denied = runtimeScope.broker()!.requiredDenied(controller.identity, controller.generationView)
  if (denied.length > 0) {
    return `Required capability denied: ${denied.join(', ')}`
  }
  const declarations = controller.manifest.capabilities.flatMap(
    item => ((CORDISX_PLATFORM_CAPABILITIES as readonly string[]).includes(item.name) && !('runtime' in item.scope)
      ? [{
        name: item.name as CordisXPlatformCapability,
        required: item.required,
        scope: item.scope as CordisXCapabilityScope,
      }]
      : []),
  )
  const isolatedHostDom = controller.item.isolatedArtifactSource !== undefined
    && manifestUsesHostDom(controller.manifest)
  const unavailable = runtimeScope.capabilityAvailability()!.unavailableRequired(declarations)
  const explicitlyAllowedInPlayground = runtimeScope.metadata()!.hostKind === 'playground'
    && unavailable.every(capability =>
      runtimeScope.broker()!.snapshots().some(permission => (permission.identity.source === controller.identity.source
        && permission.identity.id === controller.identity.id
        && permission.capability === capability
        && permission.policy === 'allow')
      )
    )
  if (unavailable.length > 0 && !explicitlyAllowedInPlayground) {
    return `Required capability unavailable: ${unavailable.join(', ')}`
  }
  const requiredHostDom = controller.manifest.schemaVersion === 5 || controller.manifest.schemaVersion === 6
      || controller.manifest.schemaVersion === 8 || controller.manifest.schemaVersion === 9
    ? controller.manifest.capabilities.find(
      item => (item.required && (item.name === 'ui.host-dom.read' || item.name === 'ui.host-dom.modify')),
    )
    : undefined
  if (requiredHostDom !== undefined && !isolatedHostDom) {
    return `Required capability unavailable: ${requiredHostDom.name}`
  }
  return undefined
}

export const createRuntimeRegisterController = (
  runtimeScope: RuntimeClosureScope,
  controller: PluginController,
  registerAuthority = true,
): void => {
  if (registerAuthority) {
    const artifact = controller.item.package === undefined ? undefined : {
      version: controller.item.package.version,
      integrity: controller.item.package.digest,
    }
    controller.unregisterPermissions = runtimeScope.broker()!.register(
      controller.identity,
      controller.manifest,
      {
        pluginId: controller.item.id,
        moduleGeneration: runtimeScope.moduleGenerationOf()!(controller),
        ...(controller.generationView?.transactionId === undefined ? {} : {
          transactionId: controller.generationView.transactionId,
          transactionEpoch: controller.generationView.transactionEpoch,
        }),
      },
      controller.generationView,
      artifact,
    )
    controller.unregisterExtensionPoints = runtimeScope.extensionPointBroker()!.register(controller.identity, {
      pluginId: controller.item.id,
      moduleGeneration: runtimeScope.moduleGenerationOf()!(controller),
      ...(controller.generationView?.transactionId === undefined ? {} : {
        transactionId: controller.generationView.transactionId,
        transactionEpoch: controller.generationView.transactionEpoch,
      }),
    }, controller.generationView)
    const agentRuntimeManifestVersion = agentRuntimePermissionManifestVersion(controller.manifest.schemaVersion)
    const agentRuntimeDeclarations = agentRuntimeManifestVersion !== undefined
      ? controller.manifest.capabilities
        .filter((
          item,
        ): item is
          & typeof item
          & AgentRuntimePermissionDeclaration => (item.name.startsWith('agents.') || item.name.startsWith('sessions.')
            || item.name.startsWith('approvals.'))
        )
        .map(item => Object.freeze({ ...item, manifestVersion: agentRuntimeManifestVersion }))
      : []
    runtimeScope.agentRouteScopes()!.install(
      runtimeScope.agentOwnerForController()!(controller),
      agentRuntimeDeclarations,
    )
  }
  const configSchema = moduleConfigSchema(controller.item.module)
  const configApplies = controller.item.isolatedArtifactSource === undefined
    ? moduleConfigApplies(controller.item.module)
    : 'plugin-restart' as const
  runtimeScope.configuration()!.register({
    identity: controller.identity,
    moduleGeneration: runtimeScope.moduleGenerationOf()!(controller),
    ...(controller.generationView === undefined ? {} : { candidateView: controller.generationView }),
    ...(configSchema === undefined ? {} : { schema: configSchema }),
    applies: configApplies,
    raw: controller.item.config,
    revision: controller.item.revision,
    writable: runtimeScope.configBridge()! !== undefined
      && controller.item.enabled
      && controllerHasRuntimeModule(controller)
      && configApplies !== 'service-restart',
  })
}

export const createRuntimeUnregisterController = (
  runtimeScope: RuntimeClosureScope,
  controller: PluginController,
): void => {
  const index = runtimeScope.controllers()!.indexOf(controller)
  if (index >= 0) {
    runtimeScope.controllers()!.splice(index, 1)
  }
  controller.unregisterPermissions?.()
  delete controller.unregisterPermissions
  controller.unregisterExtensionPoints?.()
  delete controller.unregisterExtensionPoints
  const owner = `${controller.item.source}:${controller.item.id}`
  const agentOwner = runtimeScope.agentOwnerForController()!(controller)
  runtimeScope.agentRouteScopes()!.uninstall(agentOwner)
  runtimeScope.agentOwnerControllers()!.delete(runtimeScope.agentOwnerKey()!(agentOwner))
  runtimeScope.agentSessionRuntime.fenceOwner(owner, 'plugin-generation-replaced')
  runtimeScope.configuration()!.unregister(controller.item.id, runtimeScope.moduleGenerationOf()!(controller))
}

export const createRuntimeTraceNotification = (
  runtimeScope: RuntimeClosureScope,
  source: string,
  suppressed: boolean,
): void => {
  runtimeScope.generationNotificationTrace()!.push({
    source,
    registryEpoch: runtimeScope.generationVisibility()!.registryEpoch(),
    suppressed,
  })
  if (runtimeScope.generationNotificationTrace()!.length > 256) {
    runtimeScope.generationNotificationTrace()!.shift()
  }
}

export const createRuntimeRememberRollbackReceipt = (
  runtimeScope: RuntimeClosureScope,
  receipt: RendererGenerationCleanupObservation,
): RendererGenerationCleanupObservation => {
  const stored = cloneRendererValue(receipt)
  runtimeScope.rollbackReceipts()!.set(receipt.transactionId, stored)
  while (runtimeScope.rollbackReceipts()!.size > MAX_ROLLBACK_RECEIPTS) {
    const oldest = runtimeScope.rollbackReceipts()!.keys().next().value as string | undefined
    if (oldest === undefined) {
      break
    }
    runtimeScope.rollbackReceipts()!.delete(oldest)
  }
  return cloneRendererValue(stored)
}

export const createRuntimeRememberFinalizedTransaction = (
  runtimeScope: RuntimeClosureScope,
  transactionId: string,
  transaction: RendererGenerationTransaction,
): void => {
  runtimeScope.finalizedTransactions()!.set(transactionId, transaction)
  while (runtimeScope.finalizedTransactions()!.size > MAX_ROLLBACK_RECEIPTS) {
    const oldest = runtimeScope.finalizedTransactions()!.keys().next().value as string | undefined
    if (oldest === undefined) {
      break
    }
    runtimeScope.finalizedTransactions()!.delete(oldest)
  }
}

export const createRuntimeNotifyBatch = (runtimeScope: RuntimeClosureScope): void => {
  runtimeScope.traceNotification()!('generation-batch', false)
  runtimeScope.emitListeners()!()
}

export const createRuntimeNotify = (runtimeScope: RuntimeClosureScope, source = 'runtime'): void => {
  runtimeScope.traceNotification()!(source, runtimeScope.notificationsSuppressed)
  if (runtimeScope.notificationsSuppressed) {
    return
  }
  runtimeScope.emitListeners()!()
}

export const createRuntimeDrainSuppressedNotifications = async (runtimeScope: RuntimeClosureScope): Promise<void> => {
  await Promise.resolve()
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  await Promise.resolve()
}

export const createRuntimeDrainBatchSubscriberMicrotasks = async (runtimeScope: RuntimeClosureScope): Promise<void> => {
  let observed = runtimeScope.generationNotificationTrace()!.length
  let stableTurns = 0
  for (let turn = 0; turn < 32; turn += 1) {
    await Promise.resolve()
    if (runtimeScope.generationNotificationTrace()!.length === observed) {
      stableTurns += 1
      if (stableTurns === 2) {
        return
      }
    } else {
      observed = runtimeScope.generationNotificationTrace()!.length
      stableTurns = 0
    }
  }
  throw new Error('generation batch subscribers did not reach a microtask fixed point')
}

export const createRuntimeSettleRegistryProjection = (runtimeScope: RuntimeClosureScope): Promise<void> => {
  const task = runtimeScope.operation.then(async () => {
    if (runtimeScope.disposed) {
      throw new Error('CordisX runtime is disposed')
    }
    await runtimeScope.drainBatchSubscriberMicrotasks()!()
  })
  runtimeScope.operation = task.catch(() => {})
  return task
}

export const createRuntimeRememberRegistrations = (runtimeScope: RuntimeClosureScope, pluginId: string): void => {
  const controller = runtimeScope.activeController()!(pluginId)
  if (controller === undefined) {
    return
  }
  const registrations = runtimeScope.slotService?.snapshot().filter(item => item.owner === pluginId) ?? []
  if (registrations.length > 0) {
    runtimeScope.knownRegistrations()!.set(
      `${pluginId}\u0000${runtimeScope.moduleGenerationOf()!(controller)}`,
      registrations,
    )
  }
}
