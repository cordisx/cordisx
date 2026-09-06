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
  errorMessage,
  PluginController,
  pluginInject,
  pluginPresentation,
  writeBlockedPlugins,
} from './runtime-shared.js'

export const createRuntimeManagerSnapshot = (runtimeScope: RuntimeClosureScope): ManagerSnapshot => {
  const liveRegistrations = runtimeScope.slotService?.snapshot() ?? []
  const extensionPointControls = runtimeScope.slotService?.controlManagerSnapshot()
  const livePluginIds = new Set(liveRegistrations.map(item => item.owner))
  const activeRegistrationKeys = new Set(
    runtimeScope.activeControllers()!().map(
      controller => (`${controller.item.id}\u0000${runtimeScope.moduleGenerationOf()!(controller)}`),
    ),
  )
  const inactiveRegistrations = [...runtimeScope.knownRegistrations()!]
    .filter(([key, registrations]) =>
      activeRegistrationKeys.has(key)
      && registrations.every(item => !livePluginIds.has(item.owner))
    )
    .flatMap(([, registrations]) =>
      registrations.map(item => ({
        ...item,
        visible: false,
        rendered: false,
        error: item.error ?? 'owning plugin is inactive',
      }))
    )
  const allRegistrations = [...liveRegistrations, ...inactiveRegistrations]
  const nextContributionSites = new Map<string, string>()
  for (const registration of allRegistrations) {
    nextContributionSites.set(`extension-point:contribution:${registration.qualifiedId}:title`, registration.owner)
    nextContributionSites.set(
      `extension-point:contribution:${registration.qualifiedId}:description`,
      registration.owner,
    )
  }
  for (const [site, owner] of runtimeScope.extensionContributionProjectionSites) {
    if (!nextContributionSites.has(site)) {
      runtimeScope.i18nService?.clearDiagnosticSite(owner, site)
    }
  }
  runtimeScope.extensionContributionProjectionSites = nextContributionSites
  const navigation = runtimeScope.routeService?.snapshot() ?? { routes: [], pages: [], outlets: [] }
  const nextSettingsSites = new Set<string>()
  const externalSettingsTabs = liveRegistrations
    .filter(item =>
      item.surface === 'manager.settings.tabs' && item.valid && item.visible && item.authorized && !item.pending
    )
    .map((registration): ManagerSettingsTabSnapshot => {
      const item = registration.item as CordisXManagerSettingsTabItem
      const titleSite = `manager-settings:${registration.qualifiedId}:title`
      nextSettingsSites.add(titleSite)
      const disabledSite = `manager-settings:${registration.qualifiedId}:disabled`
      if (registration.disabledReason !== undefined) {
        nextSettingsSites.add(disabledSite)
      }
      return {
        id: registration.qualifiedId,
        owner: registration.owner,
        title: runtimeScope.i18nService?.resolveFor(registration.owner, item.title, titleSite).text
          ?? item.title.fallback
          ?? item.title.key,
        icon: item.icon,
        order: registration.order,
        disabled: registration.disabled,
        ...(registration.disabledReason === undefined ? {} : {
          disabledReason:
            runtimeScope.i18nService?.resolveFor(registration.owner, registration.disabledReason, disabledSite).text
              ?? registration.disabledReason.fallback
              ?? registration.disabledReason.key,
        }),
        builtin: false,
        route: item.route,
      }
    })
  for (const site of runtimeScope.settingsProjectionSites) {
    if (!nextSettingsSites.has(site)) {
      const owner = site.split(':')[1]
      if (owner !== undefined) {
        runtimeScope.i18nService?.clearDiagnosticSite(owner, site)
      }
    }
  }
  runtimeScope.settingsProjectionSites = nextSettingsSites
  // Keep resolving compatibility descriptors for diagnostic/localization cleanup;
  // they deliberately have no live Manager projection.
  void externalSettingsTabs
  // A is a retained protocol/catalog contract, not a current Manager product
  // surface. Do not project a hidden Settings page or a clickable empty tab.
  const settingsTabs: readonly ManagerSettingsTabSnapshot[] = Object.freeze([])
  const nextSettingsNavigationSites = new Map<string, string>()
  const settingsNavigationItems = sortManagerSettingsNavigationItems(
    liveRegistrations
      .filter(item =>
        item.surface === 'manager.settings.navigation-items'
        && item.valid && item.visible && item.authorized && !item.pending
        && (item.group === 'before-settings' || item.group === 'after-settings')
      )
      .flatMap((registration): readonly ManagerSettingsNavigationItemSnapshot[] => {
        const item = registration.item as CordisXManagerSettingsNavigationItem
        const route = navigation.routes.find(candidate =>
          candidate.owner === registration.owner
          && candidate.qualifiedId === `${registration.owner}:${item.route.id}`
          && candidate.valid && candidate.authorized
          && candidate.productMetadata.title !== undefined && candidate.productMetadata.description !== undefined
        )
        if (route === undefined) {
          return []
        }
        const page = navigation.pages.find(candidate =>
          candidate.owner === registration.owner
          && candidate.qualifiedId === `${registration.owner}:${route.definition.page}`
          && candidate.metadata.icon !== undefined
          && candidate.productMetadata.title !== undefined && candidate.productMetadata.description !== undefined
        )
        if (page === undefined) {
          return []
        }
        const title = route.productMetadata.title
        const description = route.productMetadata.description
        const pageTitle = page.productMetadata.title
        const pageDescription = page.productMetadata.description
        if (
          title === undefined || description === undefined || pageTitle === undefined
          || pageDescription === undefined
        ) {
          return []
        }
        const disabledSite = `manager-settings-navigation:${registration.qualifiedId}:disabled`
        if (registration.disabledReason !== undefined) {
          nextSettingsNavigationSites.set(disabledSite, registration.owner)
        }
        return [Object.freeze({
          id: registration.qualifiedId,
          owner: registration.owner,
          group: registration.group as 'before-settings' | 'after-settings',
          navigationGroup: item.navigationGroup?.id ?? 'other',
          order: registration.order,
          title,
          description,
          pageTitle,
          pageDescription,
          icon: page.metadata.icon!,
          disabled: registration.disabled,
          ...(registration.disabledReason === undefined ? {} : {
            disabledReason:
              runtimeScope.i18nService?.resolveFor(registration.owner, registration.disabledReason, disabledSite).text
                ?? registration.disabledReason.fallback ?? registration.disabledReason.key,
          }),
          route: item.route,
        })]
      }),
  )
  for (const [site, owner] of runtimeScope.settingsNavigationProjectionSites) {
    if (!nextSettingsNavigationSites.has(site)) {
      runtimeScope.i18nService?.clearDiagnosticSite(owner, site)
    }
  }
  runtimeScope.settingsNavigationProjectionSites = nextSettingsNavigationSites
  const hostText = (
    value: CordisXLocalizedText,
    site: string,
  ): string => (runtimeScope.i18nService?.resolveFor('host', value, site).text
    ?? value.fallback
    ?? `[[host:${value.key}]]`)
  const locale = runtimeScope.i18nService?.getSnapshot().locale ?? 'en'
  return {
    version: runtimeScope.metadata()!.version,
    plugins: runtimeScope.projectedControllers()!().map((controller): ManagerPluginSnapshot => {
      const icon = pluginBrandIconDataUrl(controller.item.module?.icon)
      const readme = selectPluginReadme(controller.item, locale)
      const development = [...runtimeScope.localDevelopment()!.values()].find(item =>
        item.pluginId === controller.item.id
      )
      return {
        id: controller.item.id,
        source: controller.item.source,
        ...pluginPresentation(controller, readme, runtimeScope.i18nService),
        ...(icon === undefined ? {} : { icon }),
        inject: pluginInject(controller.item.module),
        config: runtimeScope.configuration()!.descriptor(controller.item.id, locale).value,
        configuration: runtimeScope.configuration()!.descriptor(controller.item.id, locale),
        ...(readme === undefined ? {} : { readme }),
        ...(controller.item.package === undefined ? {} : {
          package: {
            version: controller.item.package.version,
            digest: controller.item.package.digest,
            moduleGeneration: controller.item.package.moduleGeneration,
            dependencies: controller.item.package.dependencies.map(item => item.id),
            ...(controller.item.package.canonicalSource === undefined
              ? {}
              : { canonicalSource: controller.item.package.canonicalSource }),
          },
        }),
        ...(development === undefined ? {} : { development }),
        status: controller.status,
        ...(controller.error === undefined ? {} : { error: controller.error }),
        ...(controller.blockedReason === undefined ? {} : { blockedReason: controller.blockedReason }),
      }
    }),
    localDevelopment: [...runtimeScope.localDevelopment()!.values()].map(item => structuredClone(item)),
    registrations: allRegistrations,
    commands: runtimeScope.commandService?.snapshot() ?? [],
    navigation,
    settingsTabs,
    settingsNavigationItems,
    localization: runtimeScope.i18nService?.getSnapshot() ?? { locale: 'en', direction: 'ltr', version: 0 },
    localeCatalogs: runtimeScope.i18nService?.catalogs() ?? [],
    localizationDiagnostics: runtimeScope.i18nService?.diagnostics() ?? [],
    platform: runtimeScope.platformAdapter()!.status(),
    capabilityProviders: runtimeScope.capabilityAvailability()!.providerSnapshot().map(provider => ({
      providerId: provider.providerId,
      providerNameText: hostText(provider.providerName, `capability-provider:${provider.providerId}:name`),
      kind: provider.kind,
      family: provider.family,
      status: provider.status,
      reasonText: hostText(provider.reason, `capability-provider:${provider.providerId}:reason`),
      ...(provider.generation === undefined ? {} : { generation: provider.generation }),
    })),
    pluginLifecycle: {
      profileId: runtimeScope.metadata()!.profileId,
      revision: runtimeScope.currentActivation.revision,
      runtimeGeneration: runtimeScope.generation()!,
      operationsAvailable: runtimeScope.lifecycleBridge()! !== undefined,
    },
    ...(runtimeScope.currentPluginBundles === undefined ? {} : { pluginBundles: runtimeScope.currentPluginBundles }),
    iconThemes: runtimeScope.iconThemeRegistry()!.redactedSnapshot(),
    permissions: runtimeScope.broker()!.snapshots().map((permission: PlatformPermissionSnapshot) => {
      const pointId = permission.capability === 'ui.extension-points.render'
        ? permission.scope.extensionPoints?.[0]
        : undefined
      const descriptor = pointId === undefined
        ? undefined
        : runtimeScope.extensionPointDescriptors()!.descriptor(pointId)
      const hostDomController =
        permission.capability === 'ui.host-dom.read' || permission.capability === 'ui.host-dom.modify'
          ? runtimeScope.activeController()!(permission.identity.id, permission.identity.source)
          : undefined
      const isolatedHostDomReady = hostDomController?.item.isolatedArtifactSource !== undefined
        && hostDomController.hostDomWorker?.status().status === 'ready'
      const availability =
        permission.capability === 'ui.host-dom.read' || permission.capability === 'ui.host-dom.modify'
          ? isolatedHostDomReady
            ? {
              status: 'supported' as const,
              reason: Object.freeze({
                namespace: 'cordisx.permission.host',
                key: 'availability.host-dom-worker-ready',
                fallback: 'Host DOM access is available through the isolated CordisX worker boundary.',
              }),
              providers: [{
                providerId: 'host-dom-worker',
                providerName: Object.freeze({
                  namespace: 'cordisx.permission.host',
                  key: 'provider.host-dom-worker.name',
                  fallback: 'CordisX isolated Host DOM worker',
                }),
                kind: 'host-local' as const,
                family: 'ui-rendering' as const,
                status: 'supported' as const,
                reason: Object.freeze({
                  namespace: 'cordisx.permission.host',
                  key: 'provider.host-dom-worker.ready',
                  fallback: 'Plugin code has no ambient renderer DOM and uses bounded opaque handles.',
                }),
                generation: runtimeScope.generation()!,
                scope: permission.scope,
              }],
            }
            : {
              status: 'unavailable' as const,
              reason: Object.freeze({
                namespace: 'cordisx.permission.host',
                key: 'availability.host-dom-isolation-unavailable',
                fallback: 'Host DOM access is unavailable until plugins run without ambient renderer DOM access.',
              }),
              providers: [],
            }
          : permission.capability === 'ui.extension-points.render'
          ? {
            status: descriptor?.adapterSupport === 'supported'
              ? 'supported' as const
              : descriptor?.adapterSupport === 'unverified'
              ? 'degraded' as const
              : 'unavailable' as const,
            reason: descriptor?.diagnostic ?? descriptor?.description ?? Object.freeze({
              namespace: 'cordisx.manager.extension-points',
              key: 'permission.point-unavailable',
              fallback: 'The declared Host extension point is unavailable.',
            }),
            providers: descriptor === undefined ? [] : [{
              providerId: `host-extension-point:${descriptor.id}`,
              providerName: descriptor.title,
              kind: 'host-local' as const,
              family: 'ui-rendering' as const,
              status: descriptor.adapterSupport === 'supported'
                ? 'supported' as const
                : descriptor.adapterSupport === 'unverified'
                ? 'degraded' as const
                : 'unavailable' as const,
              reason: descriptor.diagnostic ?? descriptor.description,
              scope: permission.scope,
            }],
          }
          : runtimeScope.capabilityAvailability()!.resolve(
            permission.capability as CordisXPlatformCapability,
            permission.scope as CordisXCapabilityScope,
          )
      const site =
        `permission:${permission.identity.source}:${permission.identity.id}:${permission.capability}:${permission.fingerprint}`
      return {
        identity: permission.identity,
        capability: permission.capability,
        required: permission.required,
        reason: permission.reason,
        reasonText: runtimeScope.i18nService?.resolveFor(
          permission.capability === 'ui.extension-points.render' ? 'host' : permission.identity.id,
          permission.reason,
          site,
        ).text
          ?? permission.reason.fallback
          ?? `[[${permission.identity.id}:${permission.reason.key}]]`,
        scope: permission.scope,
        fingerprint: permission.fingerprint,
        policy: permission.policy,
        ...(permission.lastRequested === undefined ? {} : { lastRequested: permission.lastRequested }),
        ...(permission.lastUsedAt === undefined ? {} : { lastUsedAt: permission.lastUsedAt }),
        ...(permission.lastDeniedAt === undefined ? {} : { lastDeniedAt: permission.lastDeniedAt }),
        denialCount: permission.denialCount,
        ...(permission.blockedReason === undefined ? {} : { blockedReason: permission.blockedReason }),
        ...(permission.authorizationOrigin === undefined
          ? {}
          : { authorizationOrigin: permission.authorizationOrigin }),
        ...(permission.authorizationReason === undefined
          ? {}
          : { authorizationReason: permission.authorizationReason }),
        ...(permission.certification === undefined ? {} : { certification: permission.certification }),
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
            ...(!('generation' in provider) || provider.generation === undefined
              ? {}
              : { generation: provider.generation }),
            scope: provider.scope,
          })),
        },
      }
    }),
    extensionPoints: buildExtensionPointRuntimeSnapshot({
      descriptors: runtimeScope.extensionPointDescriptors()!,
      broker: runtimeScope.extensionPointBroker()!,
      i18n: runtimeScope.i18nService!,
      plugins: runtimeScope.activeControllers()!().map(controller => ({
        id: controller.item.id,
        source: controller.item.source,
        ...pluginPresentation(controller, selectPluginReadme(controller.item, locale), runtimeScope.i18nService),
        status: controller.status,
      })),
      registrations: allRegistrations,
      commands: runtimeScope.commandService?.snapshot() ?? [],
      navigation,
      surfaceAvailability: runtimeScope.slotService?.registry.availabilitySnapshot() ?? [],
    }),
    ...(extensionPointControls === undefined ? {} : { extensionPointControls }),
  }
}

export const createRuntimeSetPluginBlocked = (
  runtimeScope: RuntimeClosureScope,
  id: string,
  blocked: boolean,
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
    if (blocked) {
      runtimeScope.blockedPlugins()!.add(id)
      writeBlockedPlugins(runtimeScope.blockedPlugins()!)
      runtimeScope.broker()!.clearOnce(controller.identity)
      await runtimeScope.disposeControllerFiber()!(controller, 'owner-disposed')
      controller.status = 'blocked'
      delete controller.error
      runtimeScope.notify()!()
      return
    }
    if (controller.status === 'active') {
      return
    }
    runtimeScope.blockedPlugins()!.delete(id)
    writeBlockedPlugins(runtimeScope.blockedPlugins()!)
    const blockedReason = runtimeScope.requiredBlockReason()!(controller)
    if (blockedReason !== undefined) {
      controller.status = 'permission-blocked'
      controller.blockedReason = blockedReason
      runtimeScope.notify()!()
      return
    }
    try {
      await runtimeScope.mountPlugin()!(controller)
    } catch (error) {
      runtimeScope.blockedPlugins()!.add(id)
      writeBlockedPlugins(runtimeScope.blockedPlugins()!)
      runtimeScope.notify()!()
      throw error
    }
    runtimeScope.notify()!()
  })
  runtimeScope.operation = task.catch(() => {})
  return task
}

export const createRuntimeRemountLastGood = async (
  runtimeScope: RuntimeClosureScope,
  controller: PluginController,
): Promise<void> => {
  runtimeScope.configuration()!.abort(controller.item.id)
  await runtimeScope.disposeControllerFiber()!(controller, 'owner-disposed')
  await runtimeScope.mountPlugin()!(controller)
}

export const createRuntimeApplyRestartCandidate = async (
  runtimeScope: RuntimeClosureScope,
  controller: PluginController,
  candidate: ConfigCandidate,
): Promise<void> => {
  await runtimeScope.disposeControllerFiber()!(controller, 'owner-disposed')
  runtimeScope.configuration()!.begin(controller.item.id, candidate)
  await runtimeScope.mountPlugin()!(controller)
}

export const createRuntimeUpdatePluginConfig = (
  runtimeScope: RuntimeClosureScope,
  id: string,
  expectedRevision: number,
  operations: readonly ConfigMutationOperation[],
): Promise<void> => {
  const task = runtimeScope.operation.then(async () => {
    if (runtimeScope.disposed) {
      throw new Error('CordisX runtime is disposed')
    }
    const controller = runtimeScope.activeController()!(id)
    if (controller === undefined) {
      throw new Error(`unknown CordisX plugin: ${id}`)
    }
    if (runtimeScope.configBridge()! === undefined) {
      throw new Error('plugin configuration writer is unavailable in this launcher mode')
    }
    const descriptor = runtimeScope.configuration()!.descriptor(
      id,
      runtimeScope.i18nService?.getSnapshot().locale ?? 'en',
    )
    if (descriptor.applies === 'service-restart') {
      throw new Error('service-restart configuration requires an owning launcher service restart handler')
    }
    const candidate = runtimeScope.configuration()!.stage(id, expectedRevision, operations)
    const staged = await runtimeScope.configBridge()!.stage(controller.identity, expectedRevision, candidate.raw)
    let candidateMounted = false
    try {
      const mayMount = controller.item.enabled
        && controllerHasRuntimeModule(controller)
        && !runtimeScope.blockedPlugins()!.has(id)
        && runtimeScope.requiredBlockReason()!(controller) === undefined
      if (descriptor.applies === 'plugin-restart' && mayMount) {
        try {
          await runtimeScope.applyRestartCandidate()!(controller, candidate)
          candidateMounted = true
        } catch (restartError) {
          runtimeScope.configuration()!.abort(id)
          await runtimeScope.configBridge()!.abort(controller.identity, staged.candidateRevision).catch(() => undefined)
          try {
            await runtimeScope.remountLastGood()!(controller)
          } catch (rollbackError) {
            controller.status = 'failed'
            controller.error = `rollback-failed: ${errorMessage(rollbackError)}`
            runtimeScope.notify()!()
            throw new Error(
              `plugin restart failed (${errorMessage(restartError)}); last-good rollback failed (${
                errorMessage(rollbackError)
              })`,
            )
          }
          throw new Error(`plugin restart failed; last-good restored: ${errorMessage(restartError)}`)
        }
      }
      const committed = await runtimeScope.configBridge()!.commit(controller.identity, staged.candidateRevision)
      if (descriptor.applies === 'app-restart') {
        runtimeScope.configuration()!.commitForAppRestart(id, committed.revision, candidate)
      } else {
        runtimeScope.configuration()!.commit(id, committed.revision, candidate)
      }
      runtimeScope.notify()!()
    } catch (error) {
      if (candidateMounted) {
        try {
          await runtimeScope.remountLastGood()!(controller)
        } catch (rollbackError) {
          controller.status = 'failed'
          controller.error = `rollback-failed: ${errorMessage(rollbackError)}`
        }
      } else {
        runtimeScope.configuration()!.abort(id)
      }
      await runtimeScope.configBridge()!.abort(controller.identity, staged.candidateRevision).catch(() => undefined)
      runtimeScope.notify()!()
      throw error
    }
  })
  runtimeScope.operation = task.catch(() => {})
  return task
}

export const createRuntimeSetPermissionPolicy = (
  runtimeScope: RuntimeClosureScope,
  id: string,
  capability: CordisXPermissionCapabilityV4,
  policy: CordisXPermissionPolicy,
  scope?: CordisXPermissionScopeV4,
): Promise<void> => {
  const task = runtimeScope.operation.then(async () => {
    if (runtimeScope.disposed) {
      throw new Error('CordisX runtime is disposed')
    }
    const controller = runtimeScope.activeController()!(id)
    if (controller === undefined) {
      throw new Error(`unknown CordisX plugin: ${id}`)
    }
    if (capability === 'ui.extension-points.render') {
      const points = scope?.extensionPoints
      if (points === undefined || points.length !== 1) {
        throw new Error('DOM permission policy requires one exact extension point scope')
      }
      await runtimeScope.broker()!.setDomPolicy(
        controller.identity,
        points[0]!,
        policy === 'allow' ? 'allow-persistent' : policy === 'deny' ? 'deny-persistent' : 'ask',
      )
    } else if (capability === 'ui.host-dom.read' || capability === 'ui.host-dom.modify') {
      await runtimeScope.broker()!.setHostDomPolicy(
        controller.identity,
        capability,
        policy === 'allow' ? 'allow-persistent' : policy === 'deny' ? 'deny-persistent' : 'ask',
        controller.generationView,
      )
    } else if (
      controller.manifest.schemaVersion === 4 || controller.manifest.schemaVersion === 5
      || controller.manifest.schemaVersion === 6 || controller.manifest.schemaVersion === 7
      || controller.manifest.schemaVersion === 8 || controller.manifest.schemaVersion === 9
    ) {
      await runtimeScope.broker()!.setPolicyV2(
        controller.identity,
        capability,
        policy === 'allow' ? 'allow-persistent' : policy === 'deny' ? 'deny-persistent' : 'ask',
      )
    } else {
      await runtimeScope.broker()!.setPolicy(controller.identity, capability as CordisXPlatformCapability, policy)
    }
    const blockedReason = runtimeScope.requiredBlockReason()!(controller)
    if (blockedReason !== undefined) {
      await runtimeScope.disposeControllerFiber()!(controller, 'owner-disposed')
      controller.status = 'permission-blocked'
      controller.blockedReason = blockedReason
      runtimeScope.notify()!()
      return
    }
    if (controller.status === 'permission-blocked') {
      delete controller.blockedReason
      if (runtimeScope.blockedPlugins()!.has(id)) {
        controller.status = 'blocked'
      } else if (controller.item.enabled && controllerHasRuntimeModule(controller)) {
        await runtimeScope.mountPlugin()!(controller)
      } else {
        controller.status = 'configured-disabled'
      }
    }
    runtimeScope.notify()!()
  })
  runtimeScope.operation = task.catch(() => {})
  return task
}

export const createRuntimeSubscribe = (runtimeScope: RuntimeClosureScope, listener: () => void): () => void => {
  runtimeScope.listeners()!.add(listener)
  return () => runtimeScope.listeners()!.delete(listener)
}

export const createRuntimeSetExtensionPointPolicy = (
  runtimeScope: RuntimeClosureScope,
  source: string,
  pluginId: string,
  pointId: string,
  policy: CordisXPointPolicy,
): Promise<void> => {
  const task = runtimeScope.operation.then(async () => {
    if (runtimeScope.disposed) {
      throw new Error('CordisX runtime is disposed')
    }
    const controller = runtimeScope.activeController()!(pluginId, source)
    if (controller === undefined) {
      throw new Error(`unknown CordisX plugin identity: ${source} / ${pluginId}`)
    }
    await runtimeScope.broker()!.setDomPolicy(
      controller.identity,
      pointId,
      policy === 'allow' ? 'allow-persistent' : policy === 'deny' ? 'deny-persistent' : 'ask',
    )
    runtimeScope.slotService?.invalidatePointPolicies()
    await runtimeScope.routeService?.invalidatePointPolicies()
    runtimeScope.notify()!()
  })
  runtimeScope.operation = task.catch(() => {})
  return task
}

export const createRuntimeSetExtensionPointPolicies = (
  runtimeScope: RuntimeClosureScope,
  source: string,
  pluginId: string,
  policies: readonly { readonly pointId: string; readonly policy: CordisXPointPolicy }[],
): Promise<void> => {
  const task = runtimeScope.operation.then(async () => {
    if (runtimeScope.disposed) {
      throw new Error('CordisX runtime is disposed')
    }
    const controller = runtimeScope.activeController()!(pluginId, source)
    if (controller === undefined) {
      throw new Error(`unknown CordisX plugin identity: ${source} / ${pluginId}`)
    }
    await runtimeScope.broker()!.setDomPolicies(
      controller.identity,
      policies.map(({ pointId, policy }) => ({
        pointId,
        policy: policy === 'allow' ? 'allow-persistent' : policy === 'deny' ? 'deny-persistent' : 'ask',
      })),
    )
    runtimeScope.slotService?.invalidatePointPolicies()
    await runtimeScope.routeService?.invalidatePointPolicies()
    runtimeScope.notify()!()
  })
  runtimeScope.operation = task.catch(() => {})
  return task
}
