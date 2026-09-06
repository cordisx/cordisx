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
import {
  HostManagerNavigationController,
  resolveHostManagerAgentDefinitionOpenRequest,
} from './manager/navigation-controller.js'
import { selectPluginReadme } from './readme.js'
import { CordisXCommandService } from './commands.js'
import { CordisXAgentConversationShellService } from './agent-conversation-shell.js'
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
import {
  type ChannelManagerProjectionV1,
  type ChannelManagerServiceInput,
  CordisXChannelManagerService,
} from './channel-manager.js'
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

export const createRuntimeAgentSessionRuntime = (runtimeScope: RuntimeClosureScope) =>
  new CordisXAgentSessionRuntime({
    driver: runtimeScope.agentSessionTransport()!,
    navigateAgentDetail: async (detail, sessionId) => {
      const restore = runtimeScope.managerNavigationController()!.captureReturn()
      await runtimeScope.agentDetailNavigator()!.navigateAgentDetail(detail, sessionId)
      if (restore !== undefined) {
        runtimeScope.pendingAgentDetailReturn = Object.freeze(
          {
            identity: runtimeScope.agentDetailHistoryIdentity()!(),
            restore,
          },
        )
      }
    },
    authorize: async (owner, capability, sessionId) =>
      await runtimeScope.agentRouteScopes()!.authorize(owner, capability, sessionId),
    mintApprovalAuthorityLease: async (owner, input) =>
      await runtimeScope.agentRouteScopes()!.mintApprovalAuthorityLease(owner, input),
    requiresApprovalAuthorityLease: owner => runtimeScope.agentRouteScopes()!.requiresApprovalAuthorityLease(owner),
    approvalAuthorityLeaseActive: (owner, lease, requester, authority) =>
      runtimeScope.agentRouteScopes()!.approvalAuthorityLeaseActive(owner, lease, requester, authority),
    releaseApprovalAuthorityLease: lease => runtimeScope.agentRouteScopes()!.releaseApprovalAuthorityLease(lease),
    declares: (owner, capability) => runtimeScope.agentRouteScopes()!.declares(owner, capability),
    ...(runtimeScope.scenarioSessionScopeAuthority! === undefined ? {} : {
      captureSubmission: (owner, sessionId, messageId) =>
        runtimeScope.scenarioSessionScopeAuthority!.captureSubmission(owner, sessionId, messageId),
      captureAdmission: (owner, origin, sessionId, generation, messageId) =>
        runtimeScope.scenarioSessionScopeAuthority!.captureAdmission(owner, origin, sessionId, generation, messageId),
      admissionTargetActive: (owner, origin, target) =>
        runtimeScope.scenarioSessionScopeAuthority!.admissionTargetActive(owner, origin, target),
      captureAdmissionTarget: (owner, origin, target, sessionId, generation, messageId) =>
        runtimeScope.scenarioSessionScopeAuthority!.captureAdmissionTarget(
          owner,
          origin,
          target,
          sessionId,
          generation,
          messageId,
        ),
      bootstrapAdmissionTargetActive: (owner, origin, target) =>
        runtimeScope.scenarioSessionScopeAuthority!.bootstrapAdmissionTargetActive(owner, origin, target),
      captureBootstrapAdmissionTarget: (owner, origin, target, sessionId, generation, messageId) =>
        runtimeScope.scenarioSessionScopeAuthority!.captureBootstrapAdmissionTarget(
          owner,
          origin,
          target,
          sessionId,
          generation,
          messageId,
        ),
      bootstrapAdmissionRoomTargetActive: (owner, origin, target) =>
        runtimeScope.scenarioSessionScopeAuthority!.bootstrapAdmissionRoomTargetActive(owner, origin, target),
      captureBootstrapAdmissionRoomTarget: (owner, origin, target, receipt, sessionId, generation, messageId) =>
        runtimeScope.scenarioSessionScopeAuthority!.captureBootstrapAdmissionRoomTarget(
          owner,
          origin,
          target,
          receipt,
          sessionId,
          generation,
          messageId,
        ),
      bootstrapAdmissionRouteTargetActive: (owner, origin, target) =>
        runtimeScope.scenarioSessionScopeAuthority!.bootstrapAdmissionRouteTargetActive(owner, origin, target),
      bootstrapAdmissionRouteClaimActive: (owner, origin, target) =>
        runtimeScope.scenarioSessionScopeAuthority!.bootstrapAdmissionRouteClaimActive(owner, origin, target),
      captureBootstrapAdmissionRouteTarget: (owner, origin, target, continuation, sessionId, generation, messageId) =>
        runtimeScope.scenarioSessionScopeAuthority!.captureBootstrapAdmissionRouteTarget(
          owner,
          origin,
          target,
          continuation,
          sessionId,
          generation,
          messageId,
        ),
      capturePageAdmission: (owner, origin, target, sessionId, generation, messageId, commandActive, originActive) =>
        runtimeScope.scenarioSessionScopeAuthority!.capturePageAdmission(
          owner,
          origin,
          target,
          sessionId,
          generation,
          messageId,
          commandActive,
          originActive,
        ),
      claimPageAdmission: (owner, receipt, bindingActive) =>
        runtimeScope.scenarioSessionScopeAuthority!.claimPageAdmission(owner, receipt, bindingActive),
    }),
    ...(runtimeScope.playgroundAgentSessionPersistence()! === undefined ? {} : {
      persistence: runtimeScope.playgroundAgentSessionPersistence()!,
      initialSessions: runtimeScope.recoveredPlaygroundSessions()!,
    }),
    pageAdmissionBindings: runtimeScope.pageAdmissionBindings()!,
    navigatePageAdmission: async (owner, _command, route) => {
      const controller = runtimeScope.controllerForAgentOwner()!(owner)
      if (controller === undefined || runtimeScope.routeService === undefined) {
        return 'navigation-failed'
      }
      try {
        await runtimeScope.routeService.navigateFor(controller.item.id, {
          id: route.routeDefinitionId,
          params: { roomId: route.roomId },
        })
        return 'accepted'
      } catch {
        return 'navigation-failed'
      }
    },
  })

export const runRuntimeStage1188 = async (runtimeScope: RuntimeClosureScope): Promise<void> => {
  if (
    runtimeScope.metadata()!.hostKind === 'playground'
    && runtimeScope.metadata()!.playgroundSessionScenarios?.enabled === true
  ) {
    runtimeScope.scenarioSessionScopeAuthority! = new PlaygroundScenarioSessionScopeAuthority({
      hostGeneration: runtimeScope.generation()!,
      connectionGeneration: () => runtimeScope.agentRuntimeConnection()!.generation,
      currentRoute: () => runtimeScope.actualAgentRuntimeRoute()!()?.scope,
      ownerForSession: sessionId => runtimeScope.scenarioSessionOwner(sessionId),
      routeOwner: owner => {
        const controller = runtimeScope.controllerForAgentOwner()!(owner)
        return controller === undefined ? undefined : Object.freeze({
          source: controller.item.source,
          pluginId: controller.item.id,
        })
      },
      permissionRoute: (owner, capability) => {
        const route = runtimeScope.agentRouteScopes()!.permissionRoute(owner, capability)
        return route === undefined ? undefined : { routeId: route.id, path: route.path }
      },
      bootstrapRouteRegistered: (owner, target) => {
        const controller = runtimeScope.controllerForAgentOwner()!(owner)
        const route = controller === undefined ? undefined : runtimeScope.routeService?.agentRuntimeRoutesForOwner({
          source: controller.item.source,
          pluginId: controller.item.id,
          moduleGeneration: runtimeScope.moduleGenerationOf()!(controller),
        }, controller.generationView).find(candidate => candidate.id === target.route.routeId)
        return route !== undefined && target.route.param === 'roomId' && target.route.roomId === target.roomId
          && route.path.split('/').filter(segment => segment === ':roomId').length === 1
      },
      claimBootstrapRoute: (owner, request) =>
        runtimeScope.agentSessionRuntime.claimAdmissionBootstrapRoute(owner, request),
      authorize: async (owner, capability, sessionId) =>
        await runtimeScope.agentRouteScopes()!.authorize(owner, capability, sessionId),
      mountRoute: route => {
        if (runtimeScope.playgroundScenarioAgentRuntimeRoute()! === undefined) {
          throw new Error('Playground scenario route authority is unavailable')
        }
        return runtimeScope.broker()!.activateCapturedPlaygroundScenarioAgentRuntimeRoute(
          runtimeScope.playgroundScenarioAgentRuntimeRoute()!,
          route,
        )
      },
      changed: active => {
        if (!active) {
          runtimeScope.agentRouteScopes()!.reconcileRoutes()
        }
      },
    })
  }
}

export const runRuntimeStage4077 = async (runtimeScope: RuntimeClosureScope): Promise<void> => {
  try {
    runtimeScope.i18nFiber = runtimeScope.ctx.plugin(CordisXI18nService)
    await runtimeScope.i18nFiber
    if (runtimeScope.playgroundRoomSimulationBridgeRegistry()! !== undefined) {
      runtimeScope.playgroundRoomSimulationBridgeFiber = runtimeScope.ctx.plugin(
        CordisXPlaygroundRoomSimulationBridgeService,
        runtimeScope.playgroundRoomSimulationBridgeRegistry()!,
      )
      await runtimeScope.playgroundRoomSimulationBridgeFiber
    }
    runtimeScope.i18nService = runtimeScope.ctx.i18n as CordisXI18nService
    for (const catalog of CORDISX_EXTENSION_POINT_LOCALE_CATALOGS) {
      runtimeScope.disposeExtensionPointCatalogs()!.push(runtimeScope.i18nService.define(catalog))
    }
    for (const catalog of CORDISX_CAPABILITY_AVAILABILITY_LOCALE_CATALOGS) {
      runtimeScope.disposeExtensionPointCatalogs()!.push(runtimeScope.i18nService.define(catalog))
    }
    for (const catalog of CORDISX_PERMISSION_LOCALE_CATALOGS) {
      runtimeScope.disposeExtensionPointCatalogs()!.push(runtimeScope.i18nService.define(catalog))
    }
    runtimeScope.disposeI18nSubscription = runtimeScope.i18nService.subscribeInternal(
      runtimeScope.notifyFrom()!('i18n'),
    )
    runtimeScope.disposePermissionSubscription = runtimeScope.broker()!.subscribe(() => {
      runtimeScope.slotService?.invalidatePointPolicies()
      void runtimeScope.routeService?.invalidatePointPolicies()
      runtimeScope.notify()!('permissions')
    })
    runtimeScope.disposeExtensionPointSubscription = runtimeScope.extensionPointBroker()!.subscribe(
      runtimeScope.notifyFrom()!('extension-policy'),
    )
    runtimeScope.settingsFiber = runtimeScope.ctx.plugin(CordisXPluginSettingsService, {
      registry: runtimeScope.configuration()!,
      console: runtimeScope.pluginConsole()!,
    })
    await runtimeScope.settingsFiber
    runtimeScope.configRendererFiber = runtimeScope.ctx.plugin(CordisXConfigRendererService, {
      registry: runtimeScope.configRenderers()!,
      console: runtimeScope.pluginConsole()!,
    })
    await runtimeScope.configRendererFiber
    runtimeScope.iconThemeFiber = runtimeScope.ctx.plugin(CordisXIconThemeService, runtimeScope.iconThemeRegistry()!)
    await runtimeScope.iconThemeFiber
    runtimeScope.visualFiber = runtimeScope.ctx.plugin(CordisXVisualService)
    await runtimeScope.visualFiber
    runtimeScope.channelManagerFiber =
      runtimeScope.metadata()!.channelManager === undefined && runtimeScope.serviceConfigBridge()! === undefined
        ? runtimeScope.ctx.plugin(CordisXChannelManagerService)
        : runtimeScope.ctx.plugin(
          CordisXChannelManagerService,
          {
            profileId: runtimeScope.metadata()!.profileId,
            hostGeneration: runtimeScope.metadata()!.generation ?? runtimeScope.metadata()!.version,
            ...(runtimeScope.metadata()!.channelManager === undefined
              ? {}
              : { projection: runtimeScope.metadata()!.channelManager }),
            ...(runtimeScope.serviceConfigBridge()! === undefined ? {} : {
              serviceConfig: {
                list: async () => await runtimeScope.serviceConfigBridge()!.list('channel'),
                mutate: async (mutation) => await runtimeScope.serviceConfigBridge()!.mutate(mutation),
              },
            }),
            ...(runtimeScope.channelCredentialBridge()! === undefined ? {} : {
              createCredentialedConnection: async (input) =>
                await runtimeScope.channelCredentialBridge()!.create(input),
            }),
            ...(runtimeScope.channelActionsBridge()! === undefined ? {} : {
              actions: { run: async (action, input) => await runtimeScope.channelActionsBridge()!.run(action, input) },
            }),
          } satisfies ChannelManagerServiceInput,
        )
    await runtimeScope.channelManagerFiber
    runtimeScope.registrySubscriptions()!.push(
      runtimeScope.configuration()!.subscribe(runtimeScope.notifyFrom()!('configuration')),
    )
    runtimeScope.platformFiber = runtimeScope.ctx.plugin(CordisXPlatformService, {
      adapter: runtimeScope.platformAdapter()!,
      broker: runtimeScope.broker()!,
      console: runtimeScope.pluginConsole()!,
    })
    await runtimeScope.platformFiber
    runtimeScope.systemPromptFiber = runtimeScope.ctx.plugin(CordisXSystemPromptService, {
      runtime: runtimeScope.agentRuntime()!,
      console: runtimeScope.pluginConsole()!,
    })
    await runtimeScope.systemPromptFiber
    runtimeScope.commandFiber = runtimeScope.ctx.plugin(CordisXCommandService, {
      console: runtimeScope.pluginConsole()!,
    })
    await runtimeScope.commandFiber
    runtimeScope.commandService = runtimeScope.ctx.commands as CordisXCommandService
    runtimeScope.agentConversationShellFiber = runtimeScope.ctx.plugin(CordisXAgentConversationShellService, {
      console: runtimeScope.pluginConsole()!,
      selectedNavigationActions: runtimeScope.selectedNavigationActions()!,
      identity: {
        resolve: value => runtimeScope.agentSessionRuntime.definitionPresentation(value)
          ?? runtimeScope.agentLoopBrokerV4()!.definitionPresentation(value),
        resolveSettings: value => {
          const request = resolveHostManagerAgentDefinitionOpenRequest(
            runtimeScope.routeService?.managerContentAgentDefinitionTarget(value),
            runtimeScope.managerModel()!.snapshot().settingsNavigationItems ?? [],
          )
          return request === undefined
            ? { available: false, reason: 'Manager entity detail is unavailable for this exact Agent revision.' }
            : { available: true }
        },
        navigator: runtimeScope.agentDetailNavigator()!,
        onSettings: value => {
          const request = resolveHostManagerAgentDefinitionOpenRequest(
            runtimeScope.routeService?.managerContentAgentDefinitionTarget(value),
            runtimeScope.managerModel()!.snapshot().settingsNavigationItems ?? [],
          )
          if (request === undefined) {
            throw new Error('Manager entity detail is unavailable for this exact Agent revision.')
          }
          runtimeScope.managerNavigationController()!.openManagerContent(request)
        },
      },
      ...(runtimeScope.scenarioSessionScopeAuthority! === undefined ? {} : {
        scenarioSource: runtimeScope.scenarioSessionScopeAuthority!.conversationSource,
        scenarioOwner: (owner: string, moduleGeneration: string | undefined) => {
          if (moduleGeneration === undefined) return undefined
          const matches = runtimeScope.controllers()!.filter(controller =>
            controller.item.id === owner
            && controller.principalLive
            && runtimeScope.moduleGenerationOf()!(controller) === moduleGeneration
          )
          return matches.length === 1 ? runtimeScope.agentOwnerForController()!(matches[0]!) : undefined
        },
      }),
    })
    await runtimeScope.agentConversationShellFiber
    runtimeScope.pageFiber = runtimeScope.ctx.plugin(CordisXPageService, runtimeScope.pluginConsole()!)
    await runtimeScope.pageFiber
    runtimeScope.pageService = runtimeScope.ctx.pages as CordisXPageService
    runtimeScope.routeFiber = runtimeScope.ctx.plugin(CordisXRouteService, {
      history: runtimeScope.routeHistory()!,
      console: runtimeScope.pluginConsole()!,
      pageAdmissionBindings: runtimeScope.pageAdmissionBindings()!,
    })
    await runtimeScope.routeFiber
    runtimeScope.routeService = runtimeScope.ctx.routes as CordisXRouteService
    runtimeScope.disposePageAdmissionActivation = runtimeScope.pageAdmissionBindings()!.subscribeActivation(binding => {
      runtimeScope.agentSessionRuntime.claimPageAdmissionBinding(binding)
    })
    runtimeScope.routeService.registry.setPageComposerAdapterFactory({
      create: input => {
        const commands = runtimeScope.commandService
        if (input.source === undefined || commands === undefined) {
          return undefined
        }
        const owner = runtimeScope.agentSessionRuntime.ownerForPlugin(input.source, input.owner, input.moduleGeneration)
        return createPageComposerAdapter({
          ownerId: input.owner,
          owner,
          binding: input.binding,
          route: input.route,
          generation: input.moduleGeneration,
          signal: input.signal,
          runtime: runtimeScope.agentSessionRuntime,
          commands,
        })
      },
    })
    runtimeScope.managerContentConfigAuthority = new ManagerContentConfigAuthority({
      configuration: runtimeScope.configuration()!,
      profileId: runtimeScope.metadata()!.profileId,
      runtimeGeneration: runtimeScope.generation()!,
      locale: () => runtimeScope.i18nService?.getSnapshot().locale ?? 'en',
      resolveText: (owner, message, site) =>
        runtimeScope.i18nService?.resolveFor(owner, message, site).text
          ?? message.fallback
          ?? message.key,
      update: runtimeScope.updatePluginConfig()!,
    })
    runtimeScope.routeService.setManagerContentConfigFactory(input =>
      runtimeScope.managerContentConfigAuthority!.bind(input)
    )
    runtimeScope.reconcileAgentRuntimeRoute()!()
    runtimeScope.managerContentFiber = runtimeScope.ctx.plugin(CordisXManagerContentNavigationService)
    await runtimeScope.managerContentFiber
    runtimeScope.unregisterManagerPointCatalog = runtimeScope.extensionPointDescriptors()!.registerCatalog(
      CORDISX_MANAGER_EXTENSION_POINT_CATALOG,
    )
    const managerOutletController = {
      getSnapshot: () => ({ available: false, contextKey: runtimeScope.generation()!, placement: 'absolute' as const }),
      subscribe: (_listener: () => void) => () => {},
      show: () => {},
      hide: () => {},
    }
    runtimeScope.undeclareManagerOutlet = runtimeScope.routeService.outlets.declare(
      {
        schemaVersion: 1,
        id: 'manager.settings.content',
        authority: 'host-adapter',
        scope: 'manager-settings',
        preferredPlacement: 'absolute',
        contextPolicy: 'generation',
        presentationGroup: 'manager.settings',
      },
      managerOutletController,
      path => path.startsWith('/manager/settings/') && path.length > '/manager/settings/'.length,
    )
    const managerContentOutletController = {
      getSnapshot: () => ({ available: false, contextKey: runtimeScope.generation()!, placement: 'absolute' as const }),
      subscribe: (_listener: () => void) => () => {},
      show: () => {},
      hide: () => {},
    }
    runtimeScope.undeclareManagerContentOutlet = runtimeScope.routeService.outlets.declare(
      {
        schemaVersion: 1,
        id: 'manager.content',
        authority: 'host-adapter',
        scope: 'manager',
        preferredPlacement: 'absolute',
        contextPolicy: 'generation',
        presentationGroup: 'manager',
      },
      managerContentOutletController,
      path => (path.startsWith('/manager/extensions/') && path.length > '/manager/extensions/'.length),
    )
    runtimeScope.slotFiber = runtimeScope.ctx.plugin(CordisXSlotService, { console: runtimeScope.pluginConsole()! })
    await runtimeScope.slotFiber
    runtimeScope.slotService = runtimeScope.ctx.slots as CordisXSlotService
    runtimeScope.slotService.setResolvers({
      command: (owner, reference, view) => runtimeScope.commandService?.hasFor(owner, reference, view) ?? false,
      route: (owner, id, view) => runtimeScope.routeService?.hasFor(owner, id, view) ?? false,
      managerSettingsRoute: (owner, id, view) =>
        runtimeScope.routeService?.managerSettingsRouteFor(owner, id, view)
          ?? { state: 'pending', detail: 'CordisX routes are not ready' },
      managerSettingsNavigationRoute: (owner, id, view) =>
        runtimeScope.routeService?.managerSettingsNavigationRouteFor(owner, id, view)
          ?? { state: 'pending', detail: 'CordisX routes are not ready' },
    })
    runtimeScope.commandService.setAccessResolver(runtimeScope.extensionPointBroker()!)
    runtimeScope.routeService.setAccessResolver(runtimeScope.extensionPointBroker()!)
    runtimeScope.slotService.setAccessResolver(runtimeScope.extensionPointBroker()!)
    runtimeScope.transientCanvasCoordinator = new TransientCanvasCoordinator(
      document,
      runtimeScope.slotService.registry,
    )
    runtimeScope.registrySubscriptions()!.push(
      runtimeScope.extensionPointDescriptors()!.subscribe(runtimeScope.notifyFrom()!('extension-descriptors')),
      runtimeScope.commandService.subscribeInternal(runtimeScope.notifyFrom()!('commands')),
      runtimeScope.pageService.registry.subscribe(runtimeScope.notifyFrom()!('pages')),
      runtimeScope.routeService.subscribeInternal(runtimeScope.notifyFrom()!('routes')),
      runtimeScope.slotService.subscribeInternal(runtimeScope.notifyFrom()!('surfaces')),
      runtimeScope.iconThemeRegistry()!.subscribe(runtimeScope.notifyFrom()!('icon-themes')),
    )
    runtimeScope.adapterHandle = runtimeScope.metadata()!.hostKind === 'playground'
      ? installPlaygroundAdapter(
        document,
        runtimeScope.slotService,
        runtimeScope.commandService,
        runtimeScope.routeService,
        runtimeScope.i18nService,
        runtimeScope.extensionPointDescriptors()!,
        {
          profileId: runtimeScope.metadata()!.profileId,
          transientCanvas: runtimeScope.transientCanvasCoordinator,
          selectedNavigationActions: runtimeScope.selectedNavigationActions()!,
        },
      )
      : installCodexAdapter(
        document,
        runtimeScope.slotService,
        runtimeScope.commandService,
        runtimeScope.routeService,
        runtimeScope.i18nService,
        runtimeScope.extensionPointDescriptors()!,
        {
          generation: runtimeScope.generation()!,
          adapterVersion: runtimeScope.metadata()!.version,
          profileId: runtimeScope.metadata()!.profileId,
          transientCanvas: runtimeScope.transientCanvasCoordinator,
          selectedNavigationActions: runtimeScope.selectedNavigationActions()!,
        },
      )
    const legacyAuthorizationGroups = new Map<string, {
      readonly source: string
      readonly pluginId: string
      readonly pointId: string
      readonly policies: Set<'allow' | 'deny'>
    }>()
    for (
      const record of [
        ...runtimeScope.legacyExtensionPointPolicies()!.map(item => ({ identity: item.identity, policy: item.policy })),
        ...runtimeScope.slotService.controlLegacyAuthorizations().map(item => ({
          identity: item.identity,
          policy: item.policy,
        })),
      ]
    ) {
      if (
        record.policy === 'inherit'
        || runtimeScope.extensionPointDescriptors()!.descriptor(record.identity.pointId) === undefined
      ) {
        continue
      }
      const key = `${record.identity.source}\u0000${record.identity.pluginId}\u0000${record.identity.pointId}`
      const group = legacyAuthorizationGroups.get(key) ?? {
        source: record.identity.source,
        pluginId: record.identity.pluginId,
        pointId: record.identity.pointId,
        policies: new Set<'allow' | 'deny'>(),
      }
      group.policies.add(record.policy)
      legacyAuthorizationGroups.set(key, group)
    }
    for (const group of legacyAuthorizationGroups.values()) {
      const controller = runtimeScope.activeController()!(group.pluginId, group.source)
      if (
        controller === undefined || group.policies.size !== 1
        || runtimeScope.broker()!.hasDomPolicy(controller.identity, group.pointId)
      ) {
        continue
      }
      await runtimeScope.broker()!.setDomPolicy(
        controller.identity,
        group.pointId,
        group.policies.has('allow') ? 'allow-persistent' : 'deny-persistent',
      )
    }
    for (const controller of runtimeScope.controllers()!) {
      if (controller.status !== 'active') {
        continue
      }
      await runtimeScope.mountPlugin()!(controller)
    }
    await runtimeScope.routeService.registry.startHistoryProjection()
    if (runtimeScope.metadata()!.iconThemePreference! !== undefined) {
      // Restore only after every provider has had a chance to register. An
      // unknown, stale, disposed, or version-mismatched identity leaves the
      // pinned Reicon default active without exposing private registration data.
      runtimeScope.iconThemeRegistry()!.selectProvider(
        `iconrestore_${String(Date.now()).padStart(16, '0')}`,
        runtimeScope.iconThemeRegistry()!.selection().profileRevision,
        runtimeScope.generation()!,
        runtimeScope.metadata()!.iconThemePreference!,
      )
    }
    if (runtimeScope.iconThemePreferenceBridge()! !== undefined) {
      runtimeScope.disposeIconThemePreferenceSubscription = runtimeScope.iconThemePreferenceBridge()!.subscribe(
        preference => {
          if (runtimeScope.disposed) {
            return
          }
          reconcileIconThemePreference(runtimeScope.iconThemeRegistry()!, runtimeScope.generation()!, preference)
        },
      )
      const currentPreference = runtimeScope.iconThemePreferenceBridge()!.current()
      if (currentPreference !== undefined) {
        reconcileIconThemePreference(runtimeScope.iconThemeRegistry()!, runtimeScope.generation()!, currentPreference)
      }
      await runtimeScope.iconThemePreferenceBridge()!.ready()
    }
    runtimeScope.disposeManager = installReactCordisXManager(document, runtimeScope.managerModel()!, {
      navigationController: runtimeScope.managerNavigationController()!,
      ...(runtimeScope.metadata()!.hostKind === 'playground'
        ? {
          triggerTarget: () =>
            document.querySelector<HTMLElement>('[data-cordisx-playground-manager-trigger]') ?? undefined,
        }
        : {}),
    })
  } catch (error) {
    await runtimeScope.dispose()!()
    throw error
  }
}
