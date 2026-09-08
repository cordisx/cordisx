import type {
  CordisXCapabilityAvailabilityState,
  CordisXCapabilityProviderFamily,
  CordisXCapabilityProviderKind,
} from '../capability-availability-contracts.js'
import type { CordisXConfigFieldSnapshot } from '../contracts.js'
import {
  type CordisXIconToken,
  type CordisXLocalizationDiagnostic,
  type CordisXLocalizationSnapshot,
  type CordisXLocalizedText,
  type CordisXPermissionAuthorizationDecisionV1,
  type CordisXPermissionAuthorizationPlanV1,
  type CordisXPermissionPolicy,
  type CordisXPlatformAdapterStatus,
  type CordisXPlatformCapability,
  type CordisXPluginConsolePageV1,
  type CordisXPluginIdentity,
  type CordisXPluginLifecycleOperationV1,
  type CordisXPluginLifecycleResultV1,
  type CordisXRouteReference,
} from '../contracts.js'
import type {
  HostServiceConfigDescriptor,
  HostServiceConfigMutation,
  HostServiceConfigMutationResult,
} from '../launcher/service-config.js'
import type { CordisXLocalDevelopmentSnapshot } from '../local-development-contracts.js'
import type {
  CordisXCertifiedPermissionProjectionV1,
  CordisXPermissionAuthorizationDecisionV2,
  CordisXPermissionAuthorizationDecisionV4,
  CordisXPermissionAuthorizationPlanV2,
  CordisXPermissionAuthorizationPlanV4,
  CordisXPermissionCapabilityV4,
  CordisXPermissionScopeV4,
} from '../permission-contracts.js'
import type {
  CordisXPluginBundleLifecycleOperationV1,
  CordisXPluginBundleLifecycleResultV1,
  CordisXPluginBundleManagerSnapshotV1,
} from '../plugin-bundle-contracts.js'
import type { CommandSnapshot } from './commands.js'
import type {
  ConfigMutationOperation,
  ConfigRendererMountHandle,
  ManagerPluginConfigSnapshot,
} from './configuration.js'
import type { ControlledSurfaceGroupChoice, ControlledSurfaceManagerSnapshot } from './controlled-surfaces.js'
import type { ExtensionPointRuntimeSnapshot } from './extension-points.js'
import type { LocaleCatalogSnapshot } from './i18n.js'
import type { RedactedIconThemeProvider, RedactedIconThemeSnapshot } from './icon-theme-registry.js'
import { type ManagerIconToken } from './icons.js'
import { type MarketplaceCatalogEligibility, type MarketplaceCatalogPlugin } from './marketplace.js'
import type {
  ManagedManagerPageMount,
  ManagedSettingsPageMount,
  ManagerContentPresentation,
  NavigationSnapshot,
} from './navigation.js'
import type { RequestedScope } from './platform.js'
import type { SurfaceContributionSnapshot } from './surfaces.js'

export type ManagerPluginStatus =
  | 'active'
  | 'blocked'
  | 'permission-blocked'
  | 'configured-disabled'
  | 'failed'
  | 'installing'
  | 'updating'
  | 'enabling'
  | 'disabling'
  | 'reloading'
  | 'uninstalling'
  | 'rolling-back'
  | 'rollback-failed'

export interface ManagerPluginSnapshot {
  readonly id: string
  readonly source: string
  readonly name: string
  readonly icon?: string
  readonly description?: string
  readonly inject: readonly string[]
  readonly config: unknown
  readonly configuration: ManagerPluginConfigSnapshot
  readonly readme?: string
  readonly status: ManagerPluginStatus
  readonly error?: string
  readonly blockedReason?: string
  readonly package?: {
    readonly version: string
    readonly digest: `sha256:${string}`
    readonly moduleGeneration: string
    readonly dependencies: readonly string[]
    readonly canonicalSource?: string
  }
  /** Host-private local development provenance and build diagnostics. */
  readonly development?: CordisXLocalDevelopmentSnapshot
  /** The active Vite session can invalidate and reload this plugin on demand. */
  readonly developmentReloadAvailable?: boolean
}

export interface ManagerPermissionSnapshot {
  readonly identity: CordisXPluginIdentity
  readonly capability: CordisXPermissionCapabilityV4 | 'ui.extension-points.interact' | 'usage.read'
  readonly required: boolean
  readonly reason: CordisXLocalizedText
  readonly reasonText: string
  readonly scope: CordisXPermissionScopeV4
  readonly fingerprint: string
  readonly policy: CordisXPermissionPolicy
  readonly lastRequested?: RequestedScope
  readonly lastUsedAt?: string
  readonly lastDeniedAt?: string
  readonly denialCount: number
  readonly blockedReason?: string
  readonly authorizationOrigin?: 'explicit-user' | 'certified-implicit'
  readonly authorizationReason?: string
  readonly certification?: CordisXCertifiedPermissionProjectionV1
  readonly availability: ManagerCapabilityAvailabilitySnapshot
}

export interface ManagerCapabilityProviderSnapshot {
  readonly providerId: string
  readonly providerNameText: string
  readonly kind: CordisXCapabilityProviderKind
  readonly family: CordisXCapabilityProviderFamily
  readonly status: CordisXCapabilityAvailabilityState
  readonly reasonText: string
  readonly generation?: string
  readonly scope?: CordisXPermissionScopeV4
}

export interface ManagerCapabilityAvailabilitySnapshot {
  readonly status: CordisXCapabilityAvailabilityState
  readonly reasonText: string
  readonly providers: readonly ManagerCapabilityProviderSnapshot[]
}

export interface ManagerSnapshot {
  readonly version: string
  readonly plugins: readonly ManagerPluginSnapshot[]
  /** Launcher-owned entries, including a source whose first candidate has not activated yet. */
  readonly localDevelopment?: readonly CordisXLocalDevelopmentSnapshot[]
  readonly registrations: readonly SurfaceContributionSnapshot[]
  readonly commands: readonly CommandSnapshot[]
  readonly navigation: NavigationSnapshot
  readonly localization: CordisXLocalizationSnapshot
  readonly localeCatalogs: readonly LocaleCatalogSnapshot[]
  readonly localizationDiagnostics: readonly CordisXLocalizationDiagnostic[]
  readonly platform: CordisXPlatformAdapterStatus
  readonly permissions: readonly ManagerPermissionSnapshot[]
  /** Read-only declarations whose concrete scope is verified from each real request. */
  readonly runtimeExactPermissions?: readonly {
    readonly identity: CordisXPluginIdentity
    readonly capability: CordisXPlatformCapability
  }[]
  /** Host-owned providers; permission policy remains independently editable. */
  readonly capabilityProviders?: readonly ManagerCapabilityProviderSnapshot[]
  /** Runtime-owned point catalog/policy projection; manager UX consumes it in the following slice. */
  readonly extensionPoints?: ExtensionPointRuntimeSnapshot
  /** Host-only control-plane projection; presenter values and native state are intentionally absent. */
  readonly extensionPointControls?: ControlledSurfaceManagerSnapshot
  readonly settingsTabs?: readonly ManagerSettingsTabSnapshot[]
  readonly settingsNavigationItems?: readonly ManagerSettingsNavigationItemSnapshot[]
  readonly pluginLifecycle?: {
    readonly profileId: string
    readonly revision: number
    readonly runtimeGeneration: string
    readonly operationsAvailable: boolean
  }
  /** Host-owned bundle projection; bundle ids are management provenance, never runtime principals. */
  readonly pluginBundles?: CordisXPluginBundleManagerSnapshotV1
  /** Descriptor geometry, private handles, principals and request ids are never projected. */
  readonly iconThemes?: RedactedIconThemeSnapshot
}

export interface ManagerSettingsTabSnapshot {
  readonly id: string
  readonly owner: string
  readonly title: string
  readonly icon: CordisXIconToken
  readonly order: number
  readonly disabled: boolean
  readonly disabledReason?: string
  readonly builtin: boolean
  readonly route?: CordisXRouteReference
}

/** Host-projected B navigation record. Plugins contribute only their route reference. */
export interface ManagerSettingsNavigationItemSnapshot {
  readonly id: string
  readonly owner: string
  readonly group: 'before-settings' | 'after-settings'
  /** Host-resolved visual section; legacy/unassigned contributions use other. */
  readonly navigationGroup: 'resources' | 'development' | 'collaboration' | 'other'
  readonly order: number
  readonly disabled: boolean
  readonly disabledReason?: string
  readonly title: string
  readonly description: string
  readonly pageTitle: string
  readonly pageDescription: string
  readonly icon: CordisXIconToken
  readonly route: CordisXRouteReference
}

export interface ManagerModel {
  snapshot(): ManagerSnapshot
  pluginConsole?(id: string): CordisXPluginConsolePageV1
  clearPluginConsole?(id: string): void
  subscribePluginConsole?(listener: (pluginId: string) => void): () => void
  setPluginBlocked(id: string, blocked: boolean): Promise<void>
  updatePluginConfig?(
    id: string,
    expectedRevision: number,
    operations: readonly ConfigMutationOperation[],
  ): Promise<void>
  /** Host-owned launcher services are rendered only inside their owning plugin detail. */
  listServiceConfigs?(pluginId: string): Promise<readonly HostServiceConfigDescriptor[]>
  updateServiceConfig?(mutation: HostServiceConfigMutation): Promise<HostServiceConfigMutationResult>
  mountConfigRenderer?(
    pluginId: string,
    field: CordisXConfigFieldSnapshot,
    container: HTMLElement,
    setDraft: (value: unknown) => void,
  ): Promise<ConfigRendererMountHandle>
  setPermissionPolicy(
    id: string,
    capability: CordisXPermissionCapabilityV4 | 'ui.extension-points.interact' | 'usage.read',
    policy: CordisXPermissionPolicy,
    scope?: CordisXPermissionScopeV4,
  ): Promise<void>
  /** Optional Host policy projection. Ranking always removes ineligible entries before text/trust scoring. */
  marketplaceEligibility?(plugin: MarketplaceCatalogPlugin): MarketplaceCatalogEligibility
  permissionAuthorizationPlan?(id: string): CordisXPermissionAuthorizationPlanV1
  authorizePlugin?(id: string, decision: CordisXPermissionAuthorizationDecisionV1): Promise<void>
  permissionAuthorizationPlanV2?(id: string): CordisXPermissionAuthorizationPlanV2 | undefined
  authorizePluginV2?(id: string, decision: CordisXPermissionAuthorizationDecisionV2): Promise<void>
  permissionLifecycleReviewPlanV2?(
    target: { readonly kind: 'candidate'; readonly candidateId: string } | {
      readonly kind: 'enable'
      readonly pluginId: string
    },
  ): Promise<CordisXPermissionAuthorizationPlanV2 | undefined>
  applyPermissionLifecycleReviewV2?(
    decision: CordisXPermissionAuthorizationDecisionV2,
  ): Promise<CordisXPluginLifecycleResultV1>
  permissionLifecycleReviewPlanV4?(
    target: { readonly kind: 'candidate'; readonly candidateId: string } | {
      readonly kind: 'enable'
      readonly pluginId: string
    },
  ): Promise<CordisXPermissionAuthorizationPlanV4 | undefined>
  applyPermissionLifecycleReviewV4?(
    decision: CordisXPermissionAuthorizationDecisionV4,
  ): Promise<CordisXPluginLifecycleResultV1>
  requestPluginLifecycle?(operation: CordisXPluginLifecycleOperationV1): Promise<CordisXPluginLifecycleResultV1>
  requestPluginBundleLifecycle?(
    operation: CordisXPluginBundleLifecycleOperationV1,
  ): Promise<CordisXPluginBundleLifecycleResultV1>
  setExtensionPointPolicy?(
    source: string,
    pluginId: string,
    pointId: string,
    policy: 'inherit' | 'allow' | 'deny',
  ): Promise<void>
  setExtensionPointControlAuthorization?(
    expectedPolicyRevision: number,
    reference: Readonly<{
      principalHandle: string
      source: string
      pluginId: string
      pointId: string
      claimId: string
      mode: import('../contracts.js').CordisXExtensionPointControlMode
    }>,
    policy: 'inherit' | 'allow' | 'deny',
  ): Promise<void>
  setExtensionPointControlGroupChoice?(
    expectedPolicyRevision: number,
    choice: ControlledSurfaceGroupChoice,
  ): Promise<void>
  /** Host-private exact selection; plugin-facing runtime snapshots cannot invoke it. */
  selectIconTheme?(
    expectedProfileRevision: number,
    candidate: Pick<RedactedIconThemeProvider, 'providerId' | 'namespace' | 'providerVersion' | 'providerGeneration'>,
  ): Promise<void>
  /** Whether the launcher can durably CAS this profile's selection. */
  readonly iconThemePreferenceWritable?: boolean
  mountSettingsTab?(id: string, panelBody: HTMLElement): Promise<ManagedSettingsPageMount>
  closeSettingsTabContent?(): Promise<void>
  managerContentPresentation?(id: string, reference: CordisXRouteReference): ManagerContentPresentation | undefined
  mountManagerContent?(
    id: string,
    reference: CordisXRouteReference,
    container: HTMLElement,
    navigation: {
      readonly navigate: (reference: CordisXRouteReference) => Promise<void>
      readonly back: () => Promise<void>
    },
  ): Promise<ManagedManagerPageMount>
  closeManagerContent?(): Promise<void>
  subscribe(listener: () => void): () => void
}

export type ManagerTab = 'about' | 'extension-points' | 'routes' | 'plugins' | 'marketplace' | 'settings'
export type PluginDetailTab = 'readme' | 'config' | 'permissions' | 'runtime' | 'logs' | 'extension-points' | 'routes'
export type ExtensionPointDetailTab = 'usage' | 'information' | 'diagnostics'
export type MarketplaceDetailTab = 'overview' | 'authors-source'
export type MarketplaceSourcePage = 'index' | 'create' | 'edit'
export type LocalTabIcon = ManagerIconToken
export type ManagerRouteState =
  | { readonly kind: 'primary'; readonly primary: ManagerTab }
  | { readonly kind: 'plugin'; readonly pluginId: string; readonly facet: PluginDetailTab }
  | {
    readonly kind: 'permission'
    readonly pluginId: string
    readonly capability: CordisXPermissionCapabilityV4 | 'ui.extension-points.interact' | 'usage.read'
    readonly fingerprint: string
  }
  | { readonly kind: 'marketplace'; readonly identity: string; readonly facet: MarketplaceDetailTab }
  | { readonly kind: 'marketplace-source'; readonly page: MarketplaceSourcePage; readonly url?: string }
  | { readonly kind: 'extension-point'; readonly pointId: string; readonly facet: ExtensionPointDetailTab }
  | { readonly kind: 'route'; readonly qualifiedId: string }
  | { readonly kind: 'page'; readonly qualifiedId: string }
  /** Legacy route state is normalized to Plugins; no global Settings page is mounted. */
  | { readonly kind: 'settings'; readonly tabId: string }
  | { readonly kind: 'manager-content'; readonly id: string; readonly reference: CordisXRouteReference }

export interface ManagerBreadcrumbSegment {
  readonly id: string
  readonly label: string
  readonly target?: ManagerRouteState
}

export interface ManagerPageRoute {
  readonly id: string
  readonly primary: string
  readonly segments: readonly ManagerBreadcrumbSegment[]
}

export interface BreadcrumbProjection {
  readonly visible: readonly number[]
  readonly overflow: readonly number[]
}
export type ExtensionPointRowStatus = Readonly<{
  state: 'pending' | 'unavailable' | 'error'
  text: string
  icon: 'host:warning' | 'host:error'
}>
export type ManagerActionMenuItem = {
  readonly id: string
  readonly label: string
  readonly icon: ManagerIconToken
  readonly disabled?: boolean
  readonly invoke: () => void | Promise<void>
}
export type ManagerContentFocusRestore =
  | { readonly kind: 'navigation' }
  | { readonly kind: 'tab'; readonly id: string }
  | undefined
