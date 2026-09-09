import { dialogCenterForDocument } from './dialogs/host.js'
import { notificationCenterForDocument } from './notifications/host.js'
import { nativeAgentTaskClient } from './native-agent-session-recovery.js'
import { createRestrictedContentService } from './restricted-content-service.js'
import { createPluginHttpClient } from './plugin-http.js'
import { installAgentTasks } from './agent-tasks-install.js'
import { registerNativeSessionOwner } from './native-agent-session-recovery.js'
import { installAgentTools } from './plugin-agent-tools.js'
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
  CordisXPluginManifestV12,
  CordisXPluginManifestV13,
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
  errorMessage,
  manifestUsesHostDom,
  manifestUsesTransientCanvas,
  PluginController,
  pluginFromModule,
} from './runtime-shared.js'

export const createRuntimeDisposeControllerFiber = async (
  runtimeScope: RuntimeClosureScope,
  controller: PluginController,
  reason: 'owner-disposed' | 'generation-replaced',
): Promise<void> => {
  runtimeScope.rememberRegistrations()!(controller.item.id)
  runtimeScope.agentRuntime()!.releaseOwner(controller.identity, reason, runtimeScope.moduleGenerationOf()!(controller))
  let failure: unknown
  try {
    await controller.hostDomWorker?.dispose()
    await controller.fiber?.dispose()
  } catch (error) {
    failure = error
  }
  try {
    await runtimeScope.routeService?.settled()
  } catch (error) {
    failure ??= error
  } finally {
    const owner = `${controller.item.source}:${controller.item.id}`
    runtimeScope.agentRouteScopes()!.revoke(owner, 'plugin-generation-replaced')
    runtimeScope.agentSessionRuntime.fenceOwner(owner, 'plugin-generation-replaced')
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
    controller.agentLoopClient?.dispose()
    delete controller.agentLoopClient
    controller.httpClient?.dispose()
    delete controller.httpClient
    await controller.unregisterHttp?.()
    delete controller.unregisterHttp
    controller.unregisterDialogs?.()
    delete controller.unregisterDialogs
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
    controller.documentsClient?.dispose()
    delete controller.documentsClient
    controller.unregisterAgentTools?.()
    delete controller.unregisterAgentTools
    await controller.unregisterDocuments?.()
    delete controller.unregisterDocuments
    controller.connectorClient?.dispose()
    delete controller.connectorClient
    await controller.unregisterConnector?.()
    delete controller.unregisterConnector
    runtimeScope.retirePrincipal()!(controller, `Plugin disposed: ${reason}`)
    delete controller.hostDomWorker
    delete controller.fiber
  }
  if (failure !== undefined) {
    throw failure
  }
}

export const createRuntimeRenewPrincipal = (runtimeScope: RuntimeClosureScope, controller: PluginController): void => {
  if (controller.principalLive) {
    return
  }
  controller.activation += 1
  controller.principal = runtimeScope.pluginConsole()!.issue(
    controller.identity,
    runtimeScope.moduleGenerationOf()!(controller),
  )
  controller.principalLive = true
  const module = controller.item.isolatedArtifactSource === undefined
    ? controller.item.moduleFactory?.(runtimeScope.pluginConsole()!.consoleFacade(controller.principal))
      ?? controller.item.module
    : undefined
  controller.item = module === undefined || module === controller.item.module
    ? controller.item
    : { ...controller.item, module }
  controller.manifest = normalizePluginManifest(controller.item.manifest ?? module?.manifest, controller.item.id)
}

export const createRuntimeRetirePrincipal = (
  runtimeScope: RuntimeClosureScope,
  controller: PluginController,
  message: string,
): void => {
  if (!controller.principalLive) {
    return
  }
  runtimeScope.pluginConsole()!.deactivate(controller.principal, message)
  controller.principalLive = false
}

export const createRuntimeMountPlugin = async (
  runtimeScope: RuntimeClosureScope,
  controller: PluginController,
): Promise<void> => {
  runtimeScope.renewPrincipal()!(controller)
  const module = controller.item.module
  const isolatedArtifactSource = controller.item.isolatedArtifactSource
  if (module === undefined && isolatedArtifactSource === undefined) {
    throw new Error(`plugin ${controller.item.id} is not bundled because it is disabled in configuration`)
  }
  const blockedReason = runtimeScope.requiredBlockReason()!(controller)
  if (blockedReason !== undefined) {
    controller.status = 'permission-blocked'
    controller.blockedReason = blockedReason
    return
  }
  if (isolatedArtifactSource !== undefined) {
    if (runtimeScope.hostDomWorkerEnvironment === undefined) {
      throw new Error('native browser primitives are unavailable for Host DOM worker isolation')
    }
    const hostDom = !manifestUsesHostDom(controller.manifest) ? undefined : runtimeScope.hostDomAuthority()!.bind({
      ownerKey: JSON.stringify([
        runtimeScope.metadata()!.profileId,
        controller.identity.source,
        controller.identity.id,
        runtimeScope.generation()!,
        runtimeScope.moduleGenerationOf()!(controller),
      ]),
      profileId: runtimeScope.metadata()!.profileId,
      identity: { source: controller.identity.source, pluginId: controller.identity.id },
      runtimeGeneration: runtimeScope.generation()!,
      moduleGeneration: runtimeScope.moduleGenerationOf()!(controller),
      state: () =>
        !runtimeScope.controllers()!.includes(controller)
          ? 'uninstalled'
          : !controller.principalLive
          ? 'generation-replaced'
          : !controller.item.enabled
          ? 'disabled'
          : 'active',
      authorize: async (capability, rootId, operations) =>
        await runtimeScope.broker()!.authorizeHostDom(
          controller.identity,
          capability,
          rootId,
          operations,
          controller.generationView,
        ),
      leaseActive: leaseId =>
        runtimeScope.broker()!.isHostDomLeaseActive(controller.identity, leaseId, controller.generationView),
      subscribeInvalidation: listener => runtimeScope.broker()!.subscribe(listener),
    })
    let boundary: HostDomWorkerBoundary | undefined
    const transientCanvas =
      !manifestUsesTransientCanvas(controller.manifest) || runtimeScope.transientCanvasCoordinator === undefined
        ? undefined
        : runtimeScope.transientCanvasCoordinator.bind({
          owner: controller.item.id,
          source: controller.identity.source,
          moduleGeneration: runtimeScope.moduleGenerationOf()!(controller),
          generation: Object.freeze({
            pluginId: controller.item.id,
            moduleGeneration: runtimeScope.moduleGenerationOf()!(controller),
            ...(controller.generationView?.transactionId === undefined ? {} : {
              transactionId: controller.generationView.transactionId,
              transactionEpoch: controller.generationView.transactionEpoch,
            }),
          }),
          ...(controller.generationView === undefined ? {} : { candidateView: controller.generationView }),
          sink: {
            start: input => boundary?.startTransientCanvas(input),
            stop: sessionId => boundary?.stopTransientCanvas(sessionId),
          },
        })
    try {
      runtimeScope.pluginConsole()!.lifecycle(
        controller.principal,
        controller.activation === 1 ? 'activate' : 'reload',
        'Isolated plugin activation started',
      )
      boundary = createHostDomWorkerBoundary({
        document,
        artifactSource: isolatedArtifactSource,
        config: runtimeScope.configuration()!.get(controller.item.id, controller.generationView),
        ...(hostDom === undefined ? {} : { hostDom }),
        ...(transientCanvas === undefined ? {} : { transientCanvas }),
        environment: runtimeScope.hostDomWorkerEnvironment,
        onStatus: status => {
          if (status.status !== 'error' || controller.hostDomWorker !== boundary) {
            return
          }
          controller.status = 'failed'
          controller.error = status.error
          runtimeScope.notify()!('isolated-worker')
        },
      })
      controller.hostDomWorker = boundary
      await boundary.ready
      controller.status = 'active'
      delete controller.error
      delete controller.blockedReason
      runtimeScope.pluginConsole()!.lifecycle(
        controller.principal,
        controller.activation === 1 ? 'activate' : 'reload',
        'Isolated plugin activation completed',
      )
      return
    } catch (error) {
      await boundary?.dispose().catch(() => undefined)
      hostDom?.dispose()
      transientCanvas?.dispose()
      delete controller.hostDomWorker
      controller.status = 'failed'
      controller.error = errorMessage(error)
      runtimeScope.pluginConsole()!.diagnostic(
        controller.principal,
        'plugin.activation',
        'Isolated plugin activation failed',
        error,
      )
      runtimeScope.retirePrincipal()!(controller, 'Plugin disposed after isolated activation failure')
      throw error
    }
  }
  if (module === undefined) {
    throw new Error(`plugin ${controller.item.id} has no renderer module`)
  }
  let pluginContext: Context
  const connectorAuthorization = async (
    capability: CordisXConnectorClientCapability,
    _registration?: CordisXConnectorRegistrationIdentity,
  ): Promise<CordisXConnectorAuthorization> => {
    if (!controller.principalLive) {
      return { capability, state: 'unavailable', code: 'principal-unavailable' }
    }
    try {
      const identity = runtimeScope.pluginConsole()!.owner(controller.principal)
      const permissionCapability: CordisXPlatformCapability = capability === 'connector.command.execute'
        ? 'agent.messages.append'
        : 'agent.events.read'
      // Connector calls never open an implicit permission prompt. A plugin
      // must have an explicit allow policy before this bound surface can use
      // the PermissionBroker; ask and deny both fail closed.
      if (
        runtimeScope.broker()!.policy(
          identity,
          permissionCapability,
          runtimeScope.generationVisibility()!.view(pluginContext),
        ) !== 'allow'
      ) {
        return { capability, state: 'denied', code: 'policy-denied' }
      }
      // Conversation handles are opaque and cannot be safely translated into
      // a native Agent session scope. This conservative all-session request
      // therefore never expands a manifest's declared session authority.
      const authorization = await runtimeScope.broker()!.authorize(identity, permissionCapability, {
        allAgentSessions: true,
      }, runtimeScope.generationVisibility()!.view(pluginContext))
      if (!authorization.ok) {
        return { capability, state: 'denied', code: 'policy-denied' }
      }
      return { capability, state: 'allowed', code: 'allowed' }
    } catch {
      return { capability, state: 'unavailable', code: 'principal-unavailable' }
    }
  }
  const connectorClient = runtimeScope.connectorBroker()!.bind({
    active: () => {
      if (!controller.principalLive) {
        return false
      }
      try {
        const identity = runtimeScope.pluginConsole()!.owner(controller.principal)
        return identity.id === controller.identity.id && identity.source === controller.identity.source
      } catch {
        return false
      }
    },
    authorize: connectorAuthorization,
  })
  const agentLoopAuthorizationV4 = async (
    request: Omit<CordisXAgentLoopAuthorizationRequestV4, 'capability'> & {
      readonly capability: CordisXAgentLoopAuthorizationRequestV4['capability'] | 'turns.control'
    },
  ) => {
    if (!controller.principalLive) {
      return { capability: request.capability, state: 'unavailable' as const, code: 'host-unavailable' as const }
    }
    try {
      const identity = runtimeScope.pluginConsole()!.owner(controller.principal)
      const authorization = await runtimeScope.broker()!.authorize(identity, request.capability, {
        ...(request.model === undefined ? {} : { providerId: request.model.providerId, model: request.model }),
        ...(request.session === undefined
          ? {}
          : { providerId: request.session.providerId, session: request.session }),
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      }, runtimeScope.generationVisibility()!.view(pluginContext))
      if (authorization.ok) {
        return { capability: request.capability, state: 'allowed' as const, code: 'allowed' as const }
      }
      if (authorization.error.code === 'permission-denied') {
        return { capability: request.capability, state: 'denied' as const, code: 'user-denied' as const }
      }
      if (
        authorization.error.code === 'permission-undeclared'
        || authorization.error.code === 'permission-scope-denied' || authorization.error.code === 'timeout'
      ) {
        return { capability: request.capability, state: 'denied' as const, code: 'policy-denied' as const }
      }
      return { capability: request.capability, state: 'unavailable' as const, code: 'host-unavailable' as const }
    } catch {
      return { capability: request.capability, state: 'unavailable' as const, code: 'host-unavailable' as const }
    }
  }
  const agentLoopOptions: CordisXBoundAgentLoopClientOptions = {
    // v2 operation identities survive client generations for this exact
    // source-owned plugin principal. Provider affinity is broker-fenced.
    ownerKey: JSON.stringify([controller.identity.source, controller.identity.id]),
    active: () => {
      if (!controller.principalLive) {
        return false
      }
      try {
        const identity = runtimeScope.pluginConsole()!.owner(controller.principal)
        return identity.id === controller.identity.id && identity.source === controller.identity.source
      } catch {
        return false
      }
    },
    authorize: request =>
      agentLoopAuthorizationV4(request) as ReturnType<CordisXBoundAgentLoopClientOptions['authorize']>,
    authorizeV4: request =>
      agentLoopAuthorizationV4(request) as ReturnType<NonNullable<CordisXBoundAgentLoopClientOptions['authorizeV4']>>,
    registerPrompt: (sessionId, definition) =>
      (definition.promptSections ?? []).map((section, order) =>
        runtimeScope.agentRuntime()!.registerPrompt(controller.identity, 'section', {
          sessionId,
          id: `agent-definition:${definition.identity.agentId}:${definition.identity.revision}:${section.sectionId}`,
          content: section.text,
          order,
        }, runtimeScope.moduleGenerationOf()!(controller))
      ),
  }
  const agentLoopClientV4 = runtimeScope.agentLoopBrokerV4()!.bind(agentLoopOptions)
  const agentLoopClient = combineAgentLoopClients(
    runtimeScope.agentLoopBroker()!.bind(agentLoopOptions),
    runtimeScope.agentLoopBrokerV2()!.bind(agentLoopOptions),
    adaptAgentLoopV3(agentLoopClientV4),
    agentLoopClientV4,
  )
  controller.unregisterAgentSessionMigration = runtimeScope.agentSessionRuntime.installLegacyBindingResolver(
    `${controller.item.source}:${controller.item.id}`,
    async (binding) => await runtimeScope.agentLoopBrokerV4()!.resolveLegacySession(agentLoopOptions, binding),
  )
  const documentsClient = runtimeScope.ownerDocumentBroker()!.bind({
    identity: controller.identity,
    moduleGeneration: runtimeScope.moduleGenerationOf()!(controller),
    active: () => {
      if (!controller.principalLive) {
        return false
      }
      try {
        const identity = runtimeScope.pluginConsole()!.owner(controller.principal)
        return identity.id === controller.identity.id && identity.source === controller.identity.source
      } catch {
        return false
      }
    },
  })
  pluginContext = runtimeScope.ctx.isolate('connectors').isolate('agentLoop').isolate('agents').isolate('sessions')
    .isolate('agentSessionDetailReferences').isolate('agentDetailNavigation').isolate('approvals')
    .isolate('agentAdmission').isolate('agentAdmissionOrigins').isolate('agentAdmissionReservations')
    .isolate('agentAdmissionBootstrapTargets').isolate('agentAdmissionBootstrapReservations')
    .isolate('agentAdmissionBootstrapRoomTargets').isolate('agentAdmissionBootstrapRoomReservations')
    .isolate('agentAdmissionBootstrapRouteDeclarations').isolate('agentAdmissionBootstrapRouteReservations')
    .isolate('agentPageAdmissionTargets').isolate('agentPageAdmissionReservations')
    .isolate('agentPageAdmissionRouteDeclarations').isolate('agentPageAdmissionRouteReservations')
    .isolate('agentPageFreshRoomNavigation')
    .isolate('entityExecutionContexts').isolate('agentTaskApprovals').isolate('agentTaskOwnership').isolate(
      'agentTasks',
    ).isolate('agentTools').isolate(
      'entities',
    ).isolate('documents').isolate('http').isolate('agentLoopControl').isolate('restrictedContent').isolate(
      'notifications',
    ).isolate('dialogs').extend({
      [CORDISX_PLUGIN_ID]: controller.item.id,
      [CORDISX_PLUGIN_SOURCE]: controller.item.source,
      [CORDISX_PLUGIN_GENERATION]: runtimeScope.moduleGenerationOf()!(controller),
      [CORDISX_PLUGIN_PRINCIPAL]: controller.principal,
      ...(controller.generationContext ?? {}),
    })
  controller.connectorClient = connectorClient
  controller.unregisterConnector = pluginContext.reflect.provide('connectors', connectorClient)
  controller.agentLoopClient = agentLoopClient
  controller.unregisterAgentLoop = pluginContext.reflect.provide('agentLoop', agentLoopClient)
  controller.agentLoopControl = runtimeScope.agentLoopBrokerV4()!.bindControl(
    agentLoopOptions,
    async (capability, binding) =>
      (await agentLoopAuthorizationV4({ capability, ...(binding === undefined ? {} : { task: binding.task }) })).state
        === 'allowed',
  )
  controller.unregisterAgentLoopControl = pluginContext.reflect.provide('agentLoopControl', controller.agentLoopControl)
  const notificationBinding = notificationCenterForDocument(document)?.bind({
    key: agentLoopOptions.ownerKey,
    pluginId: controller.item.id,
    active: () => agentLoopOptions.active() && runtimeScope.activeControllers()().includes(controller),
    presentation: () => {
      const plugin = runtimeScope.publicSnapshot()().plugins.find(item =>
        item.id === controller.item.id && item.source === controller.identity.source
      )
      return {
        name: plugin?.name ?? controller.manifest.name ?? controller.item.id,
        ...(plugin?.icon ? { icon: plugin.icon } : {}),
      }
    },
    canOpen: () =>
      runtimeScope.routeService?.snapshot().routes.some(item =>
        item.owner === controller.item.id && item.valid && item.authorized && !item.definition.path.includes(':')
      ) ?? false,
    open: async () => {
      const route = runtimeScope.routeService?.snapshot().routes.find(item =>
        item.owner === controller.item.id && item.valid && item.authorized && !item.definition.path.includes(':')
      )
      if (!route || !runtimeScope.routeService) throw new Error('Plugin page unavailable')
      await runtimeScope.routeService.navigateFor(controller.item.id, { id: route.id })
    },
  })
  if (notificationBinding) {
    const release = pluginContext.reflect.provide('notifications', notificationBinding.api)
    controller.unregisterNotifications = () => {
      release()
      notificationBinding.dispose()
    }
  }
  const dialogBinding = dialogCenterForDocument(document)?.bind({
    key: agentLoopOptions.ownerKey,
    name: () => controller.manifest.name ?? controller.item.id,
    active: () => agentLoopOptions.active() && runtimeScope.activeControllers()().includes(controller),
    report: () => {
      notificationBinding?.api.show({
        kind: 'dialog.operation-failed',
        type: 'error',
        message: document.documentElement.lang.startsWith('zh')
          ? '操作未完成，请重试。'
          : 'Operation failed. Please retry.',
      })
    },
  })
  if (dialogBinding) {
    const release = pluginContext.reflect.provide('dialogs', dialogBinding.api)
    controller.unregisterDialogs = () => {
      release()
      dialogBinding.dispose()
    }
  }
  controller.restrictedContent = createRestrictedContentService(agentLoopOptions.active)
  controller.unregisterRestrictedContent = pluginContext.reflect.provide(
    'restrictedContent',
    controller.restrictedContent,
  )
  controller.documentsClient = documentsClient
  controller.unregisterDocuments = pluginContext.reflect.provide('documents', documentsClient)
  try {
    const owner = runtimeScope.agentSessionRuntime.ownerFromContext(pluginContext)
    const entityPrincipal = runtimeScope.entityPrincipalBindings()!.get(JSON.stringify([
      controller.identity.source,
      controller.identity.id,
      runtimeScope.moduleGenerationOf()!(controller),
    ]))
    const unregisterNativeSessionOwner = registerNativeSessionOwner(
      owner,
      entityPrincipal,
      () => controller.principalLive,
    )
    const http = createPluginHttpClient({
      development: () =>
        runtimeScope.broker()!.isLocalDevelopment(
          controller.identity,
          runtimeScope.moduleGenerationOf()!(controller),
          controller.generationView,
        ),
      bridge: runtimeScope.ownerDocumentBridge(),
      principal: entityPrincipal,
      active: () => controller.principalLive,
      configuredOrigins: () =>
        runtimeScope.configuration()!.configuredHttpOrigins(controller.item.id, controller.generationView),
    })
    controller.httpClient = http
    controller.unregisterHttp = pluginContext.reflect.provide('http', http)
    const tools = installAgentTools(pluginContext, {
      bridge: runtimeScope.ownerDocumentBridge()!,
      principal: entityPrincipal,
      active: () => controller.principalLive,
      ownsSession: sessionId => {
        const current = runtimeScope.agentSessionRuntime.ownerForSession(sessionId)
        return current?.pluginId === owner.pluginId && current.generation === owner.generation
      },
    })
    controller.unregisterAgentTools = () => {
      tools.dispose()
      unregisterNativeSessionOwner()
    }
    controller.entityRegistryFiber = pluginContext.plugin(CordisXEntityRegistryServiceV1, {
      ...(runtimeScope.desktopAgentSessionTransport()?.executionProjects === undefined
        ? {}
        : { projects: runtimeScope.desktopAgentSessionTransport()!.executionProjects! }),
      resolveProject: (context, project) => nativeAgentTaskClient(owner).resolveProjectContext(context, project),
      bridge: runtimeScope.ownerDocumentBridge()!,
      principal: entityPrincipal,
      profileId: runtimeScope.metadata()!.profileId,
      pluginGeneration: entityPrincipal?.pluginGeneration ?? owner.generation,
      active: () => controller.principalLive,
    })
    await controller.entityRegistryFiber
    const entityRegistry = (pluginContext as unknown as {
      readonly entities: EntityRegistry
    }).entities
    controller.agentRegistryFiber = pluginContext.plugin(CordisXAgentRegistryServiceV1, {
      runtime: runtimeScope.agentSessionRuntime,
      entities: entityRegistry,
    })
    await controller.agentRegistryFiber
    installAgentTasks(pluginContext, {
      ...(runtimeScope.desktopAgentSessionTransport()?.executionProjects === undefined
        ? {}
        : { projects: runtimeScope.desktopAgentSessionTransport()!.executionProjects! }),
      runtime: runtimeScope.agentSessionRuntime,
      entities: entityRegistry,
      tools,
      active: () => controller.principalLive,
    })
    controller.sessionRegistryFiber = pluginContext.plugin(
      CordisXSessionRegistryServiceV1,
      runtimeScope.agentSessionRuntime,
    )
    await controller.sessionRegistryFiber
    controller.agentSessionDetailReferenceFiber = pluginContext.plugin(
      CordisXAgentSessionDetailReferenceService,
      runtimeScope.agentSessionRuntime,
    )
    await controller.agentSessionDetailReferenceFiber
    controller.agentDetailNavigationFiber = pluginContext.plugin(
      CordisXAgentDetailNavigationService,
      runtimeScope.agentSessionRuntime,
    )
    await controller.agentDetailNavigationFiber
    controller.approvalServiceFiber = pluginContext.plugin(CordisXApprovalServiceV1, runtimeScope.agentSessionRuntime)
    await controller.approvalServiceFiber
    controller.agentAdmissionReservationFiber = pluginContext.plugin(
      CordisXAgentAdmissionReservationService,
      runtimeScope.agentSessionRuntime,
    )
    await controller.agentAdmissionReservationFiber
    controller.agentAdmissionTargetOriginFiber = pluginContext.plugin(
      CordisXAgentAdmissionTargetOriginService,
      runtimeScope.agentSessionRuntime,
    )
    await controller.agentAdmissionTargetOriginFiber
    controller.agentAdmissionTargetReservationFiber = pluginContext.plugin(
      CordisXAgentAdmissionTargetReservationService,
      runtimeScope.agentSessionRuntime,
    )
    await controller.agentAdmissionTargetReservationFiber
    controller.agentAdmissionBootstrapTargetFiber = pluginContext.plugin(
      CordisXAgentAdmissionBootstrapTargetService,
      runtimeScope.agentSessionRuntime,
    )
    await controller.agentAdmissionBootstrapTargetFiber
    controller.agentAdmissionBootstrapReservationFiber = pluginContext.plugin(
      CordisXAgentAdmissionBootstrapReservationService,
      runtimeScope.agentSessionRuntime,
    )
    await controller.agentAdmissionBootstrapReservationFiber
    controller.agentAdmissionBootstrapRoomTargetFiber = pluginContext.plugin(
      CordisXAgentAdmissionBootstrapRoomTargetService,
      runtimeScope.agentSessionRuntime,
    )
    await controller.agentAdmissionBootstrapRoomTargetFiber
    controller.agentAdmissionBootstrapRoomReservationFiber = pluginContext.plugin(
      CordisXAgentAdmissionBootstrapRoomReservationService,
      runtimeScope.agentSessionRuntime,
    )
    await controller.agentAdmissionBootstrapRoomReservationFiber
    controller.agentAdmissionBootstrapRouteDeclarationFiber = pluginContext.plugin(
      CordisXAgentAdmissionBootstrapRouteDeclarationService,
      runtimeScope.agentSessionRuntime,
    )
    await controller.agentAdmissionBootstrapRouteDeclarationFiber
    controller.agentAdmissionBootstrapRouteReservationFiber = pluginContext.plugin(
      CordisXAgentAdmissionBootstrapRouteReservationService,
      runtimeScope.agentSessionRuntime,
    )
    await controller.agentAdmissionBootstrapRouteReservationFiber
    controller.agentPageAdmissionTargetFiber = pluginContext.plugin(
      CordisXAgentPageAdmissionTargetService,
      runtimeScope.agentSessionRuntime,
    )
    await controller.agentPageAdmissionTargetFiber
    controller.agentPageAdmissionReservationFiber = pluginContext.plugin(
      CordisXAgentPageAdmissionReservationService,
      runtimeScope.agentSessionRuntime,
    )
    await controller.agentPageAdmissionReservationFiber
    controller.agentPageAdmissionRouteDeclarationFiber = pluginContext.plugin(
      CordisXAgentPageAdmissionRouteDeclarationService,
      runtimeScope.agentSessionRuntime,
    )
    await controller.agentPageAdmissionRouteDeclarationFiber
    controller.agentPageAdmissionRouteReservationFiber = pluginContext.plugin(
      CordisXAgentPageAdmissionRouteReservationService,
      runtimeScope.agentSessionRuntime,
    )
    await controller.agentPageAdmissionRouteReservationFiber
    controller.agentPageFreshRoomNavigationFiber = pluginContext.plugin(
      CordisXAgentPageFreshRoomNavigationService,
      runtimeScope.agentSessionRuntime,
    )
    await controller.agentPageFreshRoomNavigationFiber
    runtimeScope.pluginConsole()!.lifecycle(
      controller.principal,
      controller.activation === 1 ? 'activate' : 'reload',
      'Plugin activation started',
    )
    controller.fiber = pluginContext.plugin(
      pluginFromModule(module),
      runtimeScope.configuration()!.get(controller.item.id, runtimeScope.generationVisibility()!.view(pluginContext)),
    )
    await controller.fiber
    runtimeScope.agentRouteScopes()!.validateInstalledRoutes(owner)
    controller.status = 'active'
    runtimeScope.pluginConsole()!.lifecycle(
      controller.principal,
      controller.activation === 1 ? 'activate' : 'reload',
      'Plugin activation completed',
    )
    delete controller.error
    delete controller.blockedReason
    runtimeScope.rememberRegistrations()!(controller.item.id)
  } catch (error) {
    controller.status = 'failed'
    controller.error = errorMessage(error)
    runtimeScope.pluginConsole()!.diagnostic(
      controller.principal,
      'plugin.activation',
      'Plugin activation failed',
      error,
    )
    await controller.fiber?.dispose()
    delete controller.fiber
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
    agentLoopClient.dispose()
    delete controller.agentLoopClient
    controller.httpClient?.dispose()
    delete controller.httpClient
    await controller.unregisterHttp?.()
    delete controller.unregisterHttp
    controller.unregisterDialogs?.()
    delete controller.unregisterDialogs
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
    documentsClient.dispose()
    delete controller.documentsClient
    controller.unregisterAgentTools?.()
    delete controller.unregisterAgentTools
    await controller.unregisterDocuments?.()
    delete controller.unregisterDocuments
    connectorClient.dispose()
    delete controller.connectorClient
    await controller.unregisterConnector?.()
    delete controller.unregisterConnector
    runtimeScope.retirePrincipal()!(controller, 'Plugin disposed after activation failure')
    throw error
  }
}
