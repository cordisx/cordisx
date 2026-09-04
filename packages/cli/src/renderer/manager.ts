import {
  type CordisXCapabilityScope,
  type CordisXLocalizationDiagnostic,
  type CordisXLocalizationSnapshot,
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
  type CordisXPermissionAuthorizationDecisionV1,
  type CordisXPermissionPolicy,
  type CordisXPermissionAuthorizationPlanV1,
  type CordisXPlatformAdapterStatus,
  type CordisXPlatformCapability,
  type CordisXPluginIdentity,
  type CordisXPluginConsolePageV1,
  type CordisXPluginConsoleEntryV1,
  type CordisXPluginConsoleValueSummaryV1,
  type CordisXIconToken,
  type CordisXLocalizedText,
  type CordisXRouteReference,
  type CordisXPluginLifecycleOperationV1,
  type CordisXPluginLifecycleResultV1,
} from '../contracts.js'
import type { LocaleCatalogSnapshot } from './i18n.js'
import type {
  CordisXCertifiedPermissionProjectionV1,
  CordisXPermissionAuthorizationDecisionV2,
  CordisXPermissionAuthorizationDecisionV4,
  CordisXPermissionAuthorizationPlanV2,
  CordisXPermissionAuthorizationPlanV4,
  CordisXPermissionCapabilityV2,
  CordisXPermissionCapabilityV4,
  CordisXPermissionScopeV4,
} from '../permission-contracts.js'
import { PermissionAuthorizationViewModel } from '../permission-authorization-view-model.js'
import {
  BrowserMarketplaceModel,
  OFFICIAL_MARKETPLACE_SOURCE,
  normalizeMarketplaceSource,
  projectMarketplacePlugin,
  projectMarketplaceSource,
  searchMarketplaceCatalog,
  type MarketplaceCatalogEligibility,
  type MarketplaceCatalogPlugin,
  type MarketplaceFetcher,
  type MarketplaceModel,
  type MarketplaceSourceRecord,
  type MarketplaceSourceSnapshot,
  type MarketplaceStorage,
} from './marketplace.js'
import type { MarketplaceCertificationRecord } from './marketplace-trust.js'
import { highlightSafeMarkdownCodeBlocks, renderSafeMarkdown } from './markdown.js'
import type { CommandSnapshot } from './commands.js'
import { resolveManagerTriggerTarget } from './host-probes.js'
import {
  createHostSurfaceIcon,
  createManagerIcon,
  hostSurfaceIconKey,
  renderHostIconSvg,
  renderManagerIconSvg,
  type ManagerIconToken,
} from './icons.js'
import type {
  ManagedManagerPageMount,
  ManagerContentPresentation,
  ManagedSettingsPageMount,
  NavigationPageSnapshot,
  NavigationSnapshot,
  RouteSnapshot,
} from './navigation.js'
import type { SurfaceContributionSnapshot } from './surfaces.js'
import type { ControlledSurfaceGroupChoice, ControlledSurfaceManagerSnapshot } from './controlled-surfaces.js'
import type {
  CordisXPluginBundleLifecycleOperationV1,
  CordisXPluginBundleLifecycleResultV1,
  CordisXPluginBundleManagerSnapshotV1,
} from '../plugin-bundle-contracts.js'
import type { RedactedIconThemeProvider, RedactedIconThemeSnapshot } from './icon-theme-registry.js'
import type {
  ExtensionPointPluginUsageSnapshot,
  ExtensionPointRuntimeSnapshot,
  ExtensionPointSnapshot,
} from './extension-points.js'
import type { RequestedScope } from './platform.js'
import type {
  ConfigMutationOperation,
  ConfigRendererMountHandle,
  ManagerPluginConfigSnapshot,
} from './configuration.js'
import type { CordisXConfigFieldSnapshot, CordisXJsonValue } from '../contracts.js'
import type { CordisXLocalDevelopmentSnapshot } from '../local-development-contracts.js'
import type { HostServiceConfigDescriptor, HostServiceConfigMutation, HostServiceConfigMutationResult } from '../launcher/service-config.js'
import type {
  CordisXCapabilityAvailabilityState,
  CordisXCapabilityProviderFamily,
  CordisXCapabilityProviderKind,
} from '../capability-availability-contracts.js'
import cordisxMarkDark from '../../assets/brand/cordisx-mark-dark.svg'
import cordisxMarkLight from '../../assets/brand/cordisx-mark-light.svg'
import { HostTooltipController } from './tooltips.js'
import { HostThemeProjection, resolveHostTheme } from './host-theme.js'
import { HOST_FORM_STYLES, HostFormAdapter, hostConfigApplyMessage, selectHostFormPrimitive, validateHostFormValue } from './host-form.js'
import {
  HOST_COLLECTION_STYLES,
  createHostCollection,
  type HostCollectionAction,
  type HostCollectionItem,
  type HostCollectionStatus,
  type HostCollectionView,
} from './host-collection.js'
import {
  createTDesignElement,
  setTDesignDisabled,
  setTDesignProps,
  setTDesignText,
  type TDesignButtonElement,
  type TDesignElement,
  type TDesignSelectElement,
} from './tdesign-form.js'
import { BrowserPermissionAuthorizationDialog } from './permission-authorization-dialog.js'
import { managerCopy, productLocale } from './ui-copy.js'
import { sortManagerSettingsNavigationItems } from './manager-settings-navigation.js'
import type { MarketplaceRankingExplanation } from './marketplace-ranking.js'
import lunaConsoleCss from 'luna-console/luna-console.css'
import lunaDataGridCss from 'luna-data-grid/luna-data-grid.css'
import lunaDomViewerCss from 'luna-dom-viewer/luna-dom-viewer.css'
import lunaObjectViewerCss from 'luna-object-viewer/luna-object-viewer.css'

export type ManagerPluginStatus =
  | 'active' | 'blocked' | 'permission-blocked' | 'configured-disabled' | 'failed'
  | 'installing' | 'updating' | 'enabling' | 'disabling' | 'reloading' | 'uninstalling' | 'rolling-back' | 'rollback-failed'

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
  readonly capability: CordisXPermissionCapabilityV4
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
  updatePluginConfig?(id: string, expectedRevision: number, operations: readonly ConfigMutationOperation[]): Promise<void>
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
    capability: CordisXPermissionCapabilityV4,
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
    target: { readonly kind: 'candidate'; readonly candidateId: string } | { readonly kind: 'enable'; readonly pluginId: string },
  ): Promise<CordisXPermissionAuthorizationPlanV2 | undefined>
  applyPermissionLifecycleReviewV2?(
    decision: CordisXPermissionAuthorizationDecisionV2,
  ): Promise<CordisXPluginLifecycleResultV1>
  permissionLifecycleReviewPlanV4?(
    target: { readonly kind: 'candidate'; readonly candidateId: string } | { readonly kind: 'enable'; readonly pluginId: string },
  ): Promise<CordisXPermissionAuthorizationPlanV4 | undefined>
  applyPermissionLifecycleReviewV4?(
    decision: CordisXPermissionAuthorizationDecisionV4,
  ): Promise<CordisXPluginLifecycleResultV1>
  requestPluginLifecycle?(operation: CordisXPluginLifecycleOperationV1): Promise<CordisXPluginLifecycleResultV1>
  requestPluginBundleLifecycle?(operation: CordisXPluginBundleLifecycleOperationV1): Promise<CordisXPluginBundleLifecycleResultV1>
  setExtensionPointPolicy?(source: string, pluginId: string, pointId: string, policy: 'inherit' | 'allow' | 'deny'): Promise<void>
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
  setExtensionPointControlGroupChoice?(expectedPolicyRevision: number, choice: ControlledSurfaceGroupChoice): Promise<void>
  /** Host-private exact selection; plugin-facing runtime snapshots cannot invoke it. */
  selectIconTheme?(expectedProfileRevision: number, candidate: Pick<RedactedIconThemeProvider, 'providerId' | 'namespace' | 'providerVersion' | 'providerGeneration'>): Promise<void>
  /** Whether the launcher can durably CAS this profile's selection. */
  readonly iconThemePreferenceWritable?: boolean
  mountSettingsTab?(id: string, panelBody: HTMLElement): Promise<ManagedSettingsPageMount>
  closeSettingsTabContent?(): Promise<void>
  managerContentPresentation?(id: string, reference: CordisXRouteReference): ManagerContentPresentation | undefined
  mountManagerContent?(
    id: string,
    reference: CordisXRouteReference,
    container: HTMLElement,
    navigation: { readonly navigate: (reference: CordisXRouteReference) => Promise<void>; readonly back: () => Promise<void> },
  ): Promise<ManagedManagerPageMount>
  closeManagerContent?(): Promise<void>
  subscribe(listener: () => void): () => void
}

type ManagerTab = 'about' | 'extension-points' | 'routes' | 'plugins' | 'marketplace' | 'settings'
type PluginDetailTab = 'readme' | 'config' | 'permissions' | 'runtime' | 'logs' | 'extension-points' | 'routes'
type ExtensionPointDetailTab = 'usage' | 'information' | 'diagnostics'
type MarketplaceDetailTab = 'overview' | 'authors-source'
type MarketplaceSourcePage = 'index' | 'create' | 'edit'
type LocalTabIcon = ManagerIconToken
type ManagerRouteState =
  | { readonly kind: 'primary'; readonly primary: ManagerTab }
  | { readonly kind: 'plugin'; readonly pluginId: string; readonly facet: PluginDetailTab }
  | { readonly kind: 'permission'; readonly pluginId: string; readonly capability: CordisXPermissionCapabilityV4; readonly fingerprint: string }
  | { readonly kind: 'marketplace'; readonly identity: string; readonly facet: MarketplaceDetailTab }
  | { readonly kind: 'marketplace-source'; readonly page: MarketplaceSourcePage; readonly url?: string }
  | { readonly kind: 'extension-point'; readonly pointId: string; readonly facet: ExtensionPointDetailTab }
  | { readonly kind: 'route'; readonly qualifiedId: string }
  | { readonly kind: 'page'; readonly qualifiedId: string }
  /** Legacy route state is normalized to Plugins; no global Settings page is mounted. */
  | { readonly kind: 'settings'; readonly tabId: string }
  | { readonly kind: 'manager-content'; readonly id: string; readonly reference: CordisXRouteReference }

interface ManagerBreadcrumbSegment {
  readonly id: string
  readonly label: string
  readonly target?: ManagerRouteState
}

interface ManagerPageRoute {
  readonly id: string
  readonly primary: string
  readonly segments: readonly ManagerBreadcrumbSegment[]
}

interface BreadcrumbProjection {
  readonly visible: readonly number[]
  readonly overflow: readonly number[]
}

const MANAGER_STYLE_ID = 'cordisx-manager-style'
const MANAGER_SETTINGS_FALLBACK = 'host:marketplace'
type LocalizedTab<T extends string> = {
  readonly id: T
  readonly copyKey: Parameters<typeof managerCopy>[1]
  readonly icon: LocalTabIcon
}
const PLUGIN_DETAIL_TABS: readonly LocalizedTab<PluginDetailTab>[] = [
  { id: 'readme', copyKey: 'plugin-tab.readme', icon: 'document' },
  { id: 'config', copyKey: 'plugin-tab.configuration', icon: 'configuration' },
  { id: 'permissions', copyKey: 'plugin-tab.permissions', icon: 'permissions' },
  { id: 'runtime', copyKey: 'plugin-tab.runtime', icon: 'runtime' },
  { id: 'logs', copyKey: 'plugin-tab.logs', icon: 'diagnostics' },
  { id: 'extension-points', copyKey: 'plugin-tab.extension-points', icon: 'outlets' },
  { id: 'routes', copyKey: 'plugin-tab.routes', icon: 'routes' },
]
const EXTENSION_POINT_DETAIL_TABS: readonly LocalizedTab<ExtensionPointDetailTab>[] = [
  { id: 'usage', copyKey: 'extension-tab.usage', icon: 'plugins' },
  { id: 'information', copyKey: 'extension-tab.information', icon: 'point-info' },
  { id: 'diagnostics', copyKey: 'extension-tab.diagnostics', icon: 'diagnostics' },
]
const MARKETPLACE_DETAIL_TABS: readonly LocalizedTab<MarketplaceDetailTab>[] = [
  { id: 'overview', copyKey: 'marketplace-tab.overview', icon: 'overview' },
  { id: 'authors-source', copyKey: 'marketplace-tab.authors-source', icon: 'authors-source' },
]
/** Compatibility export only. This Manager has no global Settings product page. */
export const CORDISX_BUILTIN_MANAGER_SETTINGS_TABS: readonly ManagerSettingsTabSnapshot[] = Object.freeze([])
const CORDISX_MARK_DARK_URI = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cordisxMarkDark)}`
const CORDISX_MARK_LIGHT_URI = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cordisxMarkLight)}`
const ABOUT_ACTIONS = [
  {
    label: '反馈问题',
    description: '报告缺陷、提交改进建议或补充可复现信息。',
    href: 'https://github.com/cordisx/cordisx/issues/new',
  },
  {
    label: '参与建设',
    description: '查看源码、开发约定和当前可参与的项目。',
    href: 'https://github.com/cordisx/cordisx',
  },
  {
    label: '查看文档',
    description: '了解 CordisX 的使用方式、插件协议与开发指南。',
    href: 'https://cordisx.github.io/docs/',
  },
  {
    label: '项目主页',
    description: '访问 CordisX 组织主页与公开项目入口。',
    href: 'https://cordisx.github.io/',
  },
] as const

const PRODUCT_DOCUMENTATION = Object.freeze({
  marketplace: 'https://github.com/cordisx/cordisx/blob/main/.agents/docs/dynamic-plugin-lifecycle.md',
  runtime: 'https://github.com/cordisx/cordisx/blob/main/.agents/docs/dynamic-plugin-lifecycle.md',
  launcher: 'https://github.com/cordisx/cordisx/blob/main/.agents/docs/distribution-and-cli.md',
  permissions: 'https://github.com/cordisx/cordisx/blob/main/.agents/docs/platform-capabilities.md',
})

interface CapabilityPresentation {
  readonly name: string
  readonly icon: ManagerIconToken
}

const CAPABILITY_PRESENTATIONS: Readonly<Partial<Record<CordisXPlatformCapability, CapabilityPresentation>>> = {
  'models.read': {
    name: '读取可用模型',
    icon: 'models-read',
  },
  'tasks.catalog.read': {
    name: '查看任务列表',
    icon: 'tasks-catalog-read',
  },
  'tasks.content.read': {
    name: '查看任务内容',
    icon: 'tasks-content-read',
  },
  'tasks.create': {
    name: '创建任务',
    icon: 'tasks-create',
  },
  'tasks.control': {
    name: '管理任务',
    icon: 'tasks-control',
  },
  'turns.submit': {
    name: '提交消息',
    icon: 'turns-submit',
  },
  'turns.control': {
    name: '控制对话轮次',
    icon: 'turns-control',
  },
  'agent.events.read': {
    name: '读取 Agent 事件',
    icon: 'capability-fallback',
  },
  'agent.history.read': {
    name: '读取 Agent 历史',
    icon: 'capability-fallback',
  },
  'agent.messages.append': {
    name: '追加 Agent 消息',
    icon: 'capability-fallback',
  },
  'agent.steps.reject': {
    name: '拒绝 Agent 步骤',
    icon: 'capability-fallback',
  },
  'agent.messages.transform': {
    name: '转换 Agent 消息',
    icon: 'capability-fallback',
  },
  'agent.prompt.section': {
    name: '扩展系统提示词',
    icon: 'capability-fallback',
  },
  'agent.prompt.context': {
    name: '追加模型上下文',
    icon: 'capability-fallback',
  },
}

const POLICY_LABELS: Readonly<Record<CordisXPermissionPolicy, string>> = {
  ask: '每次询问',
  allow: '始终允许',
  deny: '始终拒绝',
}

const MANAGER_STYLES = `
  ${HOST_FORM_STYLES}
  ${HOST_COLLECTION_STYLES}
  [data-cordisx-manager-trigger] {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    margin-left: 2px;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    opacity: .72;
  }
  [data-cordisx-manager-trigger]:hover,
  [data-cordisx-manager-trigger][aria-expanded="true"] {
    background: color-mix(in srgb, currentColor 9%, transparent);
    opacity: 1;
  }
  [data-cordisx-manager-trigger]:focus-visible {
    outline: 2px solid #c7ccd4;
    outline-offset: 1px;
  }
  .cxm-brand-mark {
    display: block;
    width: 18px;
    height: 18px;
    flex: none;
    pointer-events: none;
  }
  [data-cordisx-manager-trigger] .cxm-brand-mark {
    width: 20px;
    height: 20px;
  }
  .cxm-brand-mark,
  .cxm-host-icon,
  .cxm-host-icon svg,
  .cordisx-host-icon,
  .cordisx-host-icon svg,
  .cxm-plugin-icon,
  .cxm-status-dot,
  .cxm-dot {
    -webkit-user-select: none;
    user-select: none;
    -webkit-user-drag: none;
  }
  .cxm-host-icon {
    display: inline-grid;
    place-items: center;
    flex: none;
    line-height: 0;
    pointer-events: none;
  }
  .cordisx-host-icon { flex: none; line-height: 0; pointer-events: none; }
  .cxm-host-icon svg {
    display: block;
    width: 100%;
    height: 100%;
    color: currentColor;
    pointer-events: none;
  }
  .cordisx-host-icon svg { color: currentColor; pointer-events: none; }
  .cxm-brand-mark[data-brand-rendering^="direct-"] { object-fit: contain; }
  [data-cordisx-manager-modal] {
    position: fixed;
    inset: 0;
    z-index: 2147483600;
    color: #e7e9ee;
    font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  }
  [data-cordisx-manager-modal][hidden] { display: none; }
  .cxm-backdrop {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    padding: 20px;
    box-sizing: border-box;
    background: rgba(5, 7, 12, .66);
    backdrop-filter: blur(8px);
  }
  .cxm-dialog {
    --cx-compact-list-icon-seat: 22px;
    --cx-compact-list-icon-glyph: 16px;
    display: grid;
    grid-template-columns: 248px minmax(0, 1fr);
    width: min(1440px, calc(100vw - 40px));
    height: min(960px, calc(100vh - 40px));
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, .12);
    border-radius: 18px;
    background: #12151d;
    box-shadow: 0 32px 120px rgba(0, 0, 0, .55);
  }
  .cxm-sidebar {
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding: 18px 12px 14px;
    border-right: 1px solid rgba(255, 255, 255, .08);
    background: linear-gradient(180deg, #191c26, #141720);
  }
  .cxm-nav { display: flex; min-height: 0; flex: 1; flex-direction: column; gap: 4px; overflow-x: hidden; overflow-y: auto; scrollbar-gutter: stable; }
  .cxm-nav-button {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 9px 10px;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: #aeb5c3;
    cursor: pointer;
    text-align: left;
    font: inherit;
  }
  .cxm-nav-button:hover { background: rgba(255, 255, 255, .05); color: #fff; }
  .cxm-nav-button[aria-current="page"] { background: rgba(199, 204, 212, .14); color: #eef0f3; }
  .cxm-nav-button:disabled { cursor: default; opacity: .48; }
  .cxm-nav-button[data-tab="about"] { margin-top: auto; }
  .cxm-nav-icon { width: 20px; height: 20px; color: #b8bec8; }
  .cxm-nav-icon.cordisx-host-icon { display: inline-grid; place-items: center; }
  .cxm-nav-icon svg { width: 18px; height: 18px; }
  .cxm-nav-button:focus-visible,
  .cxm-close:focus-visible,
  .cxm-tab:focus-visible,
  .cxm-action:focus-visible,
  .cxm-mini-action:focus-visible {
    outline: 2px solid #c7ccd4;
    outline-offset: 2px;
  }
  .cxm-main { display: flex; min-width: 0; min-height: 0; flex-direction: column; overflow: hidden; }
  .cxm-header {
    --cx-manager-header-leading-seat: 26px;
    --cx-manager-header-leading-glyph: 18px;
    --cx-manager-header-title-size: 16px;
    --cx-manager-header-title-line-height: 26px;
    --cx-manager-icon-control-size: 30px;
    --cx-manager-icon-control-glyph: 18px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 72px;
    flex: 0 0 auto;
    padding: 0 22px;
    border-bottom: 1px solid rgba(255, 255, 255, .08);
  }
  .cxm-heading { position: relative; display: grid; grid-template-columns: var(--cx-manager-header-leading-seat) minmax(0, 1fr); align-items: start; column-gap: 9px; min-width: 0; flex: 1 1 auto; }
  .cxm-heading[data-heading-actions="true"] { padding-right: 36px; }
  .cxm-heading-menu { position: absolute; z-index: 8; top: -2px; right: 0; }
  .cxm-heading-menu > .cxm-manager-icon-action { color: var(--cx-muted); }
  .cxm-heading-menu-popup { position: absolute; z-index: 9; top: 34px; right: 0; min-width: 172px; box-sizing: border-box; padding: 4px; border: 1px solid var(--cx-border); border-radius: 10px; background: var(--cx-surface-raised); box-shadow: 0 14px 32px rgba(0, 0, 0, .2); }
  .cxm-heading-menu-popup[hidden] { display: none; }
  .cxm-heading-menu-item { display: flex; width: 100%; align-items: center; gap: 8px; box-sizing: border-box; padding: 8px 9px; border: 0; border-radius: 7px; background: transparent; color: var(--cx-text); cursor: pointer; font: inherit; text-align: left; }
  .cxm-heading-menu-item:hover { background: var(--cx-hover); }
  .cxm-heading-menu-item:focus-visible { outline: 2px solid var(--cx-focus); outline-offset: 1px; }
  .cxm-heading-menu-item .cxm-host-icon { width: 16px; height: 16px; }
  .cxm-heading-row { display: contents; }
  .cxm-heading-title { display: flex; grid-column: 2; align-items: center; min-width: 0; min-height: var(--cx-manager-header-leading-seat); color: #fff; font-size: var(--cx-manager-header-title-size); font-weight: 700; line-height: var(--cx-manager-header-title-line-height); }
  .cxm-heading-current-heading { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  .cxm-heading p { grid-column: 1 / -1; margin: 3px 0 0; color: #7f899a; font-size: 11px; }
  .cxm-heading-direct-title { grid-column: 2; min-width: 0; min-height: var(--cx-manager-header-leading-seat); margin: 0; color: #fff; font-size: var(--cx-manager-header-title-size); font-weight: 700; line-height: var(--cx-manager-header-title-line-height); }
  .cxm-heading-leading {
    display: grid;
    place-items: center;
    width: var(--cx-manager-header-leading-seat);
    height: var(--cx-manager-header-leading-seat);
    flex: none;
    box-sizing: border-box;
    border: 0;
    background: transparent;
    color: #d8dce3;
    align-self: start;
  }
  .cxm-heading-icon svg { width: var(--cx-manager-header-leading-glyph); height: var(--cx-manager-header-leading-glyph); transform: translateY(-.5px); }
  .cxm-back {
    padding: 0;
    cursor: pointer;
  }
  .cxm-back { border-radius: 7px; }
  .cxm-back-icon { width: var(--cx-manager-header-leading-glyph); height: var(--cx-manager-header-leading-glyph); }
  .cxm-back-icon svg { transform: translateY(-.5px); }
  .cxm-back:hover { background: rgba(199, 204, 212, .14); color: #eef0f3; }
  .cxm-back:focus-visible { outline: 2px solid #c7ccd4; outline-offset: 2px; }
  .cxm-breadcrumbs { min-width: 0; width: 100%; }
  .cxm-breadcrumb-list { display: flex; min-width: 0; min-height: var(--cx-manager-header-leading-seat); margin: 0; padding: 0; align-items: center; list-style: none; line-height: var(--cx-manager-header-title-line-height); white-space: nowrap; }
  .cxm-breadcrumb-item { display: inline-flex; min-width: 0; min-height: var(--cx-manager-header-leading-seat); flex: 0 0 auto; align-items: center; }
  .cxm-breadcrumb-item:last-child { flex: 1 1 auto; }
  .cxm-breadcrumb-separator { padding: 0 6px; color: #656e7e; font-weight: 400; }
  .cxm-breadcrumb-action {
    min-width: 0;
    padding: 2px 3px;
    overflow: hidden;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: #a9b1c0;
    cursor: pointer;
    font: inherit;
    font-weight: 500;
    line-height: calc(var(--cx-manager-header-title-line-height) - 4px);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cxm-breadcrumb-action:hover { background: rgba(199, 204, 212, .1); color: #eef0f3; }
  .cxm-breadcrumb-action:focus-visible { outline: 2px solid #c7ccd4; outline-offset: 1px; }
  .cxm-breadcrumb-current { min-width: 0; overflow: hidden; color: #fff; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-breadcrumb-overflow { position: relative; }
  .cxm-breadcrumb-overflow > summary {
    display: grid;
    width: 28px;
    height: 24px;
    place-items: center;
    border-radius: 5px;
    color: #a9b1c0;
    cursor: pointer;
    list-style: none;
  }
  .cxm-breadcrumb-overflow > summary::-webkit-details-marker { display: none; }
  .cxm-breadcrumb-overflow > summary:hover { background: rgba(199, 204, 212, .1); color: #eef0f3; }
  .cxm-breadcrumb-overflow > summary:focus-visible { outline: 2px solid #c7ccd4; outline-offset: 1px; }
  .cxm-breadcrumb-menu {
    position: absolute;
    z-index: 2;
    top: calc(100% + 6px);
    left: 0;
    display: grid;
    min-width: 180px;
    max-width: min(360px, calc(100vw - 80px));
    padding: 6px;
    border: 1px solid rgba(255, 255, 255, .12);
    border-radius: 9px;
    background: #1a1e28;
    box-shadow: 0 12px 32px rgba(0, 0, 0, .42);
  }
  .cxm-breadcrumb-menu .cxm-breadcrumb-action { width: 100%; padding: 7px 9px; text-align: left; }
  .cxm-close {
    display: grid;
    place-items: center;
    width: var(--cx-manager-icon-control-size);
    height: var(--cx-manager-icon-control-size);
    flex: none;
    box-sizing: border-box;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: #d8dce5;
    cursor: pointer;
  }
  .cxm-close-icon { display: block; width: var(--cx-manager-icon-control-glyph); height: var(--cx-manager-icon-control-glyph); }
  .cxm-close:hover { background: rgba(199, 204, 212, .14); color: #eef0f3; }
  .cxm-content {
    --cx-manager-content-block-start: 20px;
    --cx-manager-content-inline: 22px;
    --cx-manager-content-block-end: 24px;
    min-height: 0;
    flex: 1 1 0%;
    overflow-x: hidden;
    overflow-y: auto;
    padding: var(--cx-manager-content-block-start) var(--cx-manager-content-inline) var(--cx-manager-content-block-end);
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }
  /* A sidebar-owned manager.content page is a plugin-owned content seat. The
     shared scroll viewport must not add an outer Host inset around it. */
  .cxm-content[data-manager-content-page="true"] { padding: 0; }
  .cxm-content[data-marketplace-discovery="true"] { overflow: hidden; }
  .cxm-content[data-manager-list-page="true"] { display: flex; overflow: hidden; }
  .cxm-content[data-manager-list-page="true"] > .cxm-fixed-list-collection { display: flex; min-width: 0; min-height: 0; flex: 1 1 auto; flex-direction: column; }
  .cxm-content[data-manager-list-page="true"] > .cxm-fixed-list-collection .cxc-list { min-height: 0; flex: 1 1 auto; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
  .cxm-marketplace-discovery { display: flex; min-width: 0; min-height: 0; height: 100%; flex-direction: column; }
  .cxm-marketplace-discovery-tools { flex: 0 0 auto; }
  .cxm-marketplace-filter-row { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 9px; }
  .cxm-marketplace-results { min-width: 0; min-height: 0; flex: 1 1 auto; margin: 12px -8px -24px; padding: 0 8px 24px; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
  .cxm-marketplace-source-page { min-width: 0; }
  .cxm-marketplace-source-page .cxf-form { inline-size: 100%; max-inline-size: none; margin-inline: 0; }
  .cxm-marketplace-source-page .cxf-form-grid { inline-size: 100%; }
  .cxm-marketplace-source-toolbar { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-bottom: 12px; }
  .cxm-marketplace-source-readonly { overflow-wrap: anywhere; color: var(--cx-muted); font: 11px/1.5 ui-monospace, monospace; user-select: text; }
  .cxm-tabs {
    display: flex;
    width: 100%;
    min-width: 0;
    flex-wrap: wrap;
    gap: 5px;
    margin: -4px -8px 16px;
    padding: 0;
    overflow: visible;
  }
  .cxm-tab {
    display: inline-flex;
    align-items: center;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
    flex: none;
    padding: 7px 9px;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: #858fa1;
    cursor: pointer;
    font: 11px/1.2 system-ui, sans-serif;
  }
  .cxm-tab-content { display: inline-grid; min-width: 0; max-width: 100%; grid-template-columns: 18px minmax(0, 1fr); align-items: center; gap: 7px; }
  .cxm-tab-content > span:last-child { min-width: 0; overflow-wrap: anywhere; }
  .cxm-tab-icon { display: inline-flex; width: 18px; height: 18px; align-items: center; justify-content: center; color: currentColor; }
  .cxm-tab-icon svg { width: 17px; height: 17px; transform: translateY(-.5px); }
  .cxm-tab:hover { background: rgba(199, 204, 212, .08); color: #eef0f3; }
  .cxm-tab[aria-selected="true"] { background: rgba(199, 204, 212, .14); color: #eef0f3; }
  .cxm-settings-root { display: flex; min-width: 0; min-height: 100%; flex-direction: column; }
  .cxm-settings-root > .cxm-tabs { flex: 0 0 auto; }
  .cxm-settings-panel { min-width: 0; min-height: 0; flex: 1 1 auto; outline: none; }
  .cxm-settings-panel-body { min-width: 0; min-height: 100%; overflow: visible; }
  .cxm-settings-panel[aria-busy="true"] .cxm-settings-panel-body { opacity: .78; }
  .cxm-settings-tab-icon.cordisx-host-icon { display: inline-flex; width: 18px; height: 18px; align-items: center; justify-content: center; }
  .cxm-settings-tab-icon.cordisx-host-icon svg { width: 17px; height: 17px; }
  .cxm-manager-content-root { min-width: 0; max-width: 100%; }
  .cxm-content[data-manager-content-page="true"] > .cxm-manager-content-root { padding: 0; }
  .cxm-content[data-manager-content-page="true"] > .cxm-tabs { margin: 16px calc(var(--cx-manager-content-inline) - 8px) 16px; }
  .cxm-tab:disabled { cursor: default; opacity: .42; }
  .cxm-about-identity { display: flex; align-items: center; gap: 18px; padding: 4px 2px 22px; }
  .cxm-about-identity-copy { min-width: 0; white-space: nowrap; }
  .cxm-about-mark.cxm-brand-mark { width: 54px; height: 54px; }
  .cxm-about-name { color: #f5f6f8; font-size: 22px; font-weight: 720; letter-spacing: -.02em; }
  .cxm-about-version { margin-top: 3px; color: #8d96a8; font: 11px/1.4 ui-monospace, monospace; }
  .cxm-about-actions { overflow: hidden; border: 1px solid rgba(255, 255, 255, .08); border-radius: 12px; background: rgba(255, 255, 255, .025); }
  .cxm-about-action { display: flex; width: 100%; min-width: 0; box-sizing: border-box; align-items: center; gap: 16px; padding: 14px 12px; border-radius: 9px; background: transparent; color: inherit; text-decoration: none; }
  .cxm-about-action-item + .cxm-about-action-item { border-top: 1px solid rgba(255, 255, 255, .08); }
  .cxm-about-action:hover, .cxm-about-action:focus-visible { background: rgba(199, 204, 212, .08); color: #fff; }
  .cxm-about-action:focus-visible { outline: 2px solid #c7ccd4; outline-offset: -2px; }
  .cxm-about-action-body { min-width: 0; overflow: hidden; flex: 1; }
  .cxm-about-action-title { display: block; overflow: hidden; background: transparent; color: #d8dce3; font-size: 12px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-about-action-copy { display: -webkit-box; margin-top: 3px; overflow: hidden; background: transparent; color: #838d9f; font-size: 11px; line-height: 1.42; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .cxm-about-action-arrow { width: 16px; height: 16px; flex: none; color: #747e8e; transition: color .12s ease; }
  .cxm-about-action:hover .cxm-about-action-title, .cxm-about-action:focus-visible .cxm-about-action-title { color: currentColor; }
  .cxm-about-action:hover .cxm-about-action-arrow, .cxm-about-action:focus-visible .cxm-about-action-arrow { color: currentColor; }
  .cxm-card-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .cxm-card, .cxm-slot-card, .cxm-source-row {
    border: 1px solid rgba(255, 255, 255, .09);
    border-radius: 12px;
    background: rgba(255, 255, 255, .035);
  }
  .cxm-card { padding: 15px; }
  .cxm-card-label { color: #7f899a; font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
  .cxm-card-value { margin-top: 6px; color: #fff; font-size: 20px; font-weight: 700; }
  .cxm-section-title { margin: 22px 0 8px; color: #f2f4f8; font-size: 13px; font-weight: 700; }
  .cxm-tab-panel { min-width: 0; }
  .cxm-content:has(.cxm-console-panel) { display: flex; flex-direction: column; overflow: hidden; }
  .cxm-console-panel { display: flex; min-width: 0; min-height: 0; flex: 1 1 auto; flex-direction: column; }
  .cxm-tab-panel:has(.cxf-form), .cxm-permission-detail { inline-size: 100%; max-inline-size: none; margin-inline: 0; }
  .cxm-tab-panel > .cxm-section-title:first-child { margin-top: 0; }
  /* The Markdown surface uses the available detail width; prose itself keeps
     a GitHub-like reading measure while code, tables, and headings can span it. */
  .cxm-readme { inline-size: 100%; max-inline-size: 96rem; color: var(--cx-text); font-size: 12px; line-height: 1.62; overflow-wrap: anywhere; }
  .cxm-readme p, .cxm-readme li, .cxm-readme blockquote { max-inline-size: 76ch; }
  .cxm-readme > :first-child { margin-top: 0; }
  .cxm-readme > :last-child { margin-bottom: 0; }
  .cxm-readme h1, .cxm-readme h2, .cxm-readme h3, .cxm-readme h4, .cxm-readme h5, .cxm-readme h6 { margin: 1.4em 0 .55em; color: var(--cx-text); line-height: 1.28; }
  .cxm-readme h1 { padding-bottom: .35em; border-bottom: 1px solid var(--cx-border); font-size: 1.55em; }
  .cxm-readme h2 { padding-bottom: .28em; border-bottom: 1px solid var(--cx-border); font-size: 1.28em; }
  .cxm-readme h3 { font-size: 1.12em; }
  .cxm-readme p, .cxm-readme ul, .cxm-readme ol, .cxm-readme blockquote, .cxm-readme pre, .cxm-readme table { margin: .7em 0; }
  .cxm-readme ul, .cxm-readme ol { padding-left: 1.55em; }
  .cxm-readme li + li { margin-top: .22em; }
  .cxm-readme .task-list-item { display: flex; align-items: baseline; gap: .45em; list-style: none; margin-left: -1.3em; }
  .cxm-readme .task-list-item input { accent-color: var(--cx-primary); }
  .cxm-readme a { color: var(--cx-primary); text-underline-offset: 2px; }
  .cxm-readme code { padding: .12em .28em; border-radius: 4px; background: var(--cx-hover); font: .92em ui-monospace, SFMono-Regular, Menlo, monospace; }
  .cxm-readme pre { overflow: auto; padding: 10px 12px; border: 1px solid var(--cx-border); border-radius: 8px; background: color-mix(in srgb, var(--cx-surface-raised) 86%, #000); }
  .cxm-readme pre code { padding: 0; background: transparent; }
  .cxm-readme blockquote { padding: .1em 1em; border-left: 3px solid var(--cx-border); color: var(--cx-muted); }
  .cxm-readme blockquote p { margin: .55em 0; }
  .cxm-readme hr { height: 1px; margin: 1.35em 0; border: 0; background: var(--cx-border); }
  .cxm-readme table { display: block; max-width: 100%; overflow: auto; border-spacing: 0; border-collapse: collapse; }
  .cxm-readme th, .cxm-readme td { padding: .45em .65em; border: 1px solid var(--cx-border); text-align: left; }
  .cxm-readme th { background: var(--cx-hover); font-weight: 650; }
  .cxm-flat-list {
    margin-top: 8px;
    border-top: 1px solid rgba(255, 255, 255, .08);
    border-bottom: 1px solid rgba(255, 255, 255, .08);
  }
  .cxm-settings-group { overflow: clip; border: 1px solid var(--cx-border); border-radius: .8rem; background: color-mix(in srgb, var(--cx-surface-raised) 86%, var(--cx-surface)); box-shadow: 0 1px 2px color-mix(in srgb, var(--cx-shadow) 18%, transparent); }
  .cxm-plugin-service-config .cxm-service-config-footer {
    position: static;
    z-index: auto;
    min-block-size: 2.75rem;
    padding: .25rem 0 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    backdrop-filter: none;
  }
  .cxm-settings-group.cxm-flat-list { border-top-color: var(--cx-border); border-bottom-color: var(--cx-border); }
  .cxm-settings-group .cxm-flat-item { padding: .9rem 1rem; }
  .cxm-flat-item { padding: 14px 2px; }
  .cxm-flat-item + .cxm-flat-item { border-top: 1px solid rgba(255, 255, 255, .08); }
  .cxm-permission-item { display: grid; grid-template-columns: minmax(0, 1fr) max-content; align-items: center; gap: 18px; }
  .cxm-permission-open {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr);
    align-items: center;
    gap: 11px;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
  }
  .cxm-permission-open:hover .cxm-permission-name { color: #fff; }
  .cxm-permission-open:focus-visible { outline: 2px solid #c7ccd4; outline-offset: 4px; border-radius: 5px; }
  .cxm-capability-icon { width: 24px; height: 24px; color: #bfc5ce; }
  .cxm-capability-icon svg { width: 20px; height: 20px; }
  .cxm-permission-copy { min-width: 0; }
  .cxm-permission-title { display: flex; align-items: center; gap: 7px; }
  .cxm-permission-name { color: #e7e9ee; font-size: 12px; font-weight: 650; }
  .cxm-required-badge { padding: 2px 5px; border-radius: 5px; background: rgba(251, 191, 36, .1); color: #d6c37e; font-size: 9px; font-weight: 700; }
  .cxm-permission-reason { display: block; margin-top: 3px; overflow: hidden; color: #858fa1; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-permission-control { display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-width: 118px; }
  .cxm-permission-policy-select { inline-size: min(100%, 12rem); min-inline-size: 0; }
  .cxm-permission-detail-intro { display: grid; grid-template-columns: 34px minmax(0, 1fr); align-items: center; gap: 12px; }
  .cxm-permission-detail-intro .cxm-capability-icon { width: 34px; height: 34px; }
  .cxm-permission-detail-intro .cxm-capability-icon svg { width: 26px; height: 26px; }
  .cxm-permission-detail { display: grid; gap: 1.35rem; padding-block: .25rem 1rem; }
  .cxm-permission-detail-policy { inline-size: min(100%, 16rem); }
  .cxm-settings-info-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(11rem, 42%); align-items: center; gap: 1rem; padding: .9rem 1rem; }
  .cxm-settings-info-row + .cxm-settings-info-row { border-top: 1px solid var(--cx-border); }
  .cxm-settings-info-label { color: var(--cx-text); font-size: .82rem; font-weight: 600; }
  .cxm-settings-info-value { min-width: 0; color: var(--cx-muted); font: .78rem/1.4 ui-monospace, monospace; overflow-wrap: anywhere; text-align: end; }
  .cxm-permission-provider-item { display: grid; grid-template-columns: minmax(0, 1fr) max-content; align-items: center; gap: 8px 16px; }
  .cxm-permission-provider-item > .cxm-code { grid-column: 1 / -1; margin: 0; }
  .cxm-permission-audit { margin-top: 16px; }
  .cxm-diagnostics { margin-top: 22px; border-top: 1px solid rgba(255, 255, 255, .08); }
  .cxm-diagnostics summary { padding: 14px 2px; color: #98a1b2; cursor: pointer; font-size: 11px; }
  .cxm-diagnostics[open] summary { color: #d8dce3; }
  .cxm-diagnostics-body { padding: 0 2px 4px; }
  .cxm-runtime-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .cxm-runtime-console-summary { display: flex; min-width: 0; align-items: stretch; gap: 1px; overflow: hidden; border: 1px solid rgba(255,255,255,.08); border-radius: 8px; background: rgba(255,255,255,.08); }
  .cxm-runtime-overview { display: grid; gap: 10px; inline-size: 100%; max-inline-size: none; }
  .cxm-runtime-status { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--cx-border); border-radius: 12px; background: var(--cx-surface-raised); }
  .cxm-runtime-status-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 9px; background: var(--cx-hover); color: var(--cx-primary); }
  .cxm-runtime-status-icon .cxm-host-icon { width: 19px; height: 19px; }
  .cxm-runtime-status-copy { min-width: 0; }
  .cxm-runtime-status-label { display: block; color: var(--cx-text); font-size: 13px; font-weight: 680; }
  .cxm-runtime-status-meta { display: block; margin-top: 3px; overflow: hidden; color: var(--cx-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-runtime-status-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .cxm-runtime-status-fact { display: grid; gap: 2px; min-width: 0; padding: 9px 10px; border: 1px solid var(--cx-border); border-radius: 9px; background: var(--cx-surface-raised); color: var(--cx-muted); font-size: 10px; }
  .cxm-runtime-status-fact strong { overflow: hidden; color: var(--cx-text); font-size: 15px; line-height: 1.15; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-runtime-status-fact span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-runtime-diagnostics { overflow: hidden; border: 1px solid var(--cx-border); border-radius: 10px; background: var(--cx-surface-raised); }
  .cxm-runtime-diagnostics > summary { padding: 10px 12px; color: var(--cx-text); cursor: pointer; font-size: 11px; font-weight: 650; }
  .cxm-runtime-diagnostics > summary::marker { color: var(--cx-muted); }
  .cxm-runtime-diagnostic-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 170px), 1fr)); gap: 1px; border-top: 1px solid var(--cx-border); background: var(--cx-border); }
  .cxm-runtime-diagnostic { display: grid; min-width: 0; gap: 3px; padding: 10px 12px; background: var(--cx-surface-raised); }
  .cxm-runtime-diagnostic-label { color: var(--cx-muted); font-size: 10px; }
  .cxm-runtime-diagnostic-value { overflow-wrap: anywhere; color: var(--cx-text); font-size: 11px; line-height: 1.4; }
  .cxm-runtime-console-metric { min-width: 72px; padding: 7px 10px; background: #191b1f; }
  .cxm-runtime-console-metric strong { display: inline; color: #eceef2; font: 600 13px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .cxm-runtime-console-metric span { margin-left: 6px; color: #818a99; font-size: 9px; text-transform: uppercase; letter-spacing: .05em; }
  .cxm-runtime-console-performance { flex: 1; min-width: 0; background: #191b1f; }
  .cxm-runtime-console-performance summary { padding: 8px 10px; color: #8d96a8; cursor: pointer; font-size: 10px; list-style-position: inside; }
  .cxm-runtime-console-performance-body { padding: 0 10px 8px; color: #aab2c0; font: 10px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .cxm-console-controls { display: grid; grid-template-columns: minmax(150px, 1.35fr) repeat(3, minmax(96px, 1fr)) max-content; gap: 7px; align-items: center; min-width: 0; margin: 8px 0; }
  .cxm-console-controls input { min-width: 0; height: 30px; border: 1px solid #353a42; border-radius: 6px; padding: 0 8px; background: #15171a; color: #d8dce3; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .cxm-console-controls t-select { min-width: 0; width: 100%; box-sizing: border-box; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .cxm-console-action-toolbar { display: flex; flex: none; align-items: center; justify-content: flex-end; gap: 2px; min-width: 0; white-space: nowrap; }
  .cxm-console-warning { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-block: 8px; }
  .cxm-console-warning button { flex: none; border: 0; background: transparent; color: inherit; cursor: pointer; font-size: 11px; }
  .cxm-console-workspace { display: grid; min-width: 0; min-height: 0; flex: 1 1 auto; overflow: hidden; grid-template-columns: minmax(0, 1fr); gap: 8px; align-items: stretch; }
  .cxm-console-workspace[data-inspector="true"] { grid-template-columns: minmax(0, 1fr) minmax(220px, 280px); }
  .cxm-console-body { position: relative; display: flex; min-width: 0; min-height: 0; overflow: hidden; }
  .cxm-console-frame { width: 100%; height: 100%; min-height: 0; flex: 1 1 auto; overflow: auto; box-sizing: border-box; border: 1px solid #30343a; border-radius: 7px; background: #101215; scrollbar-gutter: stable; overscroll-behavior: contain; }
  .cxm-console-frame.cxm-console-luna { min-height: 28px; color: #cad0da; cursor: default; }
  .cxm-console-frame.cxm-console-luna.luna-console { height: 100%; border: 1px solid #30343a; background: #101215; }
  .cxm-console-frame.cxm-console-luna .luna-console-log-content { font-size: 11px; line-height: 16px; }
  .cxm-console-frame.cxm-console-luna .luna-console-header { font-size: 10px; }
  .cxm-console-frame.cxm-console-luna:focus-visible { outline: 2px solid #8e98a9; outline-offset: 2px; }
  .cxm-console-latest { position: absolute; right: 14px; bottom: 12px; z-index: 1; border: 1px solid #4a515c; background: #252a31; color: #e3e7ee; box-shadow: 0 4px 14px rgba(0,0,0,.35); }
  .cxm-console-inspector { min-width: 0; min-height: 0; overflow: auto; border: 1px solid #30343a; border-radius: 7px; background: #141619; }
  .cxm-console-inspector-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-bottom: 1px solid #30343a; color: #cdd2db; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .cxm-console-inspector-head button { border: 0; background: transparent; color: #98a1b2; cursor: pointer; }
  .cxm-console-inspector-grid { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 10px; margin: 0; padding: 10px; font: 10px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .cxm-console-inspector-grid dt { color: #778294; }
  .cxm-console-inspector-grid dd { min-width: 0; margin: 0; overflow-wrap: anywhere; color: #bdc5d2; }
  .cxm-console-empty { display: grid; min-height: 160px; place-items: center; padding: 20px 16px; color: #737d8e; text-align: center; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
  [data-cordisx-manager-modal][data-cordisx-app-theme="light"] .cxm-runtime-console-summary { border-color: rgba(18,24,33,.12); background: rgba(18,24,33,.12); }
  [data-cordisx-manager-modal][data-cordisx-app-theme="light"] .cxm-runtime-console-metric,
  [data-cordisx-manager-modal][data-cordisx-app-theme="light"] .cxm-runtime-console-performance { background: #f4f5f7; }
  [data-cordisx-manager-modal][data-cordisx-app-theme="light"] .cxm-runtime-console-metric strong { color: #1d222b; }
  [data-cordisx-manager-modal][data-cordisx-app-theme="light"] .cxm-console-controls input { border-color: #c7ccd4; background: #fff; color: #20242c; }
  [data-cordisx-manager-modal][data-cordisx-app-theme="light"] .cxm-console-frame.cxm-console-luna.luna-console { border-color: #c7ccd4; background: #fff; color: #252b35; }
  [data-cordisx-manager-modal][data-cordisx-app-theme="light"] .cxm-console-inspector { border-color: #c7ccd4; background: #f8f9fa; }
  [data-cordisx-manager-modal][data-cordisx-app-theme="light"] .cxm-console-inspector-head { border-color: #d7dbe1; color: #252b35; }
  [data-cordisx-manager-modal][data-cordisx-app-theme="light"] .cxm-console-inspector-grid dd { color: #354052; }
  .cxm-copy { margin: 0; color: #98a1b2; font-size: 12px; }
  .cxm-notice {
    margin-top: 14px;
    padding: 12px 14px;
    border: 1px solid rgba(199, 204, 212, .2);
    border-radius: 11px;
    background: rgba(199, 204, 212, .07);
    color: #b8bfd0;
    font-size: 11px;
  }
  .cxm-notice[data-tone="warning"] { border-color: rgba(251, 191, 36, .2); background: rgba(251, 191, 36, .055); color: #c5b889; }
  .cxm-slots { display: grid; gap: 10px; }
  .cxm-slot-card { padding: 13px 14px; }
  .cxm-slot-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .cxm-slot-name { color: #d8dce3; font: 12px/1.3 ui-monospace, monospace; }
  .cxm-contributions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 10px; }
  .cxm-contribution {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border-radius: 8px;
    background: rgba(255, 255, 255, .05);
    color: #c7cdd8;
    font-size: 10px;
  }
  .cxm-dot { width: 7px; height: 7px; box-sizing: border-box; border: 1px solid #86efac; border-radius: 50%; }
  .cxm-dot[data-rendered="true"] { background: #86efac; }
  .cxm-empty { padding: 28px 12px; color: #687284; font-size: 11px; text-align: center; }
  .cxm-toolbar { display: flex; align-items: center; gap: 10px; }
  .cxm-list-search { display: flex; align-items: center; gap: 7px; width: 100%; min-height: 38px; box-sizing: border-box; border: 1px solid rgba(255, 255, 255, .1); border-radius: 9px; background: rgba(255, 255, 255, .045); }
  .cxm-toolbar > .cxm-action { height: 38px; }
  .cxm-toolbar > .cxm-toolbar-icon-action {
    width: 38px;
    height: 38px;
    border: 1px solid rgba(255, 255, 255, .1);
    border-radius: 9px;
    background: rgba(255, 255, 255, .045);
  }
  .cxm-marketplace-filter {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: max-content;
    min-height: 28px;
    box-sizing: border-box;
    padding: 4px 9px;
    border: 1px solid rgba(255, 255, 255, .1);
    border-radius: 999px;
    background: rgba(255, 255, 255, .045);
    color: #aab2c0;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
  }
  .cxm-marketplace-filter:hover { border-color: rgba(199, 204, 212, .38); color: #eef0f4; }
  .cxm-marketplace-filter[aria-pressed="true"] { border-color: rgba(125, 211, 252, .45); background: rgba(125, 211, 252, .12); color: #dff5ff; }
  .cxm-marketplace-filter:focus-visible { outline: 2px solid #c7ccd4; outline-offset: 2px; }
  .cxm-marketplace-filter .cxm-host-icon { width: 17px; height: 17px; }
  .cxm-list-search-icon { width: 18px; height: 18px; margin-left: 10px; color: #8e98a9; }
  .cxm-list-search .cxm-search { min-width: 0; padding-left: 0; border-width: 0; background: transparent; }
  .cxm-list-search:focus-within { border-color: rgba(199, 204, 212, .65); outline: 2px solid #c7ccd4; outline-offset: 2px; }
  .cxm-list-search .cxm-search:focus-visible { outline: 0; }
  .cxm-list-search-clear { width: 28px; height: 28px; margin-right: 3px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: #9fa8b8; cursor: pointer; }
  .cxm-list-search-clear[hidden] { display: none; }
  .cxm-search-match { padding: 0; border-radius: 2px; background: rgba(251, 191, 36, .25); color: inherit; }
  .cxm-search, .cxm-source-input {
    width: 100%;
    box-sizing: border-box;
    padding: 9px 11px;
    border: 1px solid rgba(255, 255, 255, .1);
    border-radius: 9px;
    outline: none;
    background: rgba(255, 255, 255, .045);
    color: #fff;
    font: inherit;
  }
  .cxm-search:focus, .cxm-source-input:focus { border-color: rgba(199, 204, 212, .65); }
  .cxm-search:focus-visible, .cxm-source-input:focus-visible { outline: 2px solid #c7ccd4; outline-offset: 2px; }
  .cxm-plugin-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 8px; margin-top: 12px; }
  .cxm-plugin-row {
    container-type: inline-size;
    display: flex;
    align-items: center;
    width: 100%;
    min-width: 0;
    border: 1px solid rgba(255, 255, 255, .075);
    border-radius: 11px;
    background: rgba(255, 255, 255, .025);
    color: inherit;
  }
  .cxm-plugin-row:hover, .cxm-plugin-row:focus-within { border-color: rgba(199, 204, 212, .3); background: rgba(199, 204, 212, .07); }
  .cxm-plugin-primary { display: flex; align-items: center; gap: 11px; min-width: 0; flex: 1; align-self: stretch; padding: 12px; border: 0; border-radius: 10px; background: transparent; color: inherit; cursor: pointer; text-align: left; font: inherit; }
  .cxm-plugin-primary:focus-visible { outline: 2px solid #c7ccd4; outline-offset: -3px; }
  .cxm-plugin-actions { display: flex; align-items: center; flex: none; gap: 2px; padding: 8px 8px 8px 0; opacity: 0; pointer-events: none; transition: opacity 120ms ease; }
  .cxm-plugin-row:hover .cxm-plugin-actions,
  .cxm-plugin-row:focus-within .cxm-plugin-actions,
  .cxm-plugin-row[data-action-menu-open="true"] .cxm-plugin-actions { opacity: 1; pointer-events: auto; }
  /* One compact, rounded-square geometry for every Host icon action. It is
     deliberately not a circular affordance: native toolbar actions, close,
     overflow, and extension controls belong to the same control family. */
  .cxm-manager-icon-action, .cxm-plugin-icon-action, .cxm-plugin-menu-trigger {
    display: inline-grid; place-items: center; width: 32px; min-width: 32px; height: 32px; min-height: 32px; flex: none;
    box-sizing: border-box; border: 1px solid transparent; border-radius: 8px;
    background: transparent; color: #aeb5c3; cursor: pointer;
  }
  .cxm-manager-icon-action:hover:not(:disabled), .cxm-plugin-icon-action:hover:not(:disabled), .cxm-plugin-menu-trigger:hover { background: var(--cx-hover, rgba(199, 204, 212, .12)); color: var(--cx-text, #eef0f4); }
  .cxm-manager-icon-action:focus-visible, .cxm-plugin-icon-action:focus-visible, .cxm-plugin-menu-trigger:focus-visible { outline: 2px solid var(--cx-focus, #c7ccd4); outline-offset: 1px; }
  .cxm-manager-icon-action:disabled, .cxm-plugin-icon-action:disabled { cursor: default; opacity: var(--cx-disabled, .34); }
  .cxm-manager-icon-action[aria-pressed="true"] { background: var(--cx-pressed, rgba(199, 204, 212, .2)); color: var(--cx-text, #eef0f4); }
  .cxm-manager-icon-action .cxm-host-icon { width: 17px; height: 17px; max-width: 100%; max-height: 100%; }
  .cxm-plugin-icon {
    position: relative;
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    flex: none;
    border: 1px solid rgba(199, 204, 212, .24);
    border-radius: 10px;
    background: rgba(199, 204, 212, .1);
    color: #d8dce3;
    font-size: 10px;
    font-weight: 800;
  }
  .cxm-plugin-icon > img {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: inherit;
    object-fit: contain;
  }
  .cxc-icon-seat[data-icon-kind="artwork"] > .cxm-plugin-icon { border: 0; background: transparent; }
  .cxm-plugin-body { min-width: 0; flex: 1; }
  .cxm-plugin-name { overflow: hidden; color: #f0f2f6; font-size: 12px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-plugin-name-row { display: flex; min-width: 0; align-items: center; gap: 6px; }
  .cxm-plugin-name-row > .cxm-plugin-name { min-width: 0; }
  .cxm-marketplace-trust-badges { display: inline-flex; flex: none; align-items: center; gap: 4px; }
  .cxm-marketplace-title-row { display: flex; min-width: 0; align-items: center; gap: 6px; }
  .cxm-marketplace-title-row > .cxc-title { min-width: 0; }
  .cxm-marketplace-trust-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 2px 5px;
    border: 1px solid rgba(199, 204, 212, .18);
    border-radius: 999px;
    background: rgba(199, 204, 212, .075);
    color: #bfc6d2;
    font-size: 9px;
    font-weight: 700;
    line-height: 1.2;
    white-space: nowrap;
  }
  .cxm-marketplace-trust-badge[data-trust-dimension="official"] { color: #c9d9ff; }
  .cxm-marketplace-trust-badge[data-trust-dimension="certified"] { color: #c8f1dc; }
  .cxm-marketplace-trust-badge .cxm-host-icon { width: 12px; height: 12px; }
  .cxm-plugin-description { display: -webkit-box; margin-top: 4px; overflow: hidden; color: #818b9d; font-size: 10px; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .cxm-plugin-meta { display: flex; min-width: 0; align-items: center; gap: 6px; margin-top: 4px; color: #7d8798; font-size: 10px; }
  .cxm-plugin-meta-version { flex: none; }
  .cxm-plugin-meta-source { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-status-dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: #6b7280; }
  .cxm-status-dot[data-status="active"], .cxm-status-dot[data-status="loaded"] { background: #4ade80; }
  .cxm-status-dot[data-status="failed"] { background: #fb7185; }
  .cxm-status-dot[data-status="blocked"], .cxm-status-dot[data-status="loading"] { background: #fbbf24; }
  .cxm-status-dot[data-status="installing"], .cxm-status-dot[data-status="updating"], .cxm-status-dot[data-status="enabling"], .cxm-status-dot[data-status="disabling"], .cxm-status-dot[data-status="reloading"], .cxm-status-dot[data-status="uninstalling"], .cxm-status-dot[data-status="rolling-back"] { background: #60a5fa; }
  .cxm-status-dot[data-status="rollback-failed"] { background: #fb7185; }
  .cxm-lifecycle-overlay { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 24px; background: rgb(0 0 0 / 58%); }
  .cxm-lifecycle-dialog { width: min(460px, 100%); max-height: min(660px, calc(100vh - 48px)); overflow: auto; box-sizing: border-box; border: 1px solid #3b4048; border-radius: 14px; padding: 16px; background: #20242b; color: #edf0f4; font: 13px/1.45 system-ui, sans-serif; box-shadow: 0 24px 80px rgb(0 0 0 / 45%); }
  .cxm-lifecycle-header { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 12px; }
  .cxm-lifecycle-dialog h2 { min-width: 0; margin: 0; font-size: 15px; line-height: 1.3; }
  .cxm-lifecycle-dialog p { margin: 6px 0 0; color: #bfc5ce; font-size: 12px; line-height: 1.45; }
  .cxm-lifecycle-impact { margin: 12px 0; padding: 10px 12px; border-radius: 9px; background: rgba(255,255,255,.05); color: #d7dbe3; }
  .cxm-lifecycle-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
  .cxm-directory-control { display: grid; min-inline-size: 0; grid-template-columns: minmax(0, 1fr) 32px; align-items: center; gap: 7px; }
  .cxm-directory-control > :first-child { min-inline-size: 0; }
  .cxm-directory-picker { width: 32px; height: 32px; }
  .cxm-local-import-dialog { width: min(420px, 100%); padding: 12px; }
  .cxm-local-import-dialog .cxm-lifecycle-header { min-block-size: 32px; }
  .cxm-local-import-form { min-inline-size: 0; gap: 12px; padding: 10px 0 0; }
  .cxm-local-import-field { display: grid; gap: 6px; min-width: 0; }
  .cxm-local-import-field .cxf-label { font-size: 12px; }
  .cxm-local-import-field[data-invalid="true"] .cxf-tdesign-control { border-color: var(--td-error-color); }
  .cxm-local-import-error { margin: 0; color: var(--td-error-color); font-size: 11px; line-height: 1.4; }
  .cxm-local-import-error[hidden] { display: none; }
  .cxm-local-import-actions { margin: 0; }
  .cxm-visually-hidden { position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important; margin: -1px !important; overflow: hidden !important; clip: rect(0, 0, 0, 0) !important; white-space: nowrap !important; border: 0 !important; }
  .cxm-detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  .cxm-detail-id { color: #747f91; font: 10px/1.3 ui-monospace, monospace; }
  .cxm-detail-description { max-width: 680px; margin: 14px 0 0; color: #a7afbe; font-size: 12px; }
  .cxm-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    padding: 7px 10px;
    border: 1px solid rgba(255, 255, 255, .12);
    border-radius: 8px;
    background: rgba(255, 255, 255, .055);
    color: #f2f4f8;
    cursor: pointer;
    text-decoration: none;
    font: 11px/1.2 system-ui, sans-serif;
    gap: 6px;
  }
  .cxm-action-icon { width: 14px; height: 14px; }
  .cxm-action:hover:not(:disabled) { border-color: rgba(199, 204, 212, .5); background: rgba(199, 204, 212, .12); }
  .cxm-action:disabled { cursor: default; opacity: .45; }
  .cxm-action[data-tone="danger"] { color: #fecdd3; }
  .cxm-detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 15px; }
  .cxm-field { min-width: 0; padding: 10px; border-radius: 9px; background: rgba(255, 255, 255, .035); }
  .cxm-field-label { color: #737e90; font-size: 9px; text-transform: uppercase; letter-spacing: .08em; }
  .cxm-field-value { margin-top: 5px; overflow-wrap: anywhere; color: #cdd2dc; font-size: 11px; }
  .cxm-marketplace-trust-list { display: grid; gap: 9px; margin-top: 10px; }
  .cxm-marketplace-trust-item { padding: 12px 13px; border: 1px solid rgba(199, 204, 212, .16); border-radius: 10px; background: rgba(199, 204, 212, .045); }
  .cxm-marketplace-trust-title { display: flex; align-items: center; gap: 7px; color: #edf0f4; font-size: 12px; font-weight: 700; }
  .cxm-marketplace-trust-title .cxm-host-icon { width: 17px; height: 17px; }
  .cxm-marketplace-trust-copy { margin: 6px 0 0; color: #9da6b6; font-size: 11px; }
  .cxm-marketplace-trust-meta { margin-top: 7px; color: #7f899a; font: 10px/1.5 ui-monospace, monospace; overflow-wrap: anywhere; }
  .cxm-marketplace-trust-evidence { display: inline-flex; margin-top: 8px; }
  .cxm-manager-inline-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .cxm-code { max-height: 140px; margin: 6px 0 0; overflow: auto; color: #bac2d2; font: 10px/1.45 ui-monospace, monospace; white-space: pre-wrap; }
  .cxm-config-renderer { min-height: 2rem; }
  .cxm-readme { inline-size: 100%; max-inline-size: 96rem; box-sizing: border-box; color: var(--cx-text); font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
  .cxm-readme > :first-child { margin-top: 0 !important; }
  .cxm-readme > :last-child { margin-bottom: 0 !important; }
  .cxm-readme h1, .cxm-readme h2, .cxm-readme h3, .cxm-readme h4, .cxm-readme h5, .cxm-readme h6 { color: var(--cx-text); line-height: 1.25; }
  .cxm-readme h1 { margin: 0 0 16px; padding-bottom: 9px; border-bottom: 1px solid var(--cx-border); font-size: 24px; }
  .cxm-readme h2 { margin: 24px 0 12px; padding-bottom: 7px; border-bottom: 1px solid var(--cx-border); font-size: 18px; }
  .cxm-readme h3 { margin: 20px 0 8px; font-size: 15px; }
  .cxm-readme h4, .cxm-readme h5, .cxm-readme h6 { margin: 18px 0 7px; font-size: 13px; }
  .cxm-readme p { margin: 0 0 14px; color: var(--cx-text); }
  .cxm-readme ul, .cxm-readme ol { margin: 0 0 16px; padding-left: 24px; }
  .cxm-readme li { margin: 5px 0; }
  .cxm-readme .task-list-item { list-style: none; }
  .cxm-readme .task-list-item > input { margin: 0 7px 0 -20px; accent-color: var(--cx-primary); }
  .cxm-readme a { color: var(--cx-primary); text-decoration: none; }
  .cxm-readme a:hover { text-decoration: underline; }
  .cxm-readme blockquote { margin: 0 0 16px; padding: 0 14px; border-left: 4px solid var(--cx-border); color: var(--cx-muted); }
  .cxm-readme blockquote p { color: inherit; }
  .cxm-readme hr { height: 1px; margin: 22px 0; border: 0; background: var(--cx-border); }
  .cxm-readme table { display: block; inline-size: 100%; margin: 0 0 16px; overflow: auto; border-spacing: 0; border-collapse: collapse; }
  .cxm-readme th, .cxm-readme td { padding: 7px 11px; border: 1px solid var(--cx-border); text-align: left; }
  .cxm-readme th { background: var(--cx-hover); font-weight: 650; }
  .cxm-readme tr:nth-child(2n) td { background: color-mix(in srgb, var(--cx-hover) 48%, transparent); }
  .cxm-readme code { padding: 2px 5px; border-radius: 4px; background: var(--cx-hover); color: var(--cx-text); font: 11px/1.5 ui-monospace, monospace; }
  .cxm-readme pre { margin: 14px 0 18px; overflow: auto; padding: 14px 16px; border: 1px solid var(--cx-border); border-radius: 8px; background: color-mix(in srgb, var(--cx-surface-raised) 82%, #000); }
  .cxm-readme pre code { padding: 0; background: transparent; color: inherit; white-space: pre; }
  .cxm-readme pre code[data-shiki-theme] { display: block; }
  .cxm-readme-code-line { display: block; min-height: 1.45em; }
  .cxm-error { margin-top: 12px; color: #fda4af; font-size: 11px; }
  .cxm-catalog-list { margin-top: 12px; border-top: 1px solid rgba(255, 255, 255, .08); border-bottom: 1px solid rgba(255, 255, 255, .08); }
  .cxm-catalog-row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 15px 2px;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
  }
  .cxm-catalog-row + .cxm-catalog-row { border-top: 1px solid rgba(255, 255, 255, .08); }
  .cxm-catalog-item + .cxm-catalog-item { border-top: 1px solid rgba(255, 255, 255, .08); }
  .cxm-catalog-row:hover .cxm-catalog-title { color: #fff; }
  .cxm-catalog-row:focus-visible { outline: 2px solid #c7ccd4; outline-offset: -2px; border-radius: 7px; }
  .cxm-catalog-icon { width: 32px; height: 32px; flex: none; color: #bfc5ce; }
  .cxm-catalog-icon svg { width: 21px; height: 21px; }
  .cxm-catalog-copy { min-width: 0; flex: 1 1 auto; }
  .cxm-catalog-title, .cxm-catalog-description, .cxm-catalog-id { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-catalog-title { display: block; color: #e7e9ee; font-size: 12px; font-weight: 650; }
  .cxm-catalog-description { display: block; margin-top: 3px; color: #858fa1; font-size: 11px; }
  .cxm-catalog-id { display: block; margin-top: 4px; color: #697386; cursor: text; font: 10px/1.35 ui-monospace, monospace; -webkit-user-select: text; user-select: text; }
  .cxm-catalog-status { display: inline-flex; min-width: 0; max-width: min(168px, 38%); flex: 0 1 auto; align-items: center; gap: 5px; overflow: hidden; color: #8f98a9; font-size: 10px; white-space: nowrap; }
  .cxm-catalog-status[data-tone="pending"] { color: #b8a574; }
  .cxm-catalog-status[data-tone="unavailable"], .cxm-catalog-status[data-tone="error"] { color: #d8948f; }
  .cxm-catalog-status-copy { overflow: hidden; text-overflow: ellipsis; }
  .cxm-catalog-status-icon { width: 14px; height: 14px; }
  .cxm-catalog-status-icon svg { width: 14px; height: 14px; }
  .cxm-kind-badge { padding: 3px 7px; border-radius: 6px; background: rgba(199, 204, 212, .09); color: #aeb6c5; font-size: 9px; }
  .cxm-route-section { margin-top: 18px; }
  .cxm-route-section:first-of-type { margin-top: 12px; }
  .cxm-route-section-heading { margin: 0; color: var(--cx-text); font-size: 13px; font-weight: 700; }
  .cxm-route-section-copy { margin: 4px 0 9px; color: var(--cx-muted); font-size: 10px; line-height: 1.45; }
  .cxm-route-group { overflow: hidden; border: 1px solid var(--cx-border); border-radius: 12px; background: var(--cx-surface-raised); }
  .cxm-route-group-item + .cxm-route-group-item { border-top: 1px solid var(--cx-border); }
  .cxm-route-card {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    width: 100%;
    box-sizing: border-box;
    padding: 13px 14px;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
  }
  button.cxm-route-card { cursor: pointer; }
  button.cxm-route-card:hover { background: color-mix(in srgb, var(--cx-text) 5%, transparent); }
  button.cxm-route-card:focus-visible { outline: 2px solid var(--cx-focus); outline-offset: -3px; border-radius: 10px; }
  .cxm-route-card-icon { display: grid; place-items: center; width: var(--cx-compact-list-icon-seat); height: var(--cx-compact-list-icon-seat); flex: none; color: var(--cx-muted); }
  .cxm-route-card-icon svg { width: var(--cx-compact-list-icon-glyph); height: var(--cx-compact-list-icon-glyph); }
  .cxm-route-card-body { min-width: 0; flex: 1 1 auto; }
  .cxm-route-card-title { display: block; overflow: hidden; color: var(--cx-text); font-size: 12px; font-weight: 680; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-route-card-description { display: -webkit-box; margin-top: 3px; overflow: hidden; color: var(--cx-muted); font-size: 11px; line-height: 1.42; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .cxm-route-machine { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 8px 0 0; }
  .cxm-route-machine-item { display: grid; min-width: 0; grid-template-columns: max-content minmax(0, 1fr); gap: 5px; font-size: 10px; line-height: 1.4; }
  .cxm-route-machine dt { color: var(--cx-muted); }
  .cxm-route-machine dd { min-width: 0; margin: 0; overflow-wrap: anywhere; color: var(--cx-text); font-family: ui-monospace, monospace; user-select: text; }
  .cxm-route-metadata-diagnostic { display: flex; min-width: 0; align-items: center; gap: 5px; margin-top: 7px; color: var(--cx-muted); font-size: 10px; line-height: 1.35; }
  .cxm-route-metadata-diagnostic .cxm-host-icon { width: 13px; height: 13px; flex: none; }
  .cxm-route-state { display: flex; min-width: 0; align-items: center; gap: 5px; margin-top: 7px; color: var(--cx-danger); font-size: 10px; line-height: 1.35; }
  .cxm-usage-list { border-top: 1px solid rgba(255, 255, 255, .08); border-bottom: 1px solid rgba(255, 255, 255, .08); }
  .cxm-usage-item { padding: 12px 2px; }
  .cxm-usage-item + .cxm-usage-item { border-top: 1px solid rgba(255, 255, 255, .08); }
  .cxm-usage-header { display: grid; grid-template-columns: minmax(0, 1fr) minmax(150px, 190px); align-items: center; gap: 12px; }
  /* The policy adapter is already an official TDesign Select. This layout
     seat must not borrow the native input chrome or it becomes a second
     visible border/background around the Web Component. */
  .cxm-usage-policy-select { inline-size: 100%; min-inline-size: 0; }
  .cxm-usage-identity { display: flex; min-width: 0; align-items: center; gap: 10px; }
  .cxm-usage-identity .cxm-plugin-icon { width: 32px; height: 32px; }
  .cxm-usage-resources { margin: 9px 0 0 42px; border-top: 1px solid rgba(255, 255, 255, .065); }
  .cxm-resource-row { display: grid; grid-template-columns: minmax(0, 1fr) max-content; gap: 4px 12px; padding: 8px 0; color: #8f98a9; }
  .cxm-resource-row + .cxm-resource-row { border-top: 1px solid rgba(255, 255, 255, .055); }
  .cxm-resource-title { color: #d3d8e1; font-size: 11px; font-weight: 600; }
  .cxm-resource-description { grid-column: 1; color: #858fa1; font-size: 10px; line-height: 1.4; }
  .cxm-resource-id { grid-column: 2; grid-row: 1 / span 2; align-self: center; color: #697386; font: 10px/1.35 ui-monospace, monospace; overflow-wrap: anywhere; user-select: text; }
  .cxm-link-list { border-top: 1px solid rgba(255, 255, 255, .08); border-bottom: 1px solid rgba(255, 255, 255, .08); }
  .cxm-link-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 13px 2px; }
  .cxm-link-row + .cxm-link-row { border-top: 1px solid rgba(255, 255, 255, .08); }
  .cxm-link-row-copy { min-width: 0; }
  .cxm-link-row-title { color: #d8dce3; font-size: 11px; font-weight: 650; }
  .cxm-link-row-value { display: block; margin-top: 3px; overflow-wrap: anywhere; color: #778295; font: 10px/1.4 ui-monospace, monospace; }
  .cxm-source-list { display: grid; gap: 8px; margin-top: 14px; }
  .cxm-source-row { display: flex; align-items: center; gap: 10px; padding: 11px; }
  .cxm-source-body { min-width: 0; flex: 1; }
  .cxm-source-url { display: block; overflow: hidden; color: #c6ccd8; font: 10px/1.35 ui-monospace, monospace; text-decoration: none; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-source-state { display: flex; align-items: center; gap: 6px; margin-top: 4px; color: #737e90; font-size: 10px; }
  .cxm-mini-action { padding: 5px 7px; border: 1px solid rgba(255, 255, 255, .09); border-radius: 7px; background: transparent; color: #99a2b2; cursor: pointer; font: 10px/1.2 system-ui, sans-serif; }
  .cxm-mini-action:hover:not(:disabled) { color: #fff; border-color: rgba(199, 204, 212, .4); }
  .cxm-mini-action:disabled { cursor: default; opacity: .35; }
  .cxm-console-warning .cxm-manager-icon-action, .cxm-console-inspector-head .cxm-manager-icon-action { color: inherit; }
  @media (max-width: 760px) {
    .cxm-backdrop { padding: 10px; }
    .cxm-dialog { grid-template-columns: 168px minmax(0, 1fr); width: calc(100vw - 20px); height: calc(100vh - 20px); }
    .cxm-card-grid, .cxm-detail-grid { grid-template-columns: 1fr; }
    .cxm-usage-header { grid-template-columns: minmax(0, 1fr); }
    .cxm-usage-header .cxm-usage-policy-select { width: 100%; }
    .cxm-usage-resources { margin-left: 42px; }
    .cxm-resource-row { grid-template-columns: minmax(0, 1fr); }
    .cxm-resource-id { grid-column: 1; grid-row: auto; }
    .cxm-console-controls { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .cxm-console-controls > input { grid-column: 1 / -1; }
    .cxm-console-action-toolbar { grid-column: 1 / -1; justify-content: flex-start; }
    .cxm-console-workspace[data-inspector="true"] { grid-template-columns: minmax(0, 1fr); }
    .cxm-runtime-status-facts { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .cxm-catalog-row { gap: 8px; padding: 12px 2px; }
    .cxm-catalog-icon { width: 24px; height: 24px; }
    .cxm-catalog-status { max-width: 34%; }
    .cxm-route-card { gap: 9px; padding: 12px; }
    .cxm-route-machine { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; }
    .cxm-permission-item { grid-template-columns: minmax(0, 1fr); }
    .cxm-permission-control { justify-content: space-between; padding-inline-start: 35px; }
    .cxm-permission-control t-select { inline-size: min(100%, 13rem); }
  }
  @media (max-width: 520px) {
    .cxm-console-controls { grid-template-columns: minmax(0, 1fr); }
    .cxm-runtime-status { grid-template-columns: auto minmax(0, 1fr); }
    .cxm-runtime-status > .cxm-manager-icon-action { grid-column: 2; justify-self: start; }
    .cxm-runtime-status-facts { grid-template-columns: 1fr; }
    .cxm-console-action-toolbar { grid-column: 1 / -1; justify-content: flex-start; }
  }
`

const HOST_THEME_OVERLAY_STYLES = `
  [data-cordisx-manager-modal], .cxm-lifecycle-overlay, .cxm-authorization-overlay { color: var(--cx-text); }
  .cxm-backdrop, .cxm-lifecycle-overlay, .cxm-authorization-overlay { background: var(--cx-backdrop); }
  .cxm-dialog, .cxm-lifecycle-dialog, .cxm-authorization-dialog { border-color: var(--cx-border); background: var(--cx-surface); color: var(--cx-text); box-shadow: 0 24px 80px var(--cx-shadow); }
  .cxm-sidebar { border-color: var(--cx-border); background: var(--cx-surface-raised); }
  .cxm-header, .cxm-about-actions, .cxm-about-action-item + .cxm-about-action-item, .cxm-flat-item + .cxm-flat-item { border-color: var(--cx-border); }
  .cxm-about-actions { background: var(--cx-surface-raised); }
  .cxm-nav-button, .cxm-heading p, .cxm-detail-description, .cxm-permission-reason, .cxm-copy, .cxm-source-state, .cxm-detail-id, .cxm-plugin-description, .cxm-plugin-meta, .cxm-catalog-description, .cxm-catalog-id, .cxm-catalog-status, .cxm-marketplace-trust-copy, .cxm-marketplace-trust-meta, .cxm-field-label { color: var(--cx-muted); }
  .cxm-heading-direct-title { color: var(--cx-text); }
  .cxm-nav-icon { color: currentColor; }
  .cxm-heading-leading { color: var(--cx-text); }
  .cxm-nav-button:hover, .cxm-nav-button[aria-current="page"], .cxm-nav-button[aria-selected="true"], .cxm-back:hover, .cxm-breadcrumb-action:hover, .cxm-breadcrumb-overflow > summary:hover, .cxm-tab:hover, .cxm-tab[aria-selected="true"], .cxm-about-action:hover, .cxm-about-action:focus-visible { background: var(--cx-hover); color: var(--cx-text); }
  .cxm-about-action-title, .cxm-about-action-copy { background: transparent; }
  .cxm-about-action-title { color: var(--cx-text); }
  .cxm-about-action-copy, .cxm-about-action-arrow { color: var(--cx-muted); }
  .cxm-about-action:hover .cxm-about-action-arrow, .cxm-about-action:focus-visible .cxm-about-action-arrow { color: var(--cx-text); }
  .cxm-heading-title, .cxm-breadcrumb-current, .cxm-card-value, .cxm-section-title, .cxm-about-name, .cxm-search, .cxm-source-input, .cxm-plugin-name, .cxm-catalog-title, .cxm-marketplace-trust-title, .cxm-field-value { color: var(--cx-text); }
  .cxm-card, .cxm-slot-card, .cxm-source-row, .cxm-field, .cxm-lifecycle-impact, .cxm-marketplace-trust-item, .cxm-marketplace-trust-badge { border-color: var(--cx-border); background: var(--cx-hover); }
  .cxm-search, .cxm-source-input, .cxm-action, .cxm-mini-action, .cxm-marketplace-filter { border-color: var(--cx-border); background: var(--cx-surface-raised); color: var(--cx-text); }
  .cxm-close { background: transparent; color: var(--cx-text); }
  .cxm-close:hover { background: var(--cx-hover); color: var(--cx-text); }
  .cxm-action:hover:not(:disabled), .cxm-mini-action:hover:not(:disabled) { border-color: var(--cx-primary); background: var(--cx-hover); color: var(--cx-text); }
  .cxm-breadcrumb-menu { border-color: var(--cx-border); background: var(--cx-surface-raised); box-shadow: 0 12px 32px var(--cx-shadow); }
  .cxm-authorization-dialog > p, .cxm-authorization-reason, .cxm-authorization-choice { color: var(--cx-text); }
  .cxm-action[data-tone="danger"] { color: var(--cx-danger); }
  .cxm-notice { border-color: var(--cx-border); background: var(--cx-hover); color: var(--cx-muted); }
  .cxm-catalog-status[data-tone="pending"] { color: var(--cx-primary); }
  .cxm-catalog-status[data-tone="unavailable"], .cxm-catalog-status[data-tone="error"] { color: var(--cx-danger); }
  .cxm-required-badge { background: var(--cx-hover); color: var(--cx-primary); }
  .cxm-nav-button:focus-visible, .cxm-close:focus-visible, .cxm-tab:focus-visible, .cxm-action:focus-visible, .cxm-mini-action:focus-visible, .cxm-search:focus-visible, .cxm-source-input:focus-visible, .cxm-authorization-actions button:focus-visible { outline-color: var(--cx-focus); }
  .cxm-authorization-item, .cxm-authorization-actions button { border-color: var(--cx-border); }
  .cxm-authorization-actions button { background: var(--cx-surface-raised); color: var(--cx-text); }
  .cxm-authorization-actions button[data-primary="true"] { border-color: var(--cx-primary); background: var(--cx-primary); color: var(--cx-primary-text); }
`

function create<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  if (className !== undefined) element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

function markDecorative<T extends HTMLElement>(element: T): T {
  element.setAttribute('aria-hidden', 'true')
  element.draggable = false
  return element
}

function hostBrandBackground(document: Document): 'dark' | 'light' {
  return resolveHostTheme(document).theme
}

function syncAdaptiveBrandMark(document: Document, mark: HTMLImageElement): void {
  const background = hostBrandBackground(document)
  const source = background === 'dark' ? CORDISX_MARK_DARK_URI : CORDISX_MARK_LIGHT_URI
  if (mark.src !== source) mark.src = source
  mark.dataset.hostBackground = background
}

function syncAdaptiveBrandMarks(document: Document): void {
  for (const mark of document.querySelectorAll<HTMLImageElement>('img[data-brand-rendering="direct-host"]')) {
    syncAdaptiveBrandMark(document, mark)
  }
}

function createAdaptiveBrandMark(document: Document): HTMLImageElement {
  const mark = create(document, 'img', 'cxm-brand-mark')
  mark.dataset.cordisxBrandMark = 'true'
  mark.dataset.brandRendering = 'direct-host'
  mark.alt = ''
  markDecorative(mark)
  syncAdaptiveBrandMark(document, mark)
  return mark
}

export interface PluginConsoleLunaEntryProjection {
  readonly entry: CordisXPluginConsoleEntryV1
  readonly type: CordisXPluginConsoleEntryV1['method']
  readonly args: readonly unknown[]
  readonly header: {
    readonly time: string
    readonly from: string
  }
}

/** Rehydrate only the immutable Host snapshot, never the original plugin value or getter. */
export function projectPluginConsoleValueForLuna(snapshot: CordisXPluginConsoleValueSummaryV1): unknown {
  if (snapshot.type === 'undefined') return undefined
  if (snapshot.type === 'null') return null
  if (snapshot.type === 'boolean' || snapshot.type === 'number' || snapshot.type === 'string') return snapshot.value
  if (snapshot.type === 'bigint') {
    try { return BigInt(String(snapshot.value ?? snapshot.preview).replace(/n$/u, '')) } catch { return snapshot.preview }
  }
  if (snapshot.type === 'error') {
    const name = snapshot.name ?? 'Error'
    const prefix = `${name}: `
    const message = snapshot.preview.startsWith(prefix) ? snapshot.preview.slice(prefix.length) : snapshot.preview
    const error = new Error(message)
    error.name = name
    if (snapshot.stack !== undefined) Object.defineProperty(error, 'stack', { configurable: true, value: snapshot.stack })
    return error
  }
  if (snapshot.type === 'array') {
    const value = (snapshot.items ?? []).map(projectPluginConsoleValueForLuna)
    if (snapshot.truncated === true) Object.defineProperty(value, '[[Truncated]]', { enumerable: true, value: true })
    return value
  }
  if (snapshot.type === 'object') {
    const value: Record<string, unknown> = {}
    for (const item of snapshot.entries ?? []) {
      Object.defineProperty(value, item.key, {
        configurable: true, enumerable: true, writable: false,
        value: projectPluginConsoleValueForLuna(item.value),
      })
    }
    if (snapshot.truncated === true) Object.defineProperty(value, '[[Truncated]]', { enumerable: true, value: true })
    return value
  }
  return snapshot.preview
}

function lunaConsoleTime(timestamp: number, includeMilliseconds = false): string {
  const date = new Date(timestamp)
  const parts = [date.getHours(), date.getMinutes(), date.getSeconds()].map(value => String(value).padStart(2, '0'))
  return `${parts.join(':')}${includeMilliseconds ? `.${String(date.getMilliseconds()).padStart(3, '0')}` : ''}`
}

/** Keep each Host entry independent and preserve native Console argument-array semantics. */
export function projectPluginConsoleEntryForLuna(entry: CordisXPluginConsoleEntryV1): PluginConsoleLunaEntryProjection {
  const values = entry.args.map(projectPluginConsoleValueForLuna)
  return {
    entry,
    type: entry.method,
    args: entry.kind === 'console' ? (values.length === 0 ? [entry.message] : values) : [entry.message, ...values],
    header: { time: lunaConsoleTime(entry.time), from: entry.source },
  }
}

function pluginConsoleEntryCopyText(entry: CordisXPluginConsoleEntryV1): string {
  const args = entry.args.map(argument => argument.preview).join(' ')
  return `${lunaConsoleTime(entry.time, true)} ${entry.method} ${entry.source} ${entry.kind === 'console' ? args || entry.message : `${entry.message}${args === '' ? '' : ` ${args}`}`}`
}

/**
 * Export only Host-issued entries for the page identity. Keep each immutable
 * `args` array intact: collapsing it into message text would change native
 * console.* semantics and lose the ownership fence carried by every entry.
 */
export function serializePluginConsoleExport(page: CordisXPluginConsolePageV1, exportedAt = new Date().toISOString()): string {
  const entries = page.entries.filter(entry => (
    entry.plugin.source === page.plugin.source && entry.plugin.pluginId === page.plugin.pluginId
  ))
  return JSON.stringify({ exportedAt, plugin: page.plugin, generation: page.generation, entries }, undefined, 2)
}

interface PluginConsoleRuntimeSummary {
  readonly requests: number
  readonly successes: number
  readonly failures: number
  readonly denials: number
  readonly averageDurationMs: number | undefined
  readonly consumption: readonly string[]
}

/** Host-owned aggregate telemetry belongs to runtime state, not the log viewer. */
function summarizePluginConsole(page: CordisXPluginConsolePageV1): PluginConsoleRuntimeSummary {
  const requests = page.entries.filter(entry => entry.kind === 'invocation' && entry.phase === 'requested').length
  const successes = page.entries.filter(entry => entry.kind === 'invocation' && entry.phase === 'success').length
  const failures = page.entries.filter(entry => entry.kind === 'invocation' && entry.phase === 'failure').length
  const denials = page.entries.filter(entry => entry.kind === 'permission' && entry.phase === 'deny').length
  const durations = page.entries.filter(entry => entry.kind === 'invocation' && entry.durationMs !== undefined).map(entry => entry.durationMs!)
  const sources = new Map<string, { calls: number; items: number; bytes: number }>()
  for (const entry of page.entries) {
    if (entry.kind === 'invocation' && entry.phase === 'requested') {
      const current = sources.get(entry.source) ?? { calls: 0, items: 0, bytes: 0 }
      current.calls += 1
      sources.set(entry.source, current)
    }
    if (entry.kind === 'invocation' && ['success', 'failure', 'cancel'].includes(entry.phase ?? '')) {
      const current = sources.get(entry.source) ?? { calls: 0, items: 0, bytes: 0 }
      current.items += entry.result?.itemCount ?? 0
      current.bytes += entry.result?.byteCount ?? 0
      sources.set(entry.source, current)
    }
  }
  return {
    requests,
    successes,
    failures,
    denials,
    averageDurationMs: durations.length === 0 ? undefined : durations.reduce((sum, value) => sum + value, 0) / durations.length,
    consumption: [...sources].map(([source, value]) => `${source}: ${value.calls} calls${value.items === 0 ? '' : ` · ${value.items} items`}${value.bytes === 0 ? '' : ` · ${value.bytes} B`}`),
  }
}

function capabilityPresentation(capability: CordisXPermissionCapabilityV4): CapabilityPresentation {
  const known = (CAPABILITY_PRESENTATIONS as Readonly<Partial<Record<CordisXPermissionCapabilityV4, CapabilityPresentation>>>)[capability]
  if (known !== undefined) return known
  const group = String(capability).split('.')[0]
  return {
    name: group === 'models'
      ? '使用模型能力'
      : group === 'tasks'
        ? '使用任务能力'
        : group === 'turns'
          ? '使用对话能力'
          : '使用宿主能力',
    icon: 'capability-fallback',
  }
}

function createCapabilityIcon(document: Document, capability: CordisXPermissionCapabilityV4): HTMLSpanElement {
  return createManagerIcon(document, capabilityPresentation(capability).icon, 'cxm-capability-icon')
}

function capabilityAvailabilityLabel(status: CordisXCapabilityAvailabilityState, locale = 'zh-CN'): string {
  return status === 'supported'
    ? managerCopy(locale, 'runtime.availability-supported')
    : status === 'degraded'
      ? managerCopy(locale, 'runtime.availability-degraded')
      : managerCopy(locale, 'runtime.unavailable')
}

function createPermissionPolicySelect(
  forms: HostFormAdapter,
  permission: ManagerPermissionSnapshot,
  onChange: (policy: CordisXPermissionPolicy, control: TDesignSelectElement<CordisXPermissionPolicy>) => Promise<void>,
): TDesignSelectElement<CordisXPermissionPolicy> {
  let policy: TDesignSelectElement<CordisXPermissionPolicy>
  policy = forms.select(
    `${capabilityPresentation(permission.capability).name}的权限策略`,
    (['ask', 'allow', 'deny'] as const).map(value => ({ value, label: POLICY_LABELS[value] })),
    permission.policy,
    value => { if (value !== undefined) void onChange(value, policy) },
  )
  policy.classList.add('cxm-permission-policy-select')
  policy.dataset.hostFormPrimitive = 'select'
  policy.dataset.permissionCapability = permission.capability
  return policy
}

export async function requestPluginAuthorization(
  document: Document,
  plugin: Pick<ManagerPluginSnapshot, 'id' | 'name'>,
  plan: CordisXPermissionAuthorizationPlanV1,
  permissions: readonly ManagerPermissionSnapshot[],
  localeProvider: () => string = () => document.documentElement.lang || 'zh-CN',
): Promise<CordisXPermissionAuthorizationDecisionV1 | undefined> {
  const decisionEnvelope = (
    decision: CordisXPermissionAuthorizationDecisionV1['decisions'][number]['decision'],
    selected: (capability: CordisXPlatformCapability) => boolean,
  ): CordisXPermissionAuthorizationDecisionV1 => ({
    $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
    schemaVersion: 1,
    planId: plan.planId,
    operation: plan.operation,
    profileId: plan.profileId,
    identity: plan.identity,
    decisions: plan.declarations.map(declaration => ({
      capability: declaration.capability,
      scope: declaration.scope,
      decision: decision === 'deny' || !selected(declaration.capability) ? 'deny' : decision,
    })),
  })
  if (plan.declarations.length === 0) return decisionEnvelope('allow', () => true)
  return await new Promise((resolve) => {
    const overlay = create(document, 'div', 'cxm-authorization-overlay cxf-scope')
    const forms = new HostFormAdapter(document, overlay, localeProvider)
    const theme = new HostThemeProjection(document)
    const detachTheme = theme.attach(overlay)
    overlay.dataset.permissionAuthorization = plugin.id
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    const titleId = `cxm-authorization-${plugin.id}`
    overlay.setAttribute('aria-labelledby', titleId)
    const style = document.createElement('style')
    style.textContent = `${HOST_FORM_STYLES}
      .cxm-authorization-overlay { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 24px; background: var(--cx-backdrop); }
      .cxm-authorization-dialog { width: min(600px, 100%); max-height: min(720px, calc(100vh - 48px)); overflow: auto; border: 1px solid var(--cx-border); border-radius: 14px; padding: 20px; background: var(--cx-surface); color: var(--cx-text); box-shadow: 0 24px 80px var(--cx-shadow); }
      .cxm-authorization-dialog h2 { margin: 0; font-size: 18px; }
      .cxm-authorization-dialog > p { margin: 9px 0 16px; color: var(--cx-muted); line-height: 1.5; }
      .cxm-authorization-list { display: grid; }
      .cxm-authorization-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 14px; padding: 12px 0; border-top: 1px solid var(--cx-border); }
      .cxm-authorization-item:first-child { border-top: 0; }
      .cxm-authorization-name { font-weight: 600; }
      .cxm-authorization-reason { color: var(--cx-muted); line-height: 1.45; }
      .cxm-authorization-choice { grid-column: 2; grid-row: 1 / span 2; align-self: center; display: flex; align-items: center; gap: 9px; color: var(--cx-text); cursor: pointer; }
      .cxm-authorization-choice t-checkbox { flex: 0 0 auto; }
      .cxm-authorization-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 18px; }
      .cxm-authorization-actions button { border: 1px solid var(--cx-border); border-radius: 9px; padding: 8px 12px; background: var(--cx-surface-raised); color: var(--cx-text); cursor: pointer; }
      .cxm-authorization-actions button[data-primary="true"] { border-color: var(--cx-primary); background: var(--cx-primary); color: var(--cx-primary-text); font-weight: 600; }
      .cxm-authorization-actions button[data-tone="danger"] { color: var(--cx-danger); }
      .cxm-authorization-actions button:focus-visible { outline: 2px solid var(--cx-focus); outline-offset: 2px; }
    `
    const dialog = create(document, 'div', 'cxm-authorization-dialog')
    const operationLabel = plan.operation === 'install' ? '安装' : plan.operation === 'update' ? '更新' : '启用'
    const title = create(document, 'h2', undefined, `${operationLabel}授权`)
    title.id = titleId
    dialog.append(title, create(document, 'p', undefined, `${plugin.name} 声明了以下宿主能力。持久授权是默认主操作。`))
    const list = create(document, 'div', 'cxm-authorization-list')
    list.setAttribute('role', 'list')
    const choices = new Map<CordisXPlatformCapability, TDesignElement>()
    for (const declaration of plan.declarations) {
      const projected = permissions.find(item => item.capability === declaration.capability)
      const presentation = capabilityPresentation(declaration.capability)
      const item = create(document, 'div', 'cxm-authorization-item')
      item.setAttribute('role', 'listitem')
      item.dataset.authorizationCapability = declaration.capability
      const choice = createTDesignElement(document, 't-checkbox', 'checkbox')
      choice.checked = true
      choice.disabled = declaration.required
      choice.dataset.authorizationChoice = declaration.capability
      choice.setAttribute('aria-label', `${presentation.name}（${declaration.required ? '必需' : '可选'}）`)
      choice.setAttribute('aria-checked', 'true')
      setTDesignProps(choice, {
        checked: true,
        disabled: declaration.required,
        onChange: (checked: boolean) => {
          choice.checked = checked
          choice.setAttribute('aria-checked', String(checked))
        },
      })
      if (document.defaultView?.customElements.get('t-checkbox') === undefined) {
        choice.addEventListener('click', () => {
          if (choice.disabled) return
          choice.checked = choice.checked !== true
          choice.setAttribute('aria-checked', String(choice.checked))
        })
      }
      choices.set(declaration.capability, choice)
      const choiceLabel = create(document, 'div', 'cxm-authorization-choice cxf-choice')
      choiceLabel.append(choice, create(document, 'span', undefined, `当前：${POLICY_LABELS[declaration.policy]}`))
      item.append(
        create(document, 'div', 'cxm-authorization-name', `${presentation.name} · ${declaration.required ? '必需' : '可选'}`),
        create(document, 'div', 'cxm-authorization-reason', projected?.reasonText ?? declaration.reason.fallback ?? declaration.reason.key),
        choiceLabel,
      )
      list.append(item)
    }
    dialog.append(list)
    const actions = create(document, 'div', 'cxm-authorization-actions')
    const finish = (decision: CordisXPermissionAuthorizationDecisionV1['decisions'][number]['decision'] | undefined): void => {
      detachTheme()
      overlay.remove()
      resolve(decision === undefined ? undefined : decisionEnvelope(
        decision,
        capability => choices.get(capability)?.checked === true,
      ))
    }
    const cancel = forms.button('取消')
    cancel.dataset.authorizationDecision = 'cancel'
    cancel.addEventListener('click', () => finish(undefined), { once: true })
    const deny = forms.button(`拒绝并保持${operationLabel === '安装' ? '未安装' : '停用'}`, { tone: 'danger' })
    deny.dataset.authorizationDecision = 'deny'
    deny.dataset.tone = 'danger'
    deny.addEventListener('click', () => finish('deny'), { once: true })
    const once = forms.button(`仅此次允许并${operationLabel}`)
    once.dataset.authorizationDecision = 'allow-once'
    once.addEventListener('click', () => finish('allow-once'), { once: true })
    const allow = forms.button(`始终允许并${operationLabel}`, { variant: 'primary' })
    allow.dataset.authorizationDecision = 'allow'
    allow.dataset.primary = 'true'
    allow.addEventListener('click', () => finish('allow'), { once: true })
    overlay.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      finish(undefined)
    })
    actions.append(cancel, deny, once, allow)
    dialog.append(actions)
    overlay.append(style, dialog)
    document.body.append(overlay)
    allow.focus()
  })
}

export async function requestPluginAuthorizationV2(
  document: Document,
  plugin: Pick<ManagerPluginSnapshot, 'id' | 'source' | 'name'>,
  plan: CordisXPermissionAuthorizationPlanV2,
  permissions: readonly ManagerPermissionSnapshot[],
): Promise<CordisXPermissionAuthorizationDecisionV2 | undefined> {
  if (plan.declarations.length === 0) {
    const result = new PermissionAuthorizationViewModel(plan).confirm()
    return result.status === 'confirmed' && result.decision.schemaVersion === 2 ? result.decision : undefined
  }
  const availability = Object.fromEntries(plan.declarations.flatMap(declaration => {
    const permission = permissions.find(item => item.capability === declaration.capability)
    if (permission === undefined) return []
    return [[declaration.capability, Object.freeze({
      status: permission.availability.status,
      reason: Object.freeze({
        namespace: 'cordisx.permission.host',
        key: `availability.${declaration.capability}`,
        fallback: permission.availability.reasonText,
      }),
      providerIds: Object.freeze(permission.availability.providers.map(provider => provider.providerId)),
    })]]
  })) as Partial<Record<CordisXPermissionCapabilityV2, {
    readonly status: 'supported' | 'degraded' | 'unavailable'
    readonly reason: CordisXLocalizedText
    readonly providerIds: readonly string[]
  }>>
  const dialog = new BrowserPermissionAuthorizationDialog(document)
  try {
    const result = await dialog.show(new PermissionAuthorizationViewModel(plan), {
      project: () => ({
        plugin: { name: plugin.name, source: plugin.source, trust: 'configured' },
        availability,
        resolve: message => message.fallback ?? `[[${message.namespace ?? 'permission'}:${message.key}]]`,
        scope: scope => Object.keys(scope).length === 0 ? 'Host default scope' : JSON.stringify(scope),
        requestSource: plugin.source,
      }),
    })
    return result.status === 'confirmed' && result.decision.schemaVersion === 2 ? result.decision : undefined
  } finally {
    dialog.dispose()
  }
}

export async function requestPluginAuthorizationV4(
  document: Document,
  plugin: Pick<ManagerPluginSnapshot, 'id' | 'source' | 'name'>,
  plan: CordisXPermissionAuthorizationPlanV4,
  permissions: readonly ManagerPermissionSnapshot[],
): Promise<CordisXPermissionAuthorizationDecisionV4 | undefined> {
  if (!plan.declarations.some(item => item.decisionRequired)) {
    const result = new PermissionAuthorizationViewModel(plan).confirm()
    return result.status === 'confirmed' && result.decision.schemaVersion === 4 ? result.decision : undefined
  }
  const availability = Object.fromEntries(plan.declarations.flatMap(declaration => {
    const permission = permissions.find(item => item.capability === declaration.capability)
    if (permission === undefined) return []
    return [[declaration.capability, Object.freeze({
      status: permission.availability.status,
      reason: Object.freeze({
        namespace: 'cordisx.permission.host',
        key: `availability.${declaration.capability}`,
        fallback: permission.availability.reasonText,
      }),
      providerIds: Object.freeze(permission.availability.providers.map(provider => provider.providerId)),
    })]]
  }))
  const dialog = new BrowserPermissionAuthorizationDialog(document)
  try {
    const result = await dialog.show(new PermissionAuthorizationViewModel(plan), {
      project: () => ({
        plugin: { name: plugin.name, source: plugin.source, trust: 'configured' },
        availability,
        resolve: message => message.fallback ?? `[[${message.namespace ?? 'permission'}:${message.key}]]`,
        scope: scope => Object.keys(scope).length === 0 ? 'Host default scope' : JSON.stringify(scope),
        requestSource: plugin.source,
      }),
    })
    return result.status === 'confirmed' && result.decision.schemaVersion === 4 ? result.decision : undefined
  } finally {
    dialog.dispose()
  }
}

function hasCapabilityScope(scope: CordisXCapabilityScope): boolean {
  return Object.values(scope).some(value => Array.isArray(value) && value.length > 0)
}

function createLocalTabs(
  document: Document,
  items: readonly { readonly id: string; readonly label: string; readonly icon: LocalTabIcon }[],
  active: string,
  dataAttribute: string,
  onSelect: (id: string) => void,
): HTMLElement {
  const tabs = create(document, 'div', 'cxm-tabs')
  tabs.setAttribute('role', 'tablist')
  tabs.setAttribute('aria-orientation', 'horizontal')
  const activate = (id: string): void => {
    onSelect(id)
    const replacement = [...document.querySelectorAll<HTMLButtonElement>(`[${dataAttribute}]`)]
      .find(candidate => candidate.getAttribute(dataAttribute) === id)
    replacement?.focus()
  }
  items.forEach((item, index) => {
    const button = create(document, 'button', 'cxm-tab', item.label)
    button.type = 'button'
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-selected', String(item.id === active))
    button.tabIndex = item.id === active ? 0 : -1
    button.setAttribute(dataAttribute, item.id)
    const visibleContent = create(document, 'span', 'cxm-tab-content')
    visibleContent.append(createManagerIcon(document, item.icon, 'cxm-tab-icon'), create(document, 'span', undefined, item.label))
    button.replaceChildren(visibleContent)
    button.addEventListener('click', () => activate(item.id))
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        activate(item.id)
        return
      }
      let nextIndex: number | undefined
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % items.length
      if (event.key === 'ArrowLeft') nextIndex = (index - 1 + items.length) % items.length
      if (event.key === 'Home') nextIndex = 0
      if (event.key === 'End') nextIndex = items.length - 1
      if (nextIndex === undefined) return
      event.preventDefault()
      const next = items[nextIndex]
      if (next !== undefined) activate(next.id)
    })
    tabs.append(button)
  })
  return tabs
}

function createTabPanel(document: Document, label: string): HTMLDivElement {
  const panel = create(document, 'div', 'cxm-tab-panel')
  panel.setAttribute('role', 'tabpanel')
  panel.setAttribute('aria-label', label)
  return panel
}

function createSectionTitle(document: Document, text: string): HTMLHeadingElement {
  return create(document, 'h3', 'cxm-section-title', text)
}

function statusLabel(status: ManagerPluginStatus, locale: string): string {
  if (status === 'active') return managerCopy(locale, 'plugin.status.active')
  if (status === 'blocked') return managerCopy(locale, 'plugin.status.blocked')
  if (status === 'permission-blocked') return managerCopy(locale, 'plugin.status.permission-blocked')
  if (status === 'failed') return managerCopy(locale, 'plugin.status.failed')
  if (status === 'installing') return managerCopy(locale, 'plugin.status.installing')
  if (status === 'updating') return managerCopy(locale, 'plugin.status.updating')
  if (status === 'enabling') return managerCopy(locale, 'plugin.status.enabling')
  if (status === 'disabling') return managerCopy(locale, 'plugin.status.disabling')
  if (status === 'reloading') return managerCopy(locale, 'plugin.status.reloading')
  if (status === 'uninstalling') return managerCopy(locale, 'plugin.status.uninstalling')
  if (status === 'rolling-back') return managerCopy(locale, 'plugin.status.rolling-back')
  if (status === 'rollback-failed') return managerCopy(locale, 'plugin.status.rollback-failed')
  return managerCopy(locale, 'plugin.status.configured-disabled')
}

function formatConfig(config: unknown): string {
  try {
    return JSON.stringify(config, null, 2) ?? String(config)
  } catch {
    return '[unserializable config]'
  }
}

function initials(name: string): string {
  const value = name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase() ?? '').join('')
  return value || 'CX'
}

function createPluginIcon(document: Document, name: string, source?: string): HTMLSpanElement {
  const icon = create(document, 'span', 'cxm-plugin-icon', source === undefined ? initials(name) : '')
  if (source !== undefined) {
    const image = document.createElement('img')
    image.src = source
    image.alt = ''
    image.draggable = false
    icon.append(image)
  }
  return markDecorative(icon)
}

function pluginStatusDescription(plugin: ManagerPluginSnapshot, status: ManagerPluginStatus, locale: string): string {
  const reason = status === 'failed' || status === 'rollback-failed'
    ? plugin.error
    : status === 'blocked' || status === 'permission-blocked' ? plugin.blockedReason ?? plugin.error : undefined
  const label = statusLabel(status, locale)
  if (reason === undefined) return label
  return productLocale(locale) === 'zh-CN' ? `${label}：${reason}` : `${label}: ${reason}`
}

function pluginCollectionStatus(plugin: ManagerPluginSnapshot, status: ManagerPluginStatus, locale: string): HostCollectionStatus {
  const tone = status === 'active'
    ? 'success'
    : status === 'failed' || status === 'rollback-failed'
      ? 'danger'
      : status === 'installing' || status === 'updating' || status === 'enabling' || status === 'disabling'
        || status === 'reloading' || status === 'uninstalling' || status === 'rolling-back'
        ? 'progress'
        : status === 'blocked' || status === 'permission-blocked'
          ? 'warning'
          : 'neutral'
  return { label: statusLabel(status, locale), tone, detail: pluginStatusDescription(plugin, status, locale) }
}

function safeStorage(view: Window | null): MarketplaceStorage | undefined {
  try {
    return view?.localStorage
  } catch {
    return undefined
  }
}

function normalizeManagerSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

function matchesManagerSearch(query: string, fields: readonly string[]): boolean {
  const terms = normalizeManagerSearchText(query).split(' ').filter(Boolean)
  const haystack = normalizeManagerSearchText(fields.join('\n'))
  return terms.every(term => haystack.includes(term))
}

function marketplaceTextTierLabel(tier: MarketplaceRankingExplanation['textTier']): string {
  switch (tier) {
    case 'exact-identity': return '插件标识精确命中'
    case 'exact-name': return '插件名称精确命中'
    case 'primary-prefix': return '插件标识或名称前缀命中'
    case 'all-primary-terms': return '插件标识或名称完整词项命中'
    case 'all-catalog-terms': return '目录元数据完整词项命中'
    case 'partial-catalog': return '目录元数据部分词项命中'
    case 'browse': return '无关键词浏览'
  }
}

function marketplaceRankingDescription(ranking: MarketplaceRankingExplanation): string {
  return `排序依据：${marketplaceTextTierLabel(ranking.textTier)}；官方产品优先级 +${ranking.officialPriority}。官方优先级只在同一文本相关性层级内生效；认证状态不参与排序。`
}

function marketplaceCertifiedDetailCopy(
  certification: MarketplaceCertificationRecord,
  version: string,
  chinese: boolean,
): readonly [string, string, string] {
  const policy = `${certification.reviewPolicy.id} ${certification.reviewPolicy.version}`
  return chinese
    ? [
        `CordisX 已按策略 ${policy} 审核当前 ${version} 版本的明确制品，并认定其代码符合该版本策略。新版本或制品变化后必须重新认证。`,
        '认证不是绝对安全保证，也不放宽沙箱、生命周期或安装审核。仅权限目录明确标记的界面能力可免去显式确认；Host 仍会按当前范围和运行实例创建可撤销、可审计的授权，其他权限照常确认。',
        'v1 信任根是受保护的 Marketplace 合入链；当前不声称存在制品密码学签名。',
      ]
    : [
        `CordisX reviewed the exact artifact for version ${version} under policy ${policy} and determined that its code conforms to that policy version. A new version or changed artifact requires a new certification.`,
        'Certification is not an absolute safety guarantee and does not relax sandbox, lifecycle, or installation review. Only interface capabilities explicitly marked in the permission catalog may omit explicit confirmation. The Host still creates a revocable, audited authorization for the current scope and runtime instance; every other permission prompts normally.',
        'The v1 trust root is the protected Marketplace merge chain; no cryptographic artifact signature is claimed.',
      ]
}

function activateManagerListRow(row: HTMLButtonElement, action: () => void): void {
  row.addEventListener('click', event => {
    const selection = row.ownerDocument.defaultView?.getSelection()
    if (event.detail > 0 && selection !== undefined && selection !== null && !selection.isCollapsed && selection.toString() !== ''
      && selection.anchorNode !== null && selection.focusNode !== null
      && row.contains(selection.anchorNode) && row.contains(selection.focusNode)) return
    action()
  })
  row.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    action()
  })
}

/** Keep breadcrumb identity explicit when constrained instead of clipping ancestors. */
export function projectManagerBreadcrumbs(
  itemWidths: readonly number[],
  availableWidth: number,
  overflowWidth = 42,
): BreadcrumbProjection {
  const all = itemWidths.map((_, index) => index)
  if (itemWidths.length <= 2 || availableWidth <= 0) return { visible: all, overflow: [] }
  const total = itemWidths.reduce((sum, width) => sum + Math.max(0, width), 0)
  if (total <= availableWidth) return { visible: all, overflow: [] }

  const visible = new Set<number>([0, itemWidths.length - 1])
  let used = Math.max(0, itemWidths[0] ?? 0)
    + Math.max(0, itemWidths.at(-1) ?? 0)
    + Math.max(0, overflowWidth)
  for (let index = itemWidths.length - 2; index >= 1; index -= 1) {
    const width = Math.max(0, itemWidths[index] ?? 0)
    if (used + width > availableWidth) break
    visible.add(index)
    used += width
  }
  return {
    visible: all.filter(index => visible.has(index)),
    overflow: all.filter(index => index > 0 && index < itemWidths.length - 1 && !visible.has(index)),
  }
}

interface MarketplaceBridgePayload {
  readonly requestId: string
  readonly ok: boolean
  readonly status?: number
  readonly text?: string
  readonly error?: string
}

interface MarketplaceBridgeWindow extends Window {
  __cordisxMarketplaceRequestV1?: (payload: string) => void
  __cordisxMarketplaceReceiveV1?: (payload: string) => void
}

interface MarketplaceFetcherHandle {
  readonly fetcher?: MarketplaceFetcher
  dispose(): void
}

interface PublisherGrantBridgeWindow extends Window {
  __cordisxPublisherGrantRequestV1?: (payload: string) => void
  __cordisxPublisherGrantReceiveV1?: (payload: string) => void
}
interface PublisherGrantClient { request(operation: 'challenge' | 'import' | 'status', value?: unknown): Promise<unknown>; dispose(): void }
function createPublisherGrantClient(view: Window | null): PublisherGrantClient {
  if (view === null || typeof (view as PublisherGrantBridgeWindow).__cordisxPublisherGrantRequestV1 !== 'function') {
    return { async request() { throw new Error('PublisherGrant launcher bridge is unavailable') }, dispose() {} }
  }
  const bridge = view as PublisherGrantBridgeWindow
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: number }>()
  const receiver = (payloadText: string): void => {
    try {
      const payload = JSON.parse(payloadText) as { requestId?: unknown; ok?: unknown; value?: unknown; error?: unknown }
      if (typeof payload.requestId !== 'string') return
      const request = pending.get(payload.requestId)
      if (request === undefined) return
      view.clearTimeout(request.timer); pending.delete(payload.requestId)
      if (payload.ok === true) request.resolve(payload.value)
      else request.reject(new Error(typeof payload.error === 'string' ? payload.error : 'PublisherGrant request failed'))
    } catch { /* keep pending request timeout authoritative */ }
  }
  bridge.__cordisxPublisherGrantReceiveV1 = receiver
  let sequence = 0
  return {
    async request(operation, value) {
      return await new Promise((resolve, reject) => {
        const requestId = `grant-${Date.now().toString(36)}-${(++sequence).toString(36)}`
        const timer = view.setTimeout(() => { pending.delete(requestId); reject(new Error('PublisherGrant launcher bridge timed out')) }, 12_000)
        pending.set(requestId, { resolve, reject, timer })
        try {
          bridge.__cordisxPublisherGrantRequestV1?.(JSON.stringify({ version: 1, requestId, operation, ...(operation === 'import' ? { statement: value } : operation === 'status' ? { target: value } : {}) }))
        } catch (error) { view.clearTimeout(timer); pending.delete(requestId); reject(error instanceof Error ? error : new Error(String(error))) }
      })
    },
    dispose() {
      if (bridge.__cordisxPublisherGrantReceiveV1 === receiver) delete bridge.__cordisxPublisherGrantReceiveV1
      for (const request of pending.values()) { view.clearTimeout(request.timer); request.reject(new Error('CordisX manager disposed')) }
      pending.clear()
    },
  }
}

let marketplaceRequestSequence = 0

function createMarketplaceFetcher(view: Window | null): MarketplaceFetcherHandle {
  if (view === null) return { dispose: () => {} }
  const bridge = view as MarketplaceBridgeWindow
  if (typeof bridge.__cordisxMarketplaceRequestV1 !== 'function') {
    return {
      ...(typeof view.fetch === 'function' ? { fetcher: (url: string, init: RequestInit) => view.fetch(url, init) } : {}),
      dispose: () => {},
    }
  }

  const pending = new Map<string, {
    readonly resolve: (response: { readonly ok: boolean; readonly status: number; text(): Promise<string> }) => void
    readonly reject: (error: Error) => void
    readonly cleanup: () => void
  }>()
  const receiver = (payloadText: string): void => {
    try {
      const payload = JSON.parse(payloadText) as MarketplaceBridgePayload
      const request = pending.get(payload.requestId)
      if (request === undefined) return
      request.cleanup()
      if (typeof payload.status === 'number' && typeof payload.text === 'string') {
        request.resolve({ ok: payload.ok, status: payload.status, text: async () => payload.text ?? '' })
      } else {
        request.reject(new Error(payload.error ?? 'marketplace launcher bridge failed'))
      }
    } catch {
      // Ignore malformed host messages; each pending request still has a timeout.
    }
  }
  bridge.__cordisxMarketplaceReceiveV1 = receiver

  const fetcher: MarketplaceFetcher = async (url, init) => await new Promise((resolve, reject) => {
    const requestId = `${Date.now().toString(36)}-${(++marketplaceRequestSequence).toString(36)}`
    const timeout = view.setTimeout(() => {
      pending.delete(requestId)
      reject(new Error('marketplace launcher bridge timed out'))
    }, 12_000)
    const signal = init.signal
    const abort = (): void => {
      view.clearTimeout(timeout)
      pending.delete(requestId)
      reject(new Error('marketplace launcher bridge aborted'))
    }
    const cleanup = (): void => {
      view.clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      pending.delete(requestId)
    }
    pending.set(requestId, { resolve, reject, cleanup })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted === true) {
      abort()
      return
    }
    try {
      bridge.__cordisxMarketplaceRequestV1?.(JSON.stringify({ requestId, url }))
    } catch (error) {
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })

  return {
    fetcher,
    dispose: () => {
      if (bridge.__cordisxMarketplaceReceiveV1 === receiver) delete bridge.__cordisxMarketplaceReceiveV1
      for (const request of pending.values()) {
        request.cleanup()
        request.reject(new Error('CordisX manager disposed'))
      }
      pending.clear()
    },
  }
}

/** Mount the reversible, host-owned CordisX manager UI. */
export interface ManagerInstallOptions {
  /** A host-owned trigger seat. Playground supplies this instead of probing Codex DOM. */
  readonly triggerTarget?: () => HTMLElement | undefined
}

export function installCordisXManager(
  document: Document,
  model: ManagerModel,
  options: ManagerInstallOptions = {},
): () => void {
  const theme = new HostThemeProjection(document)
  let renderedLocale = model.snapshot().localization.locale
  const copy = (key: Parameters<typeof managerCopy>[1]): string => managerCopy(renderedLocale, key)
  const ownedPortals = new Map<HTMLElement, () => void>()
  const mountPortal = <Element extends HTMLElement>(portal: Element): (() => void) => {
    const detachTheme = theme.attach(portal)
    ownedPortals.set(portal, detachTheme)
    ;(document.body ?? document.documentElement).append(portal)
    return () => {
      ownedPortals.delete(portal)
      detachTheme()
      portal.remove()
    }
  }
  document.getElementById(MANAGER_STYLE_ID)?.remove()
  const style = create(document, 'style')
  style.id = MANAGER_STYLE_ID
  style.textContent = `${lunaObjectViewerCss}\n${lunaDataGridCss}\n${lunaDomViewerCss}\n${lunaConsoleCss}\n${HOST_COLLECTION_STYLES}\n${MANAGER_STYLES}\n${HOST_THEME_OVERLAY_STYLES}`
  ;(document.head ?? document.documentElement).append(style)

  const trigger = create(document, 'button')
  trigger.type = 'button'
  trigger.dataset.cordisxManagerTrigger = 'true'
  trigger.setAttribute('aria-label', copy('manager.trigger.manage'))
  trigger.setAttribute('aria-haspopup', 'dialog')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.title = copy('manager.trigger.manage')
  const triggerMark = createAdaptiveBrandMark(document)
  trigger.append(triggerMark)

  const modal = create(document, 'div', 'cxf-scope')
  const detachModalTheme = theme.attach(modal)
  modal.dataset.cordisxManagerModal = 'true'
  modal.hidden = true
  const backdrop = create(document, 'div', 'cxm-backdrop')
  const dialog = create(document, 'section', 'cxm-dialog')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-label', copy('manager.dialog'))

  const sidebar = create(document, 'aside', 'cxm-sidebar')
  const nav = create(document, 'nav', 'cxm-nav')
  nav.setAttribute('aria-label', copy('manager.navigation'))
  const tabs: readonly { id: ManagerTab; icon?: ManagerIconToken; label: string; brand?: boolean }[] = [
    { id: 'plugins', icon: 'plugins', label: copy('manager.nav.plugins') },
    { id: 'extension-points', icon: 'contributions', label: copy('manager.nav.extension-points') },
    { id: 'routes', icon: 'routes', label: copy('manager.nav.routes') },
    { id: 'marketplace', icon: 'marketplace', label: copy('manager.nav.marketplace') },
    { id: 'about', label: copy('manager.nav.about'), brand: true },
  ]
  let routeState: ManagerRouteState = { kind: 'primary', primary: 'plugins' }
  const navigationHistory: ManagerRouteState[] = []
  const navButtons = new Map<string, HTMLButtonElement>()
  for (const tab of tabs) {
    const button = create(document, 'button', 'cxm-nav-button')
    button.type = 'button'
    button.dataset.tab = tab.id
    button.dataset.managerNavigationId = tab.id
    const icon = tab.brand === true
      ? createAdaptiveBrandMark(document)
      : createManagerIcon(document, tab.icon ?? 'plugins', 'cxm-nav-icon')
    icon.classList.add('cxm-nav-icon')
    icon.setAttribute('aria-hidden', 'true')
    button.append(icon, create(document, 'span', 'cxm-nav-label', tab.label))
    navButtons.set(tab.id, button)
    nav.append(button)
  }
  sidebar.append(nav)

  const main = create(document, 'div', 'cxm-main')
  const header = create(document, 'header', 'cxm-header')
  const heading = create(document, 'div', 'cxm-heading')
  const close = create(document, 'button', 'cxm-close')
  close.type = 'button'
  close.setAttribute('aria-label', copy('manager.close'))
  close.append(createManagerIcon(document, 'close', 'cxm-close-icon'))
  header.append(heading, close)
  const content = create(document, 'div', 'cxm-content')
  main.append(header, content)
  dialog.append(sidebar, main)
  backdrop.append(dialog)
  modal.append(backdrop)
  ;(document.body ?? document.documentElement).append(modal)

  let primaryChromeLocale: string | undefined
  const syncPrimaryChrome = (locale: string): void => {
    if (primaryChromeLocale === locale) return
    primaryChromeLocale = locale
    const labels: Readonly<Record<ManagerTab, string>> = {
      plugins: copy('manager.nav.plugins'),
      'extension-points': copy('manager.nav.extension-points'),
      routes: copy('manager.nav.routes'),
      marketplace: copy('manager.nav.marketplace'),
      settings: copy('manager.nav.plugins'),
      about: copy('manager.nav.about'),
    }
    const setAttribute = (element: Element, name: string, value: string): void => {
      if (element.getAttribute(name) !== value) element.setAttribute(name, value)
    }
    const setText = (element: Element | null, value: string): void => {
      if (element?.textContent !== value) element?.replaceChildren(value)
    }
    setAttribute(trigger, 'aria-label', copy('manager.trigger.manage'))
    if (trigger.title !== copy('manager.trigger.manage')) trigger.title = copy('manager.trigger.manage')
    setAttribute(dialog, 'aria-label', copy('manager.dialog'))
    setAttribute(nav, 'aria-label', copy('manager.navigation'))
    setAttribute(close, 'aria-label', copy('manager.close'))
    for (const [id, label] of Object.entries(labels)) {
      setText(navButtons.get(id)?.querySelector('.cxm-nav-label') ?? null, label)
    }
  }

  const localizeTabs = <T extends string>(items: readonly LocalizedTab<T>[]): readonly { readonly id: T; readonly label: string; readonly icon: LocalTabIcon }[] => (
    items.map(item => ({ id: item.id, label: copy(item.copyKey), icon: item.icon }))
  )

  const marketplaceFetcher = createMarketplaceFetcher(document.defaultView)
  const publisherGrantClient = createPublisherGrantClient(document.defaultView)
  const publisherGrantStatuses = new Map<string, string>()
  const marketplace: MarketplaceModel = new BrowserMarketplaceModel(
    safeStorage(document.defaultView),
    marketplaceFetcher.fetcher,
  )
  const tooltips = new HostTooltipController(document)
  const forms = new HostFormAdapter(document, modal, () => model.snapshot().localization.locale)
  const hostCollections = new Set<HostCollectionView>()
  const disposeHostCollections = (): void => {
    for (const view of hostCollections) view.dispose()
    hostCollections.clear()
  }
  const mountHostCollection = (
    target: HTMLElement,
    options: Parameters<typeof createHostCollection>[1],
    decorate?: (root: HTMLElement) => void,
  ): HostCollectionView => {
    const search = options.search === undefined
      ? { icon: () => createManagerIcon(document, 'search'), clearIcon: () => createManagerIcon(document, 'close') }
      : 'enabled' in options.search
        ? options.search
        : {
            icon: () => createManagerIcon(document, 'search'),
            clearIcon: () => createManagerIcon(document, 'close'),
            ...options.search,
          }
    const view = createHostCollection(document, {
      ...options,
      moreIcon: options.moreIcon ?? (() => createManagerIcon(document, 'more')),
      tooltips: options.tooltips ?? tooltips,
      attachPortalTheme: options.attachPortalTheme ?? (portal => theme.attach(portal)),
      search,
    })
    hostCollections.add(view)
    decorate?.(view.element)
    target.append(view.element)
    return view
  }
  const managerIconAction = (
    icon: ManagerIconToken,
    label: string,
    options: {
      readonly className?: string
      readonly disabled?: boolean
      readonly description?: string
      readonly pressed?: boolean
    } = {},
  ): HTMLButtonElement => {
    const button = create(document, 'button', ['cxm-manager-icon-action', options.className].filter(Boolean).join(' '))
    button.type = 'button'
    button.dataset.cordisxNoDrag = 'true'
    button.setAttribute('aria-label', label)
    if (options.description !== undefined) button.setAttribute('aria-description', options.description)
    if (options.pressed !== undefined) button.setAttribute('aria-pressed', String(options.pressed))
    button.disabled = options.disabled === true
    button.append(createManagerIcon(document, icon))
    tooltips.attach(button, () => options.description === undefined ? label : `${label} · ${options.description}`, 'top')
    return button
  }
  let pluginQuery = ''
  let marketplaceQuery = ''
  let marketplaceCertifiedOnly = false
  let marketplaceOfficialOnly = false
  let extensionPointQuery = ''
  let routeQuery = ''
  const extensionPointUsageQueries = new Map<string, string>()
  const pluginExtensionPointQueries = new Map<string, string>()
  const pluginRouteQueries = new Map<string, string>()
  const favoritePluginIds = (() => {
    try {
      const stored = JSON.parse(safeStorage(document.defaultView)?.getItem('cordisx.manager.favoritePlugins.v1') ?? '[]')
      return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [])
    } catch { return new Set<string>() }
  })()
  let consoleQuery = ''
  let consoleMethod = 'all'
  let consoleKind = 'all'
  let consoleSource = 'all'
  let consolePaused = false
  let consolePausedPage: CordisXPluginConsolePageV1 | undefined
  let selectedConsoleEntry: string | undefined
  const consoleScrollStates = new Map<string, { follow: boolean; scrollTop: number }>()
  const dismissedConsoleWarnings = new Map<string, number>()
  // Legacy tab state remains only to dispose existing compatibility mounts; no route
  // can normalize into it and no Manager navigation exposes it.
  let settingsRoot: HTMLDivElement | undefined
  let settingsPanel: HTMLDivElement | undefined
  let settingsPanelBody: HTMLDivElement | undefined
  let settingsMount: ManagedSettingsPageMount | undefined
  let settingsMountId: string | undefined
  let settingsTransition = 0
  let settingsTransitioning = false
  let settingsError: string | undefined
  let managerContentMount: ManagedManagerPageMount | undefined
  let managerContentMountId: string | undefined
  let managerContentRoot: HTMLDivElement | undefined
  let managerContentTransition = 0
  let managerContentTransitioning = false
  let managerContentError: string | undefined
  const listScrollPositions = new Map<string, number>()
  let busyPluginId: string | undefined
  let operationError: string | undefined
  const configDrafts = new Map<string, {
    baseRevision: number
    readonly values: Map<string, unknown>
    readonly operations: Map<string, ConfigMutationOperation>
    readonly issues: Map<string, string>
    state: 'pristine' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error'
    message?: string
  }>()
  let sourceOperationError: string | undefined
  let sourceOperationDiagnostic: string | undefined
  let sourceOperationNotice: string | undefined
  let sourcesBusy = false
  let sourceQuery = ''
  let marketplaceCollectionView: HostCollectionView | undefined
  const lifecycleBusy = new Map<string, ManagerPluginStatus>()
  let lifecycleInstallBusy = false
  const configRendererMounts = new Set<ConfigRendererMountHandle>()
  const configFieldActionMenus = new Set<{ dispose(): void }>()
  const lunaConsoleMounts = new Set<{
    readonly destroy: () => void
    readonly setTheme: (theme: 'dark' | 'light') => void
  }>()
  let breadcrumbCleanup = (): void => {}
  let closePluginActionMenu = (_restoreFocus = false): void => {}
  let pluginActionMenuOpen = false
  let pluginActionMenuContainsEvent = (_event: Event): boolean => false
  let repositionPluginActionMenu = (): void => {}
  let pendingPluginMenuFocus: string | undefined
  let pendingPluginActionFocus: { readonly pluginId: string; readonly actionId: string } | undefined

  const disposeConfigRenderers = (): void => {
    for (const mount of configRendererMounts) void mount.dispose()
    configRendererMounts.clear()
  }

  const disposeConfigFieldActionMenus = (): void => {
    for (const menu of configFieldActionMenus) menu.dispose()
    configFieldActionMenus.clear()
  }

  const disposeLunaConsoles = (): void => {
    for (const mount of lunaConsoleMounts) mount.destroy()
    lunaConsoleMounts.clear()
  }

  const syncHostUiTheme = (): void => {
    const current = resolveHostTheme(document).theme
    syncAdaptiveBrandMarks(document)
    for (const mount of lunaConsoleMounts) mount.setTheme(current)
  }

  const authorizeAndRestore = async (plugin: ManagerPluginSnapshot): Promise<void> => {
    const createPlanV2 = model.permissionAuthorizationPlanV2
    const authorizeV2 = model.authorizePluginV2
    const permissions = model.snapshot().permissions.filter(item => (
      item.identity.source === plugin.source && item.identity.id === plugin.id
    ))
    const planV2 = createPlanV2?.(plugin.id)
    if (planV2 !== undefined) {
      if (authorizeV2 === undefined) throw new Error('插件 V2 授权服务当前不可用，未恢复插件')
      const decision = await requestPluginAuthorizationV2(document, plugin, planV2, permissions)
      if (decision !== undefined) await authorizeV2(plugin.id, decision)
      return
    }
    const createPlan = model.permissionAuthorizationPlan
    const authorize = model.authorizePlugin
    if (createPlan === undefined || authorize === undefined) {
      throw new Error('插件授权服务当前不可用，未恢复插件')
    }
    const plan = createPlan(plugin.id)
    const decision = await requestPluginAuthorization(document, plugin, plan, permissions)
    if (decision === undefined) return
    await authorize(plugin.id, decision)
  }

  const hideForExternalNavigation = (): void => {
    disposeHostCollections()
    if (managerContentMount !== undefined || managerContentMountId !== undefined) void resetManagerContent().catch(() => {})
    modal.hidden = true
    trigger.setAttribute('aria-expanded', 'false')
  }

  const configureExternalLink = <T extends HTMLAnchorElement>(link: T, href: string): T => {
    link.href = href
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.addEventListener('click', hideForExternalNavigation)
    return link
  }

  const documentationLink = (label: string, href: string): HTMLAnchorElement => {
    const link = configureExternalLink(create(document, 'a', 'cxm-action'), href)
    link.append(create(document, 'span', undefined, label), createManagerIcon(document, 'external-link', 'cxm-action-icon'))
    return link
  }

  const favoriteStorageKey = (snapshot: ManagerSnapshot): string => (
    `cordisx.manager.favoritePlugins.v1:${snapshot.pluginLifecycle?.profileId ?? 'development'}`
  )

  const favoritePlugins = (snapshot: ManagerSnapshot): Set<string> => {
    try {
      const value = safeStorage(document.defaultView)?.getItem(favoriteStorageKey(snapshot))
      if (value === null || value === undefined) return new Set()
      const parsed = JSON.parse(value) as unknown
      return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [])
    } catch {
      return new Set()
    }
  }

  const setFavorite = (snapshot: ManagerSnapshot, pluginId: string, favorite: boolean): void => {
    const next = favoritePlugins(snapshot)
    if (favorite) next.add(pluginId)
    else next.delete(pluginId)
    try { safeStorage(document.defaultView)?.setItem(favoriteStorageKey(snapshot), JSON.stringify([...next].sort())) } catch {}
  }

  const requestLifecycleConfirmation = (
    title: string,
    description: string,
    affectedPluginIds: readonly string[],
    confirmLabel: string,
    danger = false,
  ): Promise<boolean> => new Promise(resolve => {
    const overlay = create(document, 'div', 'cxm-lifecycle-overlay')
    let unmountOverlay = (): void => {}
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    const panel = create(document, 'div', 'cxm-lifecycle-dialog')
    const heading = create(document, 'h2', undefined, title)
    panel.append(heading, create(document, 'p', undefined, description))
    if (affectedPluginIds.length > 0) {
      panel.append(create(document, 'div', 'cxm-lifecycle-impact', `影响插件：${affectedPluginIds.join('、')}`))
    }
    const actions = create(document, 'div', 'cxm-lifecycle-actions')
    const finish = (confirmed: boolean): void => {
      unmountOverlay()
      resolve(confirmed)
    }
    panel.classList.add('cxf-scope')
    const cancel = forms.button('取消')
    cancel.addEventListener('click', () => finish(false), { once: true })
    const confirm = forms.button(confirmLabel, { variant: danger ? 'default' : 'primary', tone: danger ? 'danger' : 'default' })
    confirm.addEventListener('click', () => finish(true), { once: true })
    overlay.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      finish(false)
    })
    actions.append(cancel, confirm)
    panel.append(actions)
    overlay.append(panel)
    unmountOverlay = mountPortal(overlay)
    cancel.focus()
  })

  const requestLocalPackageDirectory = (invoker?: HTMLElement): Promise<string | undefined> => new Promise(resolve => {
    const overlay = create(document, 'div', 'cxm-lifecycle-overlay')
    const HTMLElementCtor = document.defaultView?.HTMLElement
    const returnFocus = invoker ?? (HTMLElementCtor !== undefined && document.activeElement instanceof HTMLElementCtor
        ? document.activeElement
        : undefined)
    let unmountOverlay = (): void => {}
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    const panel = create(document, 'div', 'cxm-lifecycle-dialog cxm-local-import-dialog')
    panel.classList.add('cxf-scope')
    const header = create(document, 'div', 'cxm-lifecycle-header')
    const heading = create(document, 'h2', undefined, '导入本地插件')
    heading.id = 'cxm-local-package-directory-heading'
    overlay.setAttribute('aria-labelledby', heading.id)
    const close = managerIconAction('close', '关闭')
    close.dataset.importLocalClose = 'true'
    header.append(heading, close)
    // The Host overlay title plus the labelled directory control already
    // explains this bounded operation. Do not add a second title/CTA shell.
    panel.append(header)
    const form = forms.form('local-package-directory')
    form.classList.add('cxm-local-import-form')
    const field = create(document, 'div', 'cxm-local-import-field')
    const label = create(document, 'label', 'cxf-label', '插件目录')
    label.id = 'cxm-local-package-directory-label'
    label.htmlFor = 'cxm-local-package-directory'
    const error = create(document, 'p', 'cxm-local-import-error')
    error.id = 'cxm-local-package-directory-error'
    error.setAttribute('role', 'alert')
    error.hidden = true
    let pathValue = ''
    let inspect: TDesignButtonElement | undefined
    const validPath = (value: string): boolean => value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value)
    const updatePath = (value: string): void => {
      pathValue = value.trim()
      const message = pathValue === '' ? undefined : validPath(pathValue) ? undefined : '请选择目录或输入绝对路径'
      error.textContent = message ?? ''
      error.hidden = message === undefined
      field.dataset.invalid = String(!error.hidden)
      if (error.hidden) control?.focusTarget?.removeAttribute('aria-invalid')
      else control?.focusTarget?.setAttribute('aria-invalid', 'true')
      if (inspect !== undefined) setTDesignDisabled(inspect, !validPath(pathValue))
    }
    const pathField: CordisXConfigFieldSnapshot = {
      namespace: 'cordisx.host', path: ['localPackageDirectory'], type: 'string', role: 'directory', value: '', disabled: false, required: true,
    }
    const control = forms.control(pathField, 'cxm-local-package-directory', value => {
      updatePath(typeof value === 'string' ? value : '')
    })
    control.focusTarget?.setAttribute('aria-labelledby', label.id)
    control.focusTarget?.setAttribute('aria-describedby', error.id)
    control.focusTarget?.setAttribute('data-import-local-path', '')
    const directoryControl = create(document, 'div', 'cxm-directory-control')
    const picker = create(document, 'input', 'cxm-visually-hidden')
    picker.type = 'file'
    picker.tabIndex = -1
    picker.setAttribute('webkitdirectory', '')
    picker.setAttribute('directory', '')
    picker.dataset.importLocalPicker = 'true'
    const choose = managerIconAction('import-plugin', '选择插件目录', { className: 'cxm-directory-picker' })
    choose.dataset.importLocalChoose = 'true'
    choose.addEventListener('click', () => picker.click())
    picker.addEventListener('change', () => {
      const file = picker.files?.[0] as (File & { readonly path?: string }) | undefined
      const filePath = file?.path
      const relative = file?.webkitRelativePath
      if (filePath === undefined || relative === undefined || relative === '') {
        pathValue = ''
        setTDesignProps(control.focusTarget as TDesignElement, { value: '', defaultValue: '' })
        error.textContent = '当前环境无法读取目录路径，请粘贴绝对路径'
        error.hidden = false
        field.dataset.invalid = 'true'
        control.focusTarget?.setAttribute('aria-invalid', 'true')
        if (inspect !== undefined) setTDesignDisabled(inspect, true)
        control.focusTarget?.focus()
        return
      }
      const separator = filePath.includes('\\') ? '\\' : '/'
      const relativePath = relative.replaceAll('/', separator)
      const rootName = relative.split('/')[0] ?? ''
      const root = filePath.endsWith(relativePath)
        ? `${filePath.slice(0, -relativePath.length)}${rootName}`
        : filePath.slice(0, Math.max(filePath.lastIndexOf(separator), 0))
      setTDesignProps(control.focusTarget as TDesignElement, { value: root })
      ;(control.focusTarget as TDesignElement & { onChange?: (value: string) => void }).onChange?.(root)
      updatePath(root)
      control.focusTarget?.focus()
    })
    directoryControl.append(control.root, choose)
    field.append(label, directoryControl, picker, error)
    const actions = create(document, 'div', 'cxf-actions cxm-local-import-actions')
    const restoreInvokerFocus = (): void => {
      const currentInvoker = invoker?.isConnected === true
        ? invoker
        : document.querySelector<HTMLElement>('[data-import-local-plugin]')
      ;(currentInvoker ?? returnFocus)?.focus({ preventScroll: true })
    }
    const finish = (value?: string): void => {
      unmountOverlay()
      restoreInvokerFocus()
      resolve(value)
      document.defaultView?.setTimeout(() => {
        restoreInvokerFocus()
      }, 0)
    }
    close.addEventListener('click', () => finish(), { once: true })
    const cancel = forms.button('取消')
    cancel.addEventListener('click', () => finish(), { once: true })
    inspect = forms.button('检查并导入', { type: 'submit', variant: 'primary' })
    setTDesignDisabled(inspect, true)
    inspect.setAttribute('data-import-local-submit', '')
    form.addEventListener('submit', event => {
      event.preventDefault()
      if (!validPath(pathValue)) {
        error.textContent = pathValue === '' ? '请选择插件目录' : '请选择目录或输入绝对路径'
        error.hidden = false
        field.dataset.invalid = 'true'
        control.focusTarget?.setAttribute('aria-invalid', 'true')
        control.focusTarget?.focus()
        return
      }
      finish(pathValue)
    })
    form.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        finish()
      }
    })
    actions.append(cancel, inspect)
    form.append(field, actions)
    panel.append(form)
    overlay.append(panel)
    unmountOverlay = mountPortal(overlay)
    control.focusTarget?.focus()
  })

  const lifecycleFailure = (result: CordisXPluginLifecycleResultV1): Error | undefined => {
    if (result.outcome === 'applied' || result.outcome === 'planned') return undefined
    return new Error(result.error?.message ?? `插件操作未完成：${result.outcome}`)
  }

  const requestLifecycle = async (
    operation: CordisXPluginLifecycleOperationV1,
  ): Promise<CordisXPluginLifecycleResultV1> => {
    if (model.requestPluginLifecycle === undefined) throw new Error('当前 launcher 未提供插件生命周期服务')
    const result = await model.requestPluginLifecycle(operation)
    const failure = lifecycleFailure(result)
    if (failure !== undefined) throw failure
    return result
  }

  const runLocalPackageInstall = async (invoker?: HTMLElement): Promise<void> => {
    const sourceDirectory = await requestLocalPackageDirectory(invoker)
    if (sourceDirectory === undefined) return
    lifecycleInstallBusy = true
    operationError = undefined
    renderContent()
    let packageId: string | undefined
    try {
      const inspection = await requestLifecycle({ kind: 'inspect-local', sourceDirectory })
      if (inspection.outcome !== 'planned'
        || inspection.candidateId === undefined
        || inspection.package === undefined
        || (inspection.operation !== 'install' && inspection.operation !== 'update')) {
        throw new Error('本地包检查没有返回可应用的候选版本')
      }
      packageId = inspection.package.id
      lifecycleBusy.set(packageId, inspection.operation === 'install' ? 'installing' : 'updating')
      renderContent()
      const reviewTarget = {
        kind: 'candidate',
        candidateId: inspection.candidateId,
      } as const
      const planV4 = await model.permissionLifecycleReviewPlanV4?.(reviewTarget)
      const planV2 = planV4 === undefined ? await model.permissionLifecycleReviewPlanV2?.(reviewTarget) : undefined
      let applied: CordisXPluginLifecycleResultV1
      if (planV4 !== undefined) {
        if (model.applyPermissionLifecycleReviewV4 === undefined) throw new Error('安装权限 V4 服务不可用')
        const decision = await requestPluginAuthorizationV4(
          document,
          {
            id: inspection.package.id,
            source: planV4.identity.source,
            name: inspection.package.name ?? inspection.package.id,
          },
          planV4,
          model.snapshot().permissions.filter(item => (
            item.identity.id === inspection.package!.id && item.identity.source === planV4.identity.source
          )),
        )
        if (decision === undefined) return
        applied = await model.applyPermissionLifecycleReviewV4(decision)
      } else if (planV2 !== undefined) {
        if (model.applyPermissionLifecycleReviewV2 === undefined) throw new Error('安装权限 V2 服务不可用')
        const decision = await requestPluginAuthorizationV2(
          document,
          {
            id: inspection.package.id,
            source: planV2.identity.source,
            name: inspection.package.name ?? inspection.package.id,
          },
          planV2,
          model.snapshot().permissions.filter(item => (
            item.identity.id === inspection.package!.id && item.identity.source === planV2.identity.source
          )),
        )
        if (decision === undefined) return
        applied = await model.applyPermissionLifecycleReviewV2(decision)
      } else {
        if (inspection.authorizationPlan === undefined) throw new Error('本地包检查没有返回可应用的授权计划')
        const decision = await requestPluginAuthorization(
          document,
          { id: inspection.package.id, name: inspection.package.name ?? inspection.package.id },
          inspection.authorizationPlan,
          model.snapshot().permissions.filter(item => (
            item.identity.id === inspection.package!.id
            && item.identity.source === inspection.authorizationPlan!.identity.source
          )),
        )
        if (decision === undefined) return
        applied = await requestLifecycle({
          kind: inspection.operation,
          candidateId: inspection.candidateId,
          authorizationDecision: decision,
        })
      }
      if (applied.outcome !== 'applied') throw new Error('插件候选版本没有激活')
    } catch (error) {
      operationError = error instanceof Error ? error.message : String(error)
    } finally {
      lifecycleInstallBusy = false
      if (packageId !== undefined) lifecycleBusy.delete(packageId)
      renderContent()
    }
  }

  const runPluginLifecycle = async (
    snapshot: ManagerSnapshot,
    plugin: ManagerPluginSnapshot,
    operation: 'enable' | 'disable' | 'reload' | 'uninstall',
    restoreMenuFocus = false,
  ): Promise<void> => {
    const busyStatus: Readonly<Record<typeof operation, ManagerPluginStatus>> = {
      enable: 'enabling',
      disable: 'disabling',
      reload: 'reloading',
      uninstall: 'uninstalling',
    }
    lifecycleBusy.set(plugin.id, busyStatus[operation])
    operationError = undefined
    if (restoreMenuFocus) pendingPluginMenuFocus = plugin.id
    renderContent()
    try {
      if (operation === 'reload') {
        const result = await requestLifecycle({ kind: 'reload', pluginId: plugin.id })
        if (result.outcome !== 'applied') throw new Error('插件没有完成重载')
        return
      }
      if (operation === 'enable') {
        const plan = await requestLifecycle({ kind: 'enable', pluginId: plugin.id })
        if (plan.outcome === 'applied') return
        if (plan.outcome !== 'planned') throw new Error('插件启用计划不可用')
        const reviewTarget = { kind: 'enable', pluginId: plugin.id } as const
        const planV4 = await model.permissionLifecycleReviewPlanV4?.(reviewTarget)
        const planV2 = planV4 === undefined ? await model.permissionLifecycleReviewPlanV2?.(reviewTarget) : undefined
        let result: CordisXPluginLifecycleResultV1
        if (planV4 !== undefined) {
          if (model.applyPermissionLifecycleReviewV4 === undefined) throw new Error('启用权限 V4 服务不可用')
          const decision = await requestPluginAuthorizationV4(
            document,
            plugin,
            planV4,
            snapshot.permissions.filter(item => item.identity.id === plugin.id && item.identity.source === plugin.source),
          )
          if (decision === undefined) return
          result = await model.applyPermissionLifecycleReviewV4(decision)
        } else if (planV2 !== undefined) {
          if (model.applyPermissionLifecycleReviewV2 === undefined) throw new Error('启用权限 V2 服务不可用')
          const decision = await requestPluginAuthorizationV2(
            document,
            plugin,
            planV2,
            snapshot.permissions.filter(item => item.identity.id === plugin.id && item.identity.source === plugin.source),
          )
          if (decision === undefined) return
          result = await model.applyPermissionLifecycleReviewV2(decision)
        } else {
          if (plan.authorizationPlan === undefined) throw new Error('插件启用授权计划不可用')
          const decision = await requestPluginAuthorization(
            document,
            plugin,
            plan.authorizationPlan,
            snapshot.permissions.filter(item => item.identity.id === plugin.id && item.identity.source === plugin.source),
          )
          if (decision === undefined) return
          result = await requestLifecycle({ kind: 'enable', pluginId: plugin.id, authorizationDecision: decision })
        }
        if (result.outcome !== 'applied') throw new Error('插件没有完成启用')
        return
      }
      const planned = await requestLifecycle({ kind: operation, pluginId: plugin.id, impactToken: '' })
      if (planned.outcome !== 'planned' || planned.impactToken === undefined) throw new Error('插件影响计划不可用')
      const confirmed = await requestLifecycleConfirmation(
        operation === 'uninstall' ? `卸载 ${plugin.name}` : `禁用 ${plugin.name}`,
        operation === 'uninstall'
          ? '卸载会停止新调用，清理目标及其依赖闭包拥有的服务、页面、路由、命令、界面和订阅，并删除激活记录；包文件会延迟回收。'
          : '禁用会停止目标插件及依赖它的插件，但不会删除已安装包。',
        planned.affectedPluginIds,
        operation === 'uninstall' ? '确认卸载' : '确认禁用',
        operation === 'uninstall',
      )
      if (!confirmed) return
      const result = await requestLifecycle({ kind: operation, pluginId: plugin.id, impactToken: planned.impactToken })
      if (result.outcome !== 'applied') throw new Error(`插件没有完成${operation === 'uninstall' ? '卸载' : '禁用'}`)
    } catch (error) {
      operationError = error instanceof Error ? error.message : String(error)
    } finally {
      lifecycleBusy.delete(plugin.id)
      if (restoreMenuFocus) pendingPluginMenuFocus = plugin.id
      renderContent()
    }
  }

  const sharePlugin = async (plugin: ManagerPluginSnapshot): Promise<void> => {
    const url = publicCanonicalSource(plugin)
    if (url === undefined) return
    const navigator = document.defaultView?.navigator as Navigator & {
      share?: (data: ShareData) => Promise<void>
      clipboard?: { writeText(value: string): Promise<void> }
    }
    if (typeof navigator?.share === 'function') {
      await navigator.share({ title: plugin.name, url })
      return
    }
    if (typeof navigator?.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(url)
      return
    }
    document.defaultView?.prompt('复制插件公开来源地址', url)
  }

  const publicCanonicalSource = (plugin: ManagerPluginSnapshot): string | undefined => {
    const source = plugin.package?.canonicalSource
    if (source === undefined) return undefined
    try {
      const url = new URL(source)
      return url.protocol === 'https:' ? url.href : undefined
    } catch {
      return undefined
    }
  }

  const packageOperationUnavailableReason = (
    snapshot: ManagerSnapshot,
    plugin: ManagerPluginSnapshot,
  ): string | undefined => {
    if (plugin.package === undefined) return '此插件未由 Package Store generation 管理'
    if (snapshot.pluginLifecycle?.operationsAvailable !== true) return '当前 launcher 未提供插件生命周期服务'
    if (model.requestPluginLifecycle === undefined) return '当前 renderer 未连接插件生命周期服务'
    return undefined
  }

  const sourceUnavailableReason = (plugin: ManagerPluginSnapshot): string | undefined => {
    if (plugin.package?.canonicalSource === undefined) return 'Package Store 未提供公开 canonical HTTPS 来源'
    if (publicCanonicalSource(plugin) === undefined) return 'Package Store 的 canonical 来源不是公开 HTTPS 地址'
    return undefined
  }

  const openPluginSource = (plugin: ManagerPluginSnapshot): void => {
    const url = publicCanonicalSource(plugin)
    if (url === undefined) return
    document.defaultView?.open(url, '_blank', 'noopener,noreferrer')
  }

  const activePrimary = (route: ManagerRouteState = routeState): string => {
    if (route.kind === 'primary') return route.primary
    if (route.kind === 'manager-content') return `manager-content:${route.id}`
    if (route.kind === 'plugin' || route.kind === 'permission') return 'plugins'
    if (route.kind === 'extension-point') return 'extension-points'
    if (route.kind === 'route' || route.kind === 'page') return 'routes'
    if (route.kind === 'marketplace' || route.kind === 'marketplace-source') return 'marketplace'
    return 'plugins'
  }

  const currentSettingsTab = (): string => routeState.kind === 'settings'
    ? routeState.tabId
    : MANAGER_SETTINGS_FALLBACK

  const settingsNavigationItems = (snapshot: ManagerSnapshot): readonly ManagerSettingsNavigationItemSnapshot[] => (
    sortManagerSettingsNavigationItems(snapshot.settingsNavigationItems ?? [])
  )

  const pluginFacet = (id: PluginDetailTab): ReturnType<typeof localizeTabs>[number] => (
    localizeTabs(PLUGIN_DETAIL_TABS).find(item => item.id === id) ?? localizeTabs(PLUGIN_DETAIL_TABS)[0]!
  )
  const extensionPointFacet = (id: ExtensionPointDetailTab): ReturnType<typeof localizeTabs>[number] => (
    localizeTabs(EXTENSION_POINT_DETAIL_TABS).find(item => item.id === id) ?? localizeTabs(EXTENSION_POINT_DETAIL_TABS)[0]!
  )
  const marketplaceFacet = (id: MarketplaceDetailTab): ReturnType<typeof localizeTabs>[number] => (
    localizeTabs(MARKETPLACE_DETAIL_TABS).find(item => item.id === id) ?? localizeTabs(MARKETPLACE_DETAIL_TABS)[0]!
  )

  const resolvePageRoute = (snapshot: ManagerSnapshot): ManagerPageRoute => {
    const route = routeState
    const primary = activePrimary()
    const primaryLabels: Readonly<Record<ManagerTab, string>> = {
      plugins: copy('manager.nav.plugins'),
      'extension-points': copy('manager.nav.extension-points'),
      routes: copy('manager.nav.routes'),
      marketplace: copy('manager.nav.marketplace'),
      settings: copy('manager.nav.plugins'),
      about: copy('manager.nav.about'),
    }
    const root = (id: ManagerTab): ManagerBreadcrumbSegment => ({
      id: `primary:${id}`,
      label: primaryLabels[id],
      target: { kind: 'primary', primary: id },
    })
    if (route.kind === 'primary') {
      return {
        id: `primary:${route.primary}`,
        primary,
        segments: [{ id: `primary:${route.primary}`, label: primaryLabels[route.primary] }],
      }
    }
    if (route.kind === 'plugin') {
      const plugin = snapshot.plugins.find(item => item.id === route.pluginId)
      const facet = pluginFacet(route.facet)
      return {
        id: `plugin:${route.pluginId}:${route.facet}`,
        primary,
        segments: [
          root('plugins'),
          { id: `plugin:${route.pluginId}`, label: plugin?.name ?? route.pluginId, target: { kind: 'plugin', pluginId: route.pluginId, facet: 'readme' } },
          { id: `plugin:${route.pluginId}:facet:${route.facet}`, label: facet.label },
        ],
      }
    }
    if (route.kind === 'permission') {
      const plugin = snapshot.plugins.find(item => item.id === route.pluginId)
      return {
        id: `plugin:${route.pluginId}:permission:${route.fingerprint}`,
        primary,
        segments: [
          root('plugins'),
          { id: `plugin:${route.pluginId}`, label: plugin?.name ?? route.pluginId, target: { kind: 'plugin', pluginId: route.pluginId, facet: 'readme' } },
          { id: `plugin:${route.pluginId}:facet:permissions`, label: pluginFacet('permissions').label, target: { kind: 'plugin', pluginId: route.pluginId, facet: 'permissions' } },
          { id: `plugin:${route.pluginId}:permission:${route.fingerprint}`, label: capabilityPresentation(route.capability).name },
        ],
      }
    }
    if (route.kind === 'extension-point') {
      const point = snapshot.extensionPoints?.points.find(item => item.id === route.pointId)
      const facet = extensionPointFacet(route.facet)
      return {
        id: `extension-point:${route.pointId}:${route.facet}`,
        primary,
        segments: [
          root('extension-points'),
          { id: `extension-point:${route.pointId}`, label: point?.titleProjection.text ?? route.pointId, target: { kind: 'extension-point', pointId: route.pointId, facet: 'usage' } },
          { id: `extension-point:${route.pointId}:facet:${route.facet}`, label: facet.label },
        ],
      }
    }
    if (route.kind === 'route') {
      const routeSnapshot = snapshot.navigation.routes.find(item => item.qualifiedId === route.qualifiedId)
      return {
        id: `route:${route.qualifiedId}`,
        primary,
        segments: [root('routes'), {
          id: `route:${route.qualifiedId}`,
          label: routeSnapshot?.productMetadata.title ?? route.qualifiedId,
        }],
      }
    }
    if (route.kind === 'page') {
      const page = snapshot.navigation.pages.find(item => item.qualifiedId === route.qualifiedId)
      return {
        id: `page:${route.qualifiedId}`,
        primary,
        segments: [root('routes'), {
          id: `page:${route.qualifiedId}`,
          label: page?.productMetadata.title ?? route.qualifiedId,
        }],
      }
    }
    if (route.kind === 'marketplace') {
      const plugin = marketplace.snapshot().plugins.find(item => item.identity === route.identity)
      const projection = plugin === undefined ? undefined : projectMarketplacePlugin(plugin, snapshot.localization.locale)
      const facet = marketplaceFacet(route.facet)
      return {
        id: `marketplace:${route.identity}:${route.facet}`,
        primary,
        segments: [
          root('marketplace'),
          { id: `marketplace:${route.identity}`, label: projection?.name ?? '已移除的插件', target: { kind: 'marketplace', identity: route.identity, facet: 'overview' } },
          { id: `marketplace:${route.identity}:facet:${route.facet}`, label: facet.label },
        ],
      }
    }
    if (route.kind === 'marketplace-source') {
      const source = route.url === undefined
        ? undefined
        : marketplace.snapshot().sourceStates.find(item => item.url === route.url)
      const projection = source === undefined ? undefined : projectMarketplaceSource(source, snapshot.localization.locale)
      const sourceRoot: ManagerBreadcrumbSegment = {
        id: 'marketplace-sources',
        label: managerCopy(snapshot.localization.locale, 'marketplace.source.index-heading'),
        target: { kind: 'marketplace-source', page: 'index' },
      }
      if (route.page === 'index') {
        return {
          id: 'marketplace-sources',
          primary,
          segments: [root('marketplace'), { id: sourceRoot.id, label: sourceRoot.label }],
        }
      }
      if (route.page === 'create') {
        return {
          id: 'marketplace-source:create',
          primary,
          segments: [root('marketplace'), sourceRoot, { id: 'marketplace-source:create', label: managerCopy(snapshot.localization.locale, 'marketplace.source.create') }],
        }
      }
      return {
        id: `marketplace-source:edit:${route.url ?? ''}`,
        primary,
        segments: [
          root('marketplace'),
          sourceRoot,
          { id: `marketplace-source:edit:${route.url ?? ''}`, label: projection?.name ?? managerCopy(snapshot.localization.locale, 'marketplace.source.edit-heading') },
        ],
      }
    }
    if (route.kind === 'manager-content') {
      const item = settingsNavigationItems(snapshot).find(candidate => candidate.id === route.id)
      const projection = model.managerContentPresentation?.(route.id, route.reference)
      return {
        id: `manager-content:${route.id}:${route.reference.id}`,
        primary,
        segments: [
          root('plugins'),
          { id: `manager-content:${route.id}`, label: item?.pageTitle ?? route.id, target: { kind: 'manager-content', id: route.id, reference: item?.route ?? route.reference } },
          ...(projection?.parent === undefined ? [] : [{ id: `manager-content:${route.id}:${route.reference.id}`, label: projection.title }]),
        ],
      }
    }
    return { id: 'plugins', primary: 'plugins', segments: [{ id: 'primary:plugins', label: primaryLabels.plugins }] }
  }

  const normalizeRoute = (snapshot: ManagerSnapshot, candidate: ManagerRouteState = routeState): ManagerRouteState => {
    if (candidate.kind === 'plugin' || candidate.kind === 'permission') {
      const plugin = snapshot.plugins.find(item => item.id === candidate.pluginId)
      if (plugin === undefined) return { kind: 'primary', primary: 'plugins' }
      if (candidate.kind === 'permission') {
        const declared = snapshot.permissions.some(item => (
          item.identity.id === plugin.id
          && item.identity.source === plugin.source
          && item.capability === candidate.capability
        ))
        if (!declared) return { kind: 'plugin', pluginId: plugin.id, facet: 'permissions' }
      }
    }
    if (candidate.kind === 'extension-point' && !snapshot.extensionPoints?.points.some(item => item.id === candidate.pointId)) {
      return { kind: 'primary', primary: 'extension-points' }
    }
    if (candidate.kind === 'route' && !snapshot.navigation.routes.some(item => item.qualifiedId === candidate.qualifiedId)) {
      return { kind: 'primary', primary: 'routes' }
    }
    if (candidate.kind === 'page' && !snapshot.navigation.pages.some(item => item.qualifiedId === candidate.qualifiedId)) {
      return { kind: 'primary', primary: 'routes' }
    }
    if (candidate.kind === 'marketplace') {
      const marketplaceSnapshot = marketplace.snapshot()
      if (!marketplaceSnapshot.loading && !marketplaceSnapshot.plugins.some(item => item.identity === candidate.identity)) {
        return { kind: 'primary', primary: 'marketplace' }
      }
    }
    if (candidate.kind === 'marketplace-source') {
      if (candidate.page === 'edit') {
        if (candidate.url === undefined || !marketplace.snapshot().sourceRecords.some(item => item.url === candidate.url)) {
          return { kind: 'marketplace-source', page: 'index' }
        }
      } else if (candidate.url !== undefined) {
        return { kind: 'marketplace-source', page: candidate.page }
      }
    }
    if (candidate.kind === 'settings') return { kind: 'primary', primary: 'plugins' }
    if (candidate.kind === 'manager-content'
      && (!settingsNavigationItems(snapshot).some(item => item.id === candidate.id)
        || (model.managerContentPresentation !== undefined
          && model.managerContentPresentation(candidate.id, candidate.reference) === undefined))) {
      return { kind: 'primary', primary: 'plugins' }
    }
    return candidate
  }

  const routeKey = (route: ManagerRouteState): string => JSON.stringify(route)

  const renderBreadcrumbs = (route: ManagerPageRoute): HTMLElement => {
    breadcrumbCleanup()
    breadcrumbCleanup = () => {}
    const breadcrumbs = create(document, 'nav', 'cxm-breadcrumbs')
    breadcrumbs.setAttribute('aria-label', '面包屑')
    breadcrumbs.dataset.managerPageRoute = route.id
    const list = create(document, 'ol', 'cxm-breadcrumb-list')
    breadcrumbs.append(list)

    const renderProjection = (projection: BreadcrumbProjection): void => {
      list.replaceChildren()
      breadcrumbs.dataset.breadcrumbOverflowCount = String(projection.overflow.length)
      const visible = new Set(projection.visible)
      const firstOverflow = projection.overflow[0]
      const appendSeparator = (item: HTMLElement): void => {
        if (list.childElementCount > 0) item.append(create(document, 'span', 'cxm-breadcrumb-separator', '/'))
      }
      for (const [index, segment] of route.segments.entries()) {
        if (index === firstOverflow) {
          const item = create(document, 'li', 'cxm-breadcrumb-item')
          appendSeparator(item)
          const overflow = create(document, 'details', 'cxm-breadcrumb-overflow')
          const summary = create(document, 'summary', undefined, '…')
          summary.setAttribute('aria-label', '显示省略的上级页面')
          const menu = create(document, 'div', 'cxm-breadcrumb-menu')
          menu.setAttribute('role', 'menu')
          for (const hiddenIndex of projection.overflow) {
            const hidden = route.segments[hiddenIndex]
            if (hidden?.target === undefined) continue
            const action = create(document, 'button', 'cxm-breadcrumb-action', hidden.label)
            action.type = 'button'
            action.dataset.breadcrumbTarget = hidden.id
            action.setAttribute('role', 'menuitem')
            action.addEventListener('click', () => {
              overflow.open = false
              void navigateRoute(hidden.target!)
            })
            menu.append(action)
          }
          overflow.append(summary, menu)
          item.append(overflow)
          list.append(item)
        }
        if (!visible.has(index)) continue
        const item = create(document, 'li', 'cxm-breadcrumb-item')
        item.dataset.breadcrumbIndex = String(index)
        appendSeparator(item)
        if (index === route.segments.length - 1) {
          const current = create(document, 'span', 'cxm-breadcrumb-current', segment.label)
          current.dataset.breadcrumbCurrent = segment.id
          current.setAttribute('aria-current', 'page')
          item.append(current)
        } else if (segment.target !== undefined) {
          const action = create(document, 'button', 'cxm-breadcrumb-action', segment.label)
          action.type = 'button'
          action.dataset.breadcrumbTarget = segment.id
          action.addEventListener('click', () => { void navigateRoute(segment.target!) })
          item.append(action)
        }
        list.append(item)
      }
    }

    const full: BreadcrumbProjection = { visible: route.segments.map((_, index) => index), overflow: [] }
    renderProjection(full)
    const view = document.defaultView
    const recalculate = (): void => {
      if (!breadcrumbs.isConnected || breadcrumbs.clientWidth <= 0) return
      renderProjection(full)
      const widths = route.segments.map((_, index) => {
        const item = list.querySelector<HTMLElement>(`[data-breadcrumb-index="${index}"]`)
        if (item === null) return 0
        // The current item fills free flex space, so its outer rectangle is
        // not its content width. Project from its label and separator instead:
        // a comfortable header keeps every segment, while only real pressure
        // introduces the explicit overflow menu.
        const label = item.querySelector<HTMLElement>('.cxm-breadcrumb-action, .cxm-breadcrumb-current')
        const separator = item.querySelector<HTMLElement>('.cxm-breadcrumb-separator')
        const naturalWidth = (label?.scrollWidth ?? 0) + (separator?.getBoundingClientRect().width ?? 0)
        // JSDOM has no layout width for leaf inline elements; its Host DOM
        // regression harness supplies the item geometry instead.
        return naturalWidth > 0 ? naturalWidth : Math.max(item.getBoundingClientRect().width, item.scrollWidth)
      })
      const projection = projectManagerBreadcrumbs(widths, breadcrumbs.clientWidth)
      renderProjection(projection)
    }
    const ResizeObserverConstructor = view?.ResizeObserver
    const resizeObserver = ResizeObserverConstructor === undefined
      ? undefined
      : new ResizeObserverConstructor(recalculate)
    resizeObserver?.observe(breadcrumbs)
    view?.addEventListener('resize', recalculate)
    if (typeof view?.requestAnimationFrame === 'function') view.requestAnimationFrame(recalculate)
    else queueMicrotask(recalculate)
    breadcrumbCleanup = () => {
      resizeObserver?.disconnect()
      view?.removeEventListener('resize', recalculate)
    }
    return breadcrumbs
  }

  const rememberListScroll = (): void => {
    listScrollPositions.set(activePrimary(), content.scrollTop)
  }

  const restoreListScroll = (): void => {
    content.scrollTop = listScrollPositions.get(activePrimary()) ?? 0
  }

  const createListSearch = (id: string, label: string, placeholder: string, value: string, onChange: (value: string) => void): HTMLDivElement => {
    const root = create(document, 'div', 'cxm-list-search')
    root.dataset.listSearch = id
    root.setAttribute('role', 'search')
    root.append(createManagerIcon(document, 'search', 'cxm-list-search-icon'))
    const input = create(document, 'input', 'cxm-search')
    input.type = 'search'
    input.placeholder = placeholder
    input.value = value
    input.setAttribute('aria-label', label)
    const clear = create(document, 'button', 'cxm-list-search-clear')
    clear.type = 'button'
    clear.setAttribute('aria-label', `清除${label}`)
    clear.append(createManagerIcon(document, 'close'))
    clear.hidden = value.length === 0
    const update = (next: string): void => {
      onChange(next)
      renderContent()
      const replacement = content.querySelector<HTMLInputElement>(`[data-list-search="${id}"] .cxm-search`)
      replacement?.focus()
      replacement?.setSelectionRange(next.length, next.length)
    }
    input.addEventListener('input', () => update(input.value))
    input.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      if (input.value.length > 0) update('')
      else input.blur()
    })
    clear.addEventListener('click', () => update(''))
    root.append(input, clear)
    return root
  }

  const setHeading = (
    headingCopy: string | undefined,
    snapshot: ManagerSnapshot,
    options: { readonly icon?: ManagerIconToken | CordisXIconToken; readonly brand?: boolean } = {},
  ): void => {
    heading.replaceChildren()
    delete heading.dataset.headingActions
    const pageRoute = resolvePageRoute(snapshot)
    const row = create(document, 'div', 'cxm-heading-row')
    if (pageRoute.segments.length > 1) {
      const back = create(document, 'button', 'cxm-heading-leading cxm-back')
      back.type = 'button'
      back.setAttribute('aria-label', copy('manager.back'))
      back.append(createManagerIcon(document, 'back', 'cxm-back-icon'))
      back.addEventListener('click', () => { void navigateBack() })
      // History owns the one stable leading seat. Do not place a decorative
      // icon next to Back: it shifts the title and creates duplicate chrome.
      row.append(back)
    } else {
      const icon = options.brand === true
        ? createAdaptiveBrandMark(document)
        : String(options.icon ?? 'plugins').startsWith('host:')
          ? createHostSurfaceIcon(document, options.icon as CordisXIconToken)
          : createManagerIcon(document, options.icon === undefined ? 'plugins' : options.icon as ManagerIconToken)
      icon.classList.add('cxm-heading-leading', 'cxm-heading-icon')
      icon.setAttribute('aria-hidden', 'true')
      row.append(icon)
    }
    const title = create(document, 'div', 'cxm-heading-title')
    const current = pageRoute.segments.at(-1)?.label ?? ''
    title.append(create(document, 'h2', 'cxm-heading-current-heading', current), renderBreadcrumbs(pageRoute))
    row.append(title)
    heading.append(row)
    // Breadcrumbs already identify a detail page. Repeating generic wording
    // such as “Plugin details” or “Configuration” expands shared chrome
    // without adding context; primary pages may retain a distinct purpose.
    const description = headingCopy?.trim()
    if (pageRoute.segments.length <= 1 && description !== undefined && description !== '' && description !== current.trim()) {
      heading.append(create(document, 'p', undefined, description))
    }
  }

  const setDirectManagerNavigationHeading = (title: string, icon: CordisXIconToken): void => {
    breadcrumbCleanup()
    breadcrumbCleanup = () => {}
    heading.replaceChildren()
    delete heading.dataset.headingActions
    const row = create(document, 'div', 'cxm-heading-row')
    const leading = createHostSurfaceIcon(document, icon)
    leading.classList.add('cxm-heading-leading', 'cxm-heading-icon')
    leading.setAttribute('aria-hidden', 'true')
    row.append(leading, create(document, 'h2', 'cxm-heading-direct-title', title))
    heading.append(row)
  }

  const renderAbout = (snapshot: ManagerSnapshot): void => {
    setHeading('项目、社区与支持入口', snapshot, { brand: true })
    const identity = create(document, 'div', 'cxm-about-identity')
    const mark = createAdaptiveBrandMark(document)
    mark.classList.add('cxm-about-mark')
    const identityCopy = create(document, 'div', 'cxm-about-identity-copy')
    identityCopy.append(
      create(document, 'div', 'cxm-about-name', 'CordisX'),
      create(document, 'div', 'cxm-about-version', `v${snapshot.version}`),
    )
    identity.append(mark, identityCopy)

    const actions = create(document, 'div', 'cxm-about-actions')
    actions.setAttribute('role', 'list')
    actions.setAttribute('aria-label', 'CordisX 项目入口')
    for (const action of ABOUT_ACTIONS) {
      const item = create(document, 'div', 'cxm-about-action-item')
      item.setAttribute('role', 'listitem')
      const link = create(document, 'a', 'cxm-about-action')
      configureExternalLink(link, action.href)
      const body = create(document, 'span', 'cxm-about-action-body')
      body.append(
        create(document, 'span', 'cxm-about-action-title', action.label),
        create(document, 'span', 'cxm-about-action-copy', action.description),
      )
      const arrow = createManagerIcon(document, 'external-link', 'cxm-about-action-arrow')
      link.append(body, arrow)
      item.append(link)
      actions.append(item)
    }
    content.append(identity, actions)
  }

  type ExtensionPointRowStatus = Readonly<{
    state: 'pending' | 'unavailable' | 'error'
    text: string
    icon: 'host:warning' | 'host:error'
  }>

  const extensionPointRowStatus = (
    snapshot: ManagerSnapshot,
    point: ExtensionPointSnapshot,
    usage?: ExtensionPointPluginUsageSnapshot,
  ): ExtensionPointRowStatus | undefined => {
    const catalogText = snapshot.extensionPoints?.catalogText
    const descriptorError = snapshot.extensionPoints?.descriptorDiagnostics.some(item => item.pointId === point.id) === true
      || point.titleProjection.diagnostic !== undefined
      || point.descriptionProjection.diagnostic !== undefined
    if (descriptorError || usage?.authorized === false) {
      return {
        state: 'error',
        text: usage?.authorized === false
          ? catalogText?.status.denied.text ?? '[[catalog.status.denied]]'
          : catalogText?.status.error.text ?? '[[catalog.status.error]]',
        icon: 'host:error',
      }
    }
    if (point.effectiveAdapterSupport === 'unsupported') {
      return { state: 'unavailable', text: catalogText?.status.unavailable.text ?? '[[catalog.status.unavailable]]', icon: 'host:error' }
    }
    if (point.effectiveAdapterSupport === 'unverified') {
      return { state: 'pending', text: catalogText?.status.pending.text ?? '[[catalog.status.pending]]', icon: 'host:warning' }
    }
    return undefined
  }

  const createExtensionPointCatalogItem = (
    snapshot: ManagerSnapshot,
    point: ExtensionPointSnapshot,
    action: (facet: ExtensionPointDetailTab) => void,
    usage?: ExtensionPointPluginUsageSnapshot,
  ): HTMLDivElement => {
    const listItem = create(document, 'div', 'cxm-catalog-item')
    listItem.setAttribute('role', 'listitem')
    const row = create(document, 'button', 'cxm-catalog-row')
    row.type = 'button'
    row.dataset.extensionPointId = point.id
    const status = extensionPointRowStatus(snapshot, point, usage)
    row.dataset.extensionPointState = status?.state ?? point.effectiveAdapterSupport
    const icon = createHostSurfaceIcon(document, point.icon)
    icon.classList.add('cxm-catalog-icon')
    const copy = create(document, 'span', 'cxm-catalog-copy')
    const stableId = create(document, 'code', 'cxm-catalog-id', point.id)
    stableId.dataset.copyableExtensionPointId = point.id
    copy.append(
      create(document, 'span', 'cxm-catalog-title', point.titleProjection.text),
      create(document, 'span', 'cxm-catalog-description', point.descriptionProjection.text),
      stableId,
    )
    row.append(icon, copy)
    if (status !== undefined) {
      const prompt = create(document, 'span', 'cxm-catalog-status')
      prompt.dataset.tone = status.state
      prompt.setAttribute('aria-label', status.text)
      const statusIcon = createHostSurfaceIcon(document, status.icon)
      statusIcon.classList.add('cxm-catalog-status-icon')
      prompt.append(statusIcon, create(document, 'span', 'cxm-catalog-status-copy', status.text))
      row.append(prompt)
    }
    activateManagerListRow(row, () => action(status === undefined ? 'usage' : 'diagnostics'))
    listItem.append(row)
    return listItem
  }

  const renderExtensionPointList = (snapshot: ManagerSnapshot): void => {
    // The primary breadcrumb already says “Extension points”. Adding the old
    // heading copy below it only restated the same page subject.
    setHeading(undefined, snapshot, { icon: 'contributions' })
    const points = snapshot.extensionPoints?.points ?? []
    const catalogText = snapshot.extensionPoints?.catalogText
    const items: HostCollectionItem[] = points.map(point => {
      const rowStatus = extensionPointRowStatus(snapshot, point)
      const status: HostCollectionStatus | undefined = rowStatus === undefined
        ? undefined
        : {
            label: rowStatus.text,
            tone: rowStatus.state === 'pending' ? 'warning' : 'danger',
            detail: rowStatus.text,
          }
      return {
        id: point.id,
        title: point.titleProjection.text,
        description: point.descriptionProjection.text,
        machineId: point.id,
        searchText: [
          point.kind,
          catalogText?.category[point.kind].text ?? '',
          catalogText?.owner.host.text ?? '',
          point.payloadFamily,
          point.maturity,
          point.adapterSupport,
          point.effectiveAdapterSupport,
          point.currentContext,
          point.currentContextCode ?? '',
          point.currentContextDetail ?? '',
          ...(point.anchors ?? []).flatMap(anchor => [anchor.id, anchor.adapterSupport, anchor.effectiveAdapterSupport, anchor.currentContext, anchor.availabilityCode ?? '', anchor.availabilityDetail ?? '']),
          ...point.plugins.flatMap(plugin => [plugin.name, plugin.identity.id, plugin.identity.source]),
          ...point.plugins.flatMap(plugin => plugin.registrations.map(item => item.id)),
          ...point.plugins.flatMap(plugin => plugin.routes.map(item => item.qualifiedId)),
        ],
        icon: () => createHostSurfaceIcon(document, point.icon),
        ...(status === undefined ? {} : { status }),
        onOpen: () => {
          rememberListScroll()
          operationError = undefined
          void navigateRoute({ kind: 'extension-point', pointId: point.id, facet: rowStatus === undefined ? 'usage' : 'diagnostics' })
        },
      }
    })
    mountHostCollection(content, {
      id: 'extension-points',
      label: copy('extension.collection-label'),
      items,
      density: 'compact',
      search: {
        label: copy('extension.search-label'),
        placeholder: copy('extension.search-placeholder'),
        query: extensionPointQuery,
        onQueryChange: value => { extensionPointQuery = value },
      },
      emptyLabel: copy('extension.empty'),
      noMatchesLabel: copy('extension.no-matches'),
    }, root => {
      for (const open of root.querySelectorAll<HTMLButtonElement>('[data-collection-open]')) {
        const point = points.find(item => item.id === open.dataset.collectionOpen)
        if (point === undefined) continue
        const rowStatus = extensionPointRowStatus(snapshot, point)
        open.dataset.extensionPointId = point.id
        open.dataset.extensionPointState = rowStatus?.state ?? point.effectiveAdapterSupport
      }
    })
  }

  const renderExtensionPointDetail = (snapshot: ManagerSnapshot, id: string): void => {
    const point = snapshot.extensionPoints?.points.find(item => item.id === id)
    setHeading(point?.titleProjection.text ?? '扩展点当前不可用', snapshot)
    if (point === undefined) {
      content.append(create(document, 'div', 'cxm-empty', '该扩展点已不在当前宿主目录中'))
      return
    }
    const activeFacet = routeState.kind === 'extension-point' ? routeState.facet : 'usage'
    content.append(createLocalTabs(document, localizeTabs(EXTENSION_POINT_DETAIL_TABS), activeFacet, 'data-extension-point-detail-tab', (tab) => {
      void navigateRoute({ kind: 'extension-point', pointId: id, facet: tab as ExtensionPointDetailTab })
    }))

    if (activeFacet === 'usage') {
      const panel = createTabPanel(document, '使用情况')
      const query = extensionPointUsageQueries.get(point.id) ?? ''
      panel.append(createListSearch(
        `extension-point-usage-${point.id}`,
        `搜索${point.titleProjection.text}的插件与贡献`,
        '搜索插件、贡献名称或 id…',
        query,
        value => { extensionPointUsageQueries.set(point.id, value) },
      ))
      const filteredUsages = point.plugins.flatMap(usage => {
        const pluginMatches = matchesManagerSearch(query, [usage.name, usage.description ?? '', usage.identity.id])
        const registrations = usage.registrations.filter(registration => pluginMatches || matchesManagerSearch(query, [
          registration.titleText,
          registration.descriptionText ?? '',
          registration.id,
          registration.qualifiedId,
        ]))
        const routes = usage.routes.filter(route => pluginMatches || matchesManagerSearch(query, [
          route.definition.path,
          route.definition.outlet,
          route.qualifiedId,
          `${route.owner}:${route.definition.page}`,
        ]))
        if (!pluginMatches && registrations.length === 0 && routes.length === 0) return []
        return [{ usage, registrations, routes }]
      })
      if (point.plugins.length === 0) panel.append(create(document, 'div', 'cxm-empty', '当前没有插件使用这个扩展点'))
      else if (filteredUsages.length === 0) panel.append(create(document, 'div', 'cxm-empty', '没有匹配的插件或贡献'))
      const list = create(document, 'div', 'cxm-usage-list')
      list.setAttribute('role', 'list')
      list.setAttribute('aria-label', `${point.titleProjection.text}使用列表`)
      for (const { usage, registrations, routes } of filteredUsages) {
        const item = create(document, 'div', 'cxm-usage-item')
        item.setAttribute('role', 'listitem')
        const headerRow = create(document, 'div', 'cxm-usage-header')
        const identity = create(document, 'div', 'cxm-usage-identity')
        const pluginCopy = create(document, 'div', 'cxm-plugin-body')
        pluginCopy.append(
          create(document, 'div', 'cxm-plugin-name', usage.name),
          create(document, 'div', 'cxm-plugin-description', usage.description ?? '本地 CordisX 插件'),
          create(document, 'code', 'cxm-catalog-id', usage.identity.id),
        )
        identity.append(createPluginIcon(document, usage.name), pluginCopy)
        type PointPolicy = 'inherit' | 'allow' | 'deny'
        const policy = forms.select<PointPolicy>(
          `${usage.name}使用${point.titleProjection.text}的策略`,
          (['inherit', 'allow', 'deny'] as const).map(value => ({
            value,
            label: value === 'inherit' ? '跟随宿主默认' : value === 'allow' ? '允许' : '拒绝',
          })),
          usage.policy,
          value => {
            if (value === undefined) return
            policy.setBusy(true)
            void (async () => {
          operationError = undefined
          try {
                await model.setExtensionPointPolicy?.(usage.identity.source, usage.identity.id, point.id, value)
          } catch (error) {
            operationError = error instanceof Error ? error.message : String(error)
          } finally {
            renderContent()
          }
            })()
          },
          { disabled: model.setExtensionPointPolicy === undefined },
        )
        policy.classList.add('cxm-usage-policy-select')
        headerRow.append(identity, policy)
        item.append(headerRow)
        const resources = create(document, 'div', 'cxm-usage-resources')
        if (point.kind === 'surface') {
          for (const registration of registrations) {
            const state = !registration.valid ? '无效' : !registration.authorized ? '已拒绝' : registration.rendered ? '已渲染' : registration.pending ? '等待宿主锚点' : '已登记'
            const resource = create(document, 'div', 'cxm-resource-row')
            resource.dataset.contributionId = registration.id
            resource.append(
              create(document, 'span', 'cxm-resource-title', registration.titleText),
              create(document, 'span', 'cxm-resource-description', `${registration.descriptionText ?? '结构化贡献'} · ${state}`),
              create(document, 'code', 'cxm-resource-id', registration.id),
            )
            resources.append(resource)
          }
        } else {
          for (const route of routes) {
            const pageId = `${route.owner}:${route.definition.page}`
            const resource = create(document, 'div', 'cxm-resource-row')
            resource.dataset.routeContributionId = route.qualifiedId
            resource.append(
              create(document, 'span', 'cxm-resource-title', route.definition.path),
              create(document, 'span', 'cxm-resource-description', `在 ${route.definition.outlet} 中打开 ${pageId} · ${route.authorized ? '已授权' : '已拒绝'}`),
              create(document, 'code', 'cxm-resource-id', route.qualifiedId),
            )
            resources.append(resource)
          }
        }
        if (resources.childElementCount > 0) item.append(resources)
        list.append(item)
      }
      if (filteredUsages.length > 0) panel.append(list)
      if (operationError !== undefined) panel.append(create(document, 'div', 'cxm-error', operationError))
      content.append(panel)
      return
    }

    if (activeFacet === 'information') {
      const panel = createTabPanel(document, '点位信息')
      const fields = create(document, 'div', 'cxm-detail-grid')
      const outlet = point.kind === 'outlet' ? snapshot.navigation.outlets.find(item => item.id === point.id) : undefined
      const maturityLabel = point.maturity === 'stable' ? '稳定' : point.maturity === 'experimental' ? '实验性' : '协议保留'
      const supportLabel = point.effectiveAdapterSupport === 'supported' ? '已支持' : point.effectiveAdapterSupport === 'unverified' ? '尚未验证' : '不支持'
      const declaredSupportLabel = point.adapterSupport === 'supported' ? '已支持' : point.adapterSupport === 'unverified' ? '尚未验证' : '不支持'
      const contextLabel = point.currentContext === 'active' ? '当前已挂载' : point.currentContext === 'inactive' ? '当前上下文未激活' : '当前页面未挂载'
      const rows: readonly (readonly [string, string])[] = [
        ['稳定标识', point.id],
        ['类型', point.kind === 'surface' ? '结构化界面点位' : '覆盖页面出口'],
        ['载荷族', point.payloadFamily],
        ['宿主图标', point.icon],
        ['成熟度', maturityLabel],
        ['适配器支持', supportLabel],
        ...(point.effectiveAdapterSupport === point.adapterSupport ? [] : [['目录声明支持', declaredSupportLabel]] as const),
        ['当前上下文', contextLabel],
        ...(point.currentContextCode === undefined ? [] : [['上下文代码', point.currentContextCode]] as const),
        ...(point.currentContextDetail === undefined ? [] : [['上下文详情', point.currentContextDetail]] as const),
        ...(point.anchors ?? []).map(anchor => [
          `语义锚点 ${anchor.id}`,
          `${anchor.placements.join('/')} · ${anchor.effectiveAdapterSupport} · ${anchor.currentContext}${anchor.availabilityCode === undefined ? '' : ` · ${anchor.availabilityCode}`}${anchor.availabilityDetail === undefined ? '' : ` · ${anchor.availabilityDetail}`}`,
        ] as const),
        ...(outlet === undefined ? [] : [
          ['覆盖方式', outlet.placement],
          ['上下文', outlet.contextKey ?? '等待宿主上下文'],
        ] as const),
      ]
      for (const [label, value] of rows) {
        const field = create(document, 'div', 'cxm-field')
        field.append(create(document, 'div', 'cxm-field-label', label), create(document, 'div', 'cxm-field-value', value))
        fields.append(field)
      }
      panel.append(fields)
      content.append(panel)
      return
    }

    const panel = createTabPanel(document, '诊断')
    const diagnostics = [
      ...(point.currentContextCode === undefined ? [] : [point.currentContextCode]),
      ...(point.currentContextDetail === undefined ? [] : [point.currentContextDetail]),
      ...(point.anchors ?? []).flatMap(anchor => [
        ...(anchor.availabilityCode === undefined ? [] : [`${anchor.id} · ${anchor.availabilityCode}`]),
        ...(anchor.availabilityDetail === undefined ? [] : [`${anchor.id} · ${anchor.availabilityDetail}`]),
      ]),
      ...(snapshot.extensionPoints?.descriptorDiagnostics.filter(item => item.pointId === point.id).map(item => `${item.code} · ${item.message}`) ?? []),
      ...(snapshot.extensionPoints?.policyDiagnostics.filter(item => item.identity.pointId === point.id).map(item => `${item.code} · ${item.message}`) ?? []),
      ...(snapshot.extensionPoints?.accessDiagnostics.filter(item => item.request.identity.pointId === point.id).map(item => `${item.request.operation} · ${item.authorized ? '允许' : '拒绝'}${item.reason === undefined ? '' : ` · ${item.reason}`}`) ?? []),
    ]
    if (diagnostics.length === 0) panel.append(create(document, 'div', 'cxm-empty', '当前没有与这个扩展点相关的诊断'))
    for (const diagnostic of diagnostics) panel.append(create(document, 'div', 'cxm-error', diagnostic))
    content.append(panel)
  }

  const managerLanguage = (snapshot: ManagerSnapshot): string => {
    try {
      return new Intl.Locale(snapshot.localization.locale).language
    } catch {
      return 'en'
    }
  }

  const missingMetadataText = (snapshot: ManagerSnapshot, field: 'title' | 'description'): string => {
    const zh = managerLanguage(snapshot) === 'zh'
    if (field === 'title') return zh ? '未提供标题' : 'No title provided'
    return zh ? '未提供说明' : 'No description provided'
  }

  const qualifiedNavigationId = (owner: string, id: string): string => id.includes(':') ? id : `${owner}:${id}`

  const routeParameterNames = (path: string): readonly string[] => (
    [...path.matchAll(/:([a-z][a-zA-Z0-9]*)/g)].map(match => `:${match[1]}`)
  )

  const createRouteMachineMetadata = (
    items: readonly { readonly label: string; readonly value: string }[],
  ): HTMLElement => {
    const metadata = create(document, 'dl', 'cxm-route-machine')
    for (const item of items) {
      const field = create(document, 'div', 'cxm-route-machine-item')
      field.append(create(document, 'dt', undefined, item.label), create(document, 'dd', undefined, item.value))
      metadata.append(field)
    }
    return metadata
  }

  const createRouteMetadataDiagnostic = (
    snapshot: ManagerSnapshot,
    item: RouteSnapshot | NavigationPageSnapshot,
  ): HTMLElement | undefined => {
    if (item.productMetadata.diagnostics.length === 0) return undefined
    const fields = item.productMetadata.diagnostics.map(diagnostic => diagnostic.field)
    const zh = managerLanguage(snapshot) === 'zh'
    const names = fields.map(field => field === 'title'
      ? (zh ? '标题' : 'title')
      : (zh ? '说明' : 'description'))
    const diagnostic = create(document, 'div', 'cxm-route-metadata-diagnostic')
    diagnostic.dataset.metadataDiagnostic = fields.join(',')
    diagnostic.title = item.productMetadata.diagnostics.map(entry => `${entry.code}: ${entry.message}`).join('\n')
    diagnostic.append(
      createManagerIcon(document, 'diagnostics'),
      create(document, 'span', undefined, zh
        ? `贡献作者应补充本地化${names.join('、')} metadata`
        : `Contribution author should add localized ${names.join(' and ')} metadata`),
    )
    return diagnostic
  }

  const routeSearchValues = (route: RouteSnapshot): readonly string[] => [
    route.productMetadata.title ?? '',
    route.productMetadata.description ?? '',
    route.qualifiedId,
    route.id,
    route.owner,
    route.definition.path,
    route.definition.outlet,
    route.definition.page,
    ...routeParameterNames(route.definition.path),
    route.error ?? '',
  ]

  const pageSearchValues = (
    page: NavigationPageSnapshot,
    routes: readonly RouteSnapshot[],
  ): readonly string[] => [
    page.productMetadata.title ?? '',
    page.productMetadata.description ?? '',
    page.qualifiedId,
    page.id,
    page.owner,
    page.metadata.chrome ?? 'standard',
    ...routes.flatMap(route => [route.definition.path, route.definition.outlet, route.qualifiedId]),
  ]

  const createRouteProductRow = (
    snapshot: ManagerSnapshot,
    route: RouteSnapshot,
    onActivate?: () => void,
  ): HTMLElement => {
    const item = create(document, 'div', 'cxm-route-group-item')
    item.setAttribute('role', 'listitem')
    const row = onActivate === undefined
      ? create(document, 'div', 'cxm-route-card')
      : create(document, 'button', 'cxm-route-card')
    if (row instanceof document.defaultView!.HTMLButtonElement) row.type = 'button'
    row.dataset.routeId = route.qualifiedId
    row.dataset.routeProductRow = route.qualifiedId
    const title = route.productMetadata.title ?? route.qualifiedId
    const description = route.productMetadata.description ?? missingMetadataText(snapshot, 'description')
    row.setAttribute('aria-label', `${title}，${description}，${route.definition.path}，${route.definition.outlet}`)
    const body = create(document, 'span', 'cxm-route-card-body')
    const pageId = qualifiedNavigationId(route.owner, route.definition.page)
    const identityItems = pageId === route.qualifiedId
      ? [{ label: '页面 / 贡献', value: route.qualifiedId }]
      : [{ label: '页面', value: pageId }, { label: '贡献', value: route.qualifiedId }]
    body.append(
      create(document, 'span', 'cxm-route-card-title', title),
      create(document, 'span', 'cxm-route-card-description', description),
      createRouteMachineMetadata([
        { label: '路径', value: route.definition.path },
        { label: '出口', value: route.definition.outlet },
        ...identityItems,
        { label: '参数', value: routeParameterNames(route.definition.path).join(', ') || '—' },
        { label: '来源插件', value: route.owner },
      ]),
    )
    const metadataDiagnostic = createRouteMetadataDiagnostic(snapshot, route)
    if (metadataDiagnostic !== undefined) body.append(metadataDiagnostic)
    if (!route.valid || !route.authorized) {
      const state = create(document, 'span', 'cxm-route-state', route.error ?? (route.authorized ? '路由不可用' : '扩展点策略已拒绝'))
      state.dataset.routeState = route.valid ? 'denied' : 'invalid'
      body.append(state)
    }
    row.append(createManagerIcon(document, 'routes', 'cxm-route-card-icon'), body)
    if (onActivate !== undefined && row instanceof document.defaultView!.HTMLButtonElement) {
      activateManagerListRow(row, onActivate)
    }
    item.append(row)
    return item
  }

  const createPageProductRow = (
    snapshot: ManagerSnapshot,
    page: NavigationPageSnapshot,
    routes: readonly RouteSnapshot[],
  ): HTMLElement => {
    const item = create(document, 'div', 'cxm-route-group-item')
    item.setAttribute('role', 'listitem')
    const row = create(document, 'div', 'cxm-route-card')
    row.dataset.pageProductRow = page.qualifiedId
    const title = page.productMetadata.title ?? page.qualifiedId
    const description = page.productMetadata.description ?? missingMetadataText(snapshot, 'description')
    row.setAttribute('aria-label', `${title}，${description}`)
    const body = create(document, 'div', 'cxm-route-card-body')
    const outlets = [...new Set(routes.map(route => route.definition.outlet))].sort()
    body.append(
      create(document, 'span', 'cxm-route-card-title', title),
      create(document, 'span', 'cxm-route-card-description', description),
      createRouteMachineMetadata([
        { label: '页面', value: page.qualifiedId },
        { label: '目标出口', value: outlets.join(', ') || '—' },
        { label: 'Chrome', value: page.metadata.chrome ?? 'standard' },
        { label: '来源插件', value: page.owner },
      ]),
    )
    const metadataDiagnostic = createRouteMetadataDiagnostic(snapshot, page)
    if (metadataDiagnostic !== undefined) body.append(metadataDiagnostic)
    row.append(createManagerIcon(document, 'document', 'cxm-route-card-icon'), body)
    item.append(row)
    return item
  }

  const routeCollectionItem = (
    snapshot: ManagerSnapshot,
    route: RouteSnapshot,
    onOpen: () => void,
  ): HostCollectionItem => {
    const title = route.productMetadata.title ?? route.qualifiedId
    const description = route.productMetadata.description ?? missingMetadataText(snapshot, 'description')
    const status: HostCollectionStatus | undefined = !route.valid || !route.authorized
      ? {
          label: route.valid ? '已拒绝' : '无效',
          tone: 'danger',
          detail: route.error ?? (route.authorized ? '路由不可用' : '扩展点策略已拒绝'),
        }
      : route.productMetadata.diagnostics.length > 0
        ? { label: '内容信息待补充', tone: 'warning', detail: '内容信息待补充' }
        : undefined
    return {
      id: `route:${route.qualifiedId}`,
      title,
      description,
      machineId: route.qualifiedId,
      searchText: routeSearchValues(route),
      icon: () => createManagerIcon(document, 'routes'),
      ...(status === undefined ? {} : { status }),
      openLabel: `${copy('routes.open-route')} · ${title}`,
      onOpen,
    }
  }

  const pageCollectionItem = (
    snapshot: ManagerSnapshot,
    page: NavigationPageSnapshot,
    routes: readonly RouteSnapshot[],
    onOpen: () => void,
  ): HostCollectionItem => {
    const title = page.productMetadata.title ?? page.qualifiedId
    const description = page.productMetadata.description ?? missingMetadataText(snapshot, 'description')
    const status: HostCollectionStatus | undefined = page.productMetadata.diagnostics.length > 0
      ? { label: '内容信息待补充', tone: 'warning', detail: '内容信息待补充' }
      : undefined
    return {
      id: `page:${page.qualifiedId}`,
      title,
      description,
      machineId: page.qualifiedId,
      searchText: pageSearchValues(page, routes),
      icon: () => createManagerIcon(document, 'document'),
      ...(status === undefined ? {} : { status }),
      openLabel: `${copy('routes.open-page')} · ${title}`,
      onOpen,
    }
  }

  const createRoutePageSection = (
    id: string,
    title: string,
    copy: string,
    ariaLabel: string,
  ): { readonly section: HTMLElement; readonly list: HTMLElement } => {
    const section = create(document, 'section', 'cxm-route-section')
    const headingId = `cxm-route-section-${id}`
    const heading = create(document, 'h3', 'cxm-route-section-heading', title)
    heading.id = headingId
    section.setAttribute('aria-labelledby', headingId)
    section.append(heading, create(document, 'p', 'cxm-route-section-copy', copy))
    const list = create(document, 'div', 'cxm-route-group')
    list.setAttribute('role', 'list')
    list.setAttribute('aria-label', ariaLabel)
    section.append(list)
    return { section, list }
  }

  const renderRouteList = (snapshot: ManagerSnapshot): void => {
    setHeading(copy('routes.heading'), snapshot, { icon: 'routes' })
    const items: HostCollectionItem[] = [
      ...snapshot.navigation.routes.map(route => routeCollectionItem(snapshot, route, () => {
        rememberListScroll()
        void navigateRoute({ kind: 'route', qualifiedId: route.qualifiedId })
      })),
      ...snapshot.navigation.pages.map(page => {
        const routes = snapshot.navigation.routes.filter(route => (
          qualifiedNavigationId(route.owner, route.definition.page) === page.qualifiedId
        ))
        return pageCollectionItem(snapshot, page, routes, () => {
          rememberListScroll()
          void navigateRoute({ kind: 'page', qualifiedId: page.qualifiedId })
        })
      }),
    ]
    mountHostCollection(content, {
      id: 'routes',
      label: copy('routes.collection-label'),
      items,
      density: 'compact',
      search: {
        label: copy('routes.search-label'),
        placeholder: copy('routes.search-placeholder'),
        query: routeQuery,
        onQueryChange: value => { routeQuery = value },
      },
      emptyLabel: copy('routes.empty'),
      noMatchesLabel: copy('routes.no-matches'),
    }, root => {
      for (const open of root.querySelectorAll<HTMLButtonElement>('[data-collection-open]')) {
        const id = open.dataset.collectionOpen
        if (id?.startsWith('route:')) {
          open.dataset.routeProductRow = id.slice('route:'.length)
          open.dataset.routeId = id.slice('route:'.length)
        } else if (id?.startsWith('page:')) {
          open.dataset.pageProductRow = id.slice('page:'.length)
        }
      }
    })
  }

  const renderRouteDetail = (snapshot: ManagerSnapshot, qualifiedId: string): void => {
    const route = snapshot.navigation.routes.find(item => item.qualifiedId === qualifiedId)
    setHeading('路由详情', snapshot)
    if (route === undefined) {
      content.append(create(document, 'div', 'cxm-empty', '该路由已不在当前 bundle 中'))
      return
    }
    const pageId = qualifiedNavigationId(route.owner, route.definition.page)
    const page = snapshot.navigation.pages.find(item => item.qualifiedId === pageId)
    const outlet = snapshot.navigation.outlets.find(item => item.id === route.definition.outlet)
    const presentation = outlet?.activeRoute !== route.qualifiedId
      ? '未打开'
      : outlet.presentation === 'presented'
        ? '展示中'
        : outlet.presentation === 'suspended'
          ? `已暂停${outlet.suspendedBy === undefined ? '' : ` · 由 ${outlet.suspendedBy} 覆盖`}`
          : '未打开'
    const routeSection = createRoutePageSection(
      'detail-route',
      '路由',
      '本地化用途与不可翻译的导航机器信息。',
      `${route.productMetadata.title ?? route.qualifiedId}路由详情`,
    )
    routeSection.list.append(createRouteProductRow(snapshot, route))
    const statusFields = create(document, 'div', 'cxm-detail-grid')
    for (const [label, value] of [
      ['路由状态', !route.valid ? '无效' : route.authorized ? '已授权' : '已拒绝'],
      ['页面注册', page === undefined ? '缺失' : '已注册'],
      ['出口状态', outlet === undefined ? '未声明' : outlet.available ? '可用' : '不可用'],
      ['展示状态', presentation],
    ]) {
      const field = create(document, 'div', 'cxm-field')
      field.append(create(document, 'div', 'cxm-field-label', label), create(document, 'div', 'cxm-field-value', value))
      statusFields.append(field)
    }
    content.append(routeSection.section)
    if (page !== undefined) {
      const pageRoutes = snapshot.navigation.routes.filter(item => (
        qualifiedNavigationId(item.owner, item.definition.page) === page.qualifiedId
      ))
      const pageSection = createRoutePageSection(
        'detail-page',
        '页面',
        'Host 渲染的页面信息与受控 chrome 范围。',
        `${page.productMetadata.title ?? page.qualifiedId}页面详情`,
      )
      pageSection.list.append(createPageProductRow(snapshot, page, pageRoutes))
      content.append(pageSection.section)
    }
    content.append(statusFields)
    if (route.error !== undefined) content.append(create(document, 'div', 'cxm-error', route.error))
    if (outlet?.error !== undefined) content.append(create(document, 'div', 'cxm-error', outlet.error))
  }

  const renderPageDetail = (snapshot: ManagerSnapshot, qualifiedId: string): void => {
    const page = snapshot.navigation.pages.find(item => item.qualifiedId === qualifiedId)
    setHeading('页面详情', snapshot)
    if (page === undefined) {
      content.append(create(document, 'div', 'cxm-empty', '该页面已不在当前 bundle 中'))
      return
    }
    const routes = snapshot.navigation.routes.filter(route => (
      qualifiedNavigationId(route.owner, route.definition.page) === page.qualifiedId
    ))
    const pageSection = createRoutePageSection(
      'detail-page',
      '页面',
      'Host 渲染的页面信息与受控 chrome 范围。',
      `${page.productMetadata.title ?? page.qualifiedId}页面详情`,
    )
    pageSection.list.append(createPageProductRow(snapshot, page, routes))
    content.append(pageSection.section)
    if (routes.length > 0) {
      const routeSection = createRoutePageSection(
        'detail-page-routes',
        '关联路由',
        '能够导航到这个页面的结构化入口。',
        `${page.productMetadata.title ?? page.qualifiedId}关联路由`,
      )
      for (const route of routes) {
        routeSection.list.append(createRouteProductRow(snapshot, route, () => {
          void navigateRoute({ kind: 'route', qualifiedId: route.qualifiedId })
        }))
      }
      content.append(routeSection.section)
    }
  }

  const renderPluginList = (snapshot: ManagerSnapshot): void => {
    setHeading(copy('manager.nav.plugins'), snapshot, { icon: 'plugins' })
    content.dataset.managerListPage = 'true'
    const install = managerIconAction('import-plugin', lifecycleInstallBusy ? copy('plugins.install-checking') : copy('plugins.install'), {
      className: 'cxm-toolbar-icon-action',
      disabled: lifecycleInstallBusy
        || lifecycleBusy.size > 0
        || snapshot.pluginLifecycle?.operationsAvailable !== true
        || model.requestPluginLifecycle === undefined,
    })
    install.dataset.installLocalPlugin = 'true'
    install.dataset.importLocalPlugin = 'true'
    install.addEventListener('click', () => { void runLocalPackageInstall(install) })

    const favorites = favoritePlugins(snapshot)
    const plugins = [...snapshot.plugins].sort((left, right) => Number(favorites.has(right.id)) - Number(favorites.has(left.id)))
    const demoDescriptionKeys: Readonly<Partial<Record<string, Parameters<typeof managerCopy>[1]>>> = {
      'slot-showcase': 'plugins.demo.slot-showcase-description',
      'hello-toolbar': 'plugins.demo.hello-toolbar-description',
      'form-schema-gallery': 'plugins.demo.form-schema-gallery-description',
    }
    const items: HostCollectionItem[] = plugins.map(plugin => {
      const status = lifecycleBusy.get(plugin.id) ?? plugin.status
      const packageOperationReason = packageOperationUnavailableReason(snapshot, plugin)
      const managed = packageOperationReason === undefined
      const reloadManaged = managed || plugin.developmentReloadAvailable === true
      const globallyBusy = lifecycleInstallBusy || lifecycleBusy.size > 0
      const enable = plugin.status === 'configured-disabled'
      const toggleLabel = enable ? copy('plugins.enable') : copy('plugins.disable')
      const toggleDisabled = !managed || globallyBusy || (plugin.status !== 'active' && !enable)
      const sourceReason = sourceUnavailableReason(plugin)
      const sourceActionReason = sourceReason === undefined ? undefined : copy('status.unavailable')
      const favorite = favorites.has(plugin.id)
      const toggleReason = toggleDisabled
        ? (!managed ? copy('status.unavailable') : globallyBusy ? copy('plugins.operation-busy') : copy(enable ? 'plugins.enable-unavailable' : 'plugins.disable-unavailable'))
        : undefined
      const reloadReason = !reloadManaged
        ? copy('status.unavailable')
        : globallyBusy ? copy('plugins.operation-busy') : plugin.status === 'active' ? undefined : copy('plugins.reload-unavailable')
      const uninstallReason = !managed ? copy('status.unavailable') : (globallyBusy ? copy('plugins.operation-busy') : undefined)
      const actions: HostCollectionAction[] = [
        {
          id: enable ? 'enable' : 'disable',
          label: toggleLabel,
          placement: 'direct',
          priority: 1,
          icon: () => createManagerIcon(document, enable ? 'enable-plugin' : 'disable-plugin'),
          disabled: toggleDisabled,
          ...(toggleReason === undefined ? {} : { unavailableReason: toggleReason }),
          onInvoke: () => { void runPluginLifecycle(snapshot, plugin, enable ? 'enable' : 'disable') },
        },
        {
          id: 'favorite',
          label: favorite ? copy('plugins.unfavorite') : copy('plugins.favorite'),
          placement: 'direct',
          priority: 2,
          icon: () => createManagerIcon(document, favorite ? 'favorite-active' : 'favorite'),
          onInvoke: () => {
            pendingPluginActionFocus = { pluginId: plugin.id, actionId: 'favorite' }
            setFavorite(snapshot, plugin.id, !favorite)
            renderContent()
          },
        },
        {
          id: 'reload',
          label: copy('plugins.reload'),
          placement: 'direct',
          priority: 3,
          icon: () => createManagerIcon(document, 'reload-plugin'),
          disabled: !reloadManaged || globallyBusy || plugin.status !== 'active',
          ...(reloadReason === undefined ? {} : { unavailableReason: reloadReason }),
          onInvoke: () => { void runPluginLifecycle(snapshot, plugin, 'reload') },
        },
        {
          id: 'share',
          label: sourceReason === undefined ? copy('plugins.share') : copy('plugins.share-unavailable'),
          placement: 'overflow',
          icon: () => createManagerIcon(document, 'share-plugin'),
          disabled: sourceReason !== undefined,
          ...(sourceActionReason === undefined ? {} : { unavailableReason: sourceActionReason }),
          onInvoke: () => { void sharePlugin(plugin)
            .catch(error => { operationError = error instanceof Error ? error.message : String(error) })
            .finally(() => {
              pendingPluginMenuFocus = plugin.id
              renderContent()
              queueMicrotask(() => {
                const card = [...content.querySelectorAll<HTMLElement>('[data-plugin-card]')]
                  .find(candidate => candidate.dataset.pluginCard === plugin.id)
                card?.querySelector<HTMLElement>('.cxc-menu-trigger')?.focus()
              })
            }) },
        },
        {
          id: 'source',
          label: sourceReason === undefined ? copy('plugins.open-source') : copy('plugins.open-source-unavailable'),
          placement: 'overflow',
          icon: () => createManagerIcon(document, 'authors-source'),
          disabled: sourceReason !== undefined,
          ...(sourceActionReason === undefined ? {} : { unavailableReason: sourceActionReason }),
          onInvoke: () => { openPluginSource(plugin) },
        },
        {
          id: 'diagnostics',
          label: copy('plugins.diagnostics'),
          placement: 'overflow',
          icon: () => createManagerIcon(document, 'diagnostics'),
          onInvoke: () => {
            rememberListScroll()
            void navigateRoute({ kind: 'plugin', pluginId: plugin.id, facet: 'logs' })
          },
        },
        {
          id: 'uninstall',
          label: managed ? copy('plugins.uninstall') : copy('plugins.uninstall-unavailable'),
          placement: 'overflow',
          tone: 'danger',
          icon: () => createManagerIcon(document, 'uninstall-plugin'),
          disabled: !managed || globallyBusy,
          ...(uninstallReason === undefined ? {} : { unavailableReason: uninstallReason }),
          onInvoke: () => { void runPluginLifecycle(snapshot, plugin, 'uninstall', true) },
        },
      ]
      const visibleActions = actions.filter(action => action.placement === 'direct' || action.disabled !== true)
      const registrations = snapshot.registrations.filter(item => item.owner === plugin.id)
      const demoDescriptionKey = demoDescriptionKeys[plugin.id]
      return {
        id: plugin.id,
        title: plugin.name,
        description: demoDescriptionKey === undefined ? plugin.description ?? copy('plugins.local-description') : copy(demoDescriptionKey),
        machineId: plugin.id,
        searchText: [plugin.source, ...plugin.inject, ...registrations.flatMap(item => [item.surface, item.id])],
        icon: () => createPluginIcon(document, plugin.name, plugin.icon),
        ...(plugin.icon === undefined ? {} : { iconKind: 'artwork' as const }),
        status: pluginCollectionStatus(plugin, status, snapshot.localization.locale),
        actions: visibleActions,
        openLabel: `${copy('plugins.open')} · ${plugin.name}`,
        onOpen: () => {
          rememberListScroll()
          operationError = undefined
          void navigateRoute({ kind: 'plugin', pluginId: plugin.id, facet: 'readme' })
        },
      }
    })
    const view = mountHostCollection(content, {
      id: 'plugins',
      label: copy('plugins.collection-label'),
      items,
      search: {
        label: copy('plugins.search-label'),
        placeholder: copy('plugins.search-placeholder'),
        clearLabel: copy('plugins.search-clear'),
        query: pluginQuery,
        onQueryChange: value => { pluginQuery = value },
      },
      emptyLabel: copy('plugins.empty'),
      noMatchesLabel: copy('plugins.no-matches'),
      moreLabel: copy('plugins.more-actions'),
    }, root => {
      for (const item of root.querySelectorAll<HTMLElement>('[data-collection-item]')) {
        const pluginId = item.dataset.collectionItem
        if (pluginId === undefined) continue
        item.dataset.pluginCard = pluginId
        item.dataset.pluginMenu = pluginId
        const primary = item.querySelector<HTMLButtonElement>('[data-collection-open]')
        if (primary !== null) {
          primary.dataset.pluginId = pluginId
          primary.dataset.pluginPrimary = pluginId
        }
        for (const action of item.querySelectorAll<HTMLButtonElement>('.cxc-action[data-collection-action]')) {
          action.dataset.pluginAction = action.dataset.collectionAction
        }
        const favorite = item.querySelector<HTMLButtonElement>('[data-collection-action="favorite"]')
        if (favorite !== null) favorite.setAttribute('aria-pressed', String(favoritePluginIds.has(pluginId)))
      }
    })
    view.element.classList.add('cxm-fixed-list-collection')
    const search = view.element.querySelector<HTMLElement>('.cxc-search')
    if (search !== null) {
      const toolbar = create(document, 'div', 'cxm-toolbar')
      search.replaceWith(toolbar)
      toolbar.append(search, install)
    }
    if (operationError !== undefined) view.element.before(create(document, 'div', 'cxm-error', operationError))
    if (pendingPluginMenuFocus !== undefined) {
      const pluginId = pendingPluginMenuFocus
      pendingPluginMenuFocus = undefined
      const card = [...view.element.querySelectorAll<HTMLElement>('[data-plugin-card]')]
        .find(candidate => candidate.dataset.pluginCard === pluginId)
      card?.querySelector<HTMLElement>('.cxc-menu-trigger')?.focus()
    }
    if (pendingPluginActionFocus !== undefined) {
      const focus = pendingPluginActionFocus
      pendingPluginActionFocus = undefined
      const card = [...view.element.querySelectorAll<HTMLElement>('[data-plugin-card]')]
        .find(candidate => candidate.dataset.pluginCard === focus.pluginId)
      const action = [...(card?.querySelectorAll<HTMLElement>('[data-collection-action]') ?? [])]
        .find(candidate => candidate.dataset.collectionAction === focus.actionId)
      action?.focus()
    }
  }

  const commitPermissionPolicy = async (
    pluginId: string,
    permission: ManagerPermissionSnapshot,
    policy: CordisXPermissionPolicy,
    control: TDesignSelectElement<CordisXPermissionPolicy>,
  ): Promise<void> => {
    operationError = undefined
    control.setBusy(true)
    try {
      await model.setPermissionPolicy(pluginId, permission.capability, policy, permission.scope)
    } catch (error) {
      operationError = error instanceof Error ? error.message : String(error)
    } finally {
      renderContent()
    }
  }

  const renderPermissionDetail = (
    snapshot: ManagerSnapshot,
    pluginId: string,
    capability: CordisXPermissionCapabilityV4,
    fingerprint: string,
  ): void => {
    const plugin = snapshot.plugins.find(item => item.id === pluginId)
    const permission = snapshot.permissions.find(item => (
      item.identity.id === pluginId
      && item.identity.source === plugin?.source
      && item.capability === capability
      && item.fingerprint === fingerprint
    ))
    const presentation = capabilityPresentation(capability)
    setHeading(plugin === undefined ? '插件权限详情' : `${plugin.name} 申请的权限`, snapshot)
    if (plugin === undefined || permission === undefined) {
      content.append(create(document, 'div', 'cxm-empty', '该权限声明已不在当前 bundle 中'))
      return
    }

    const detail = create(document, 'div', 'cxm-permission-detail')
    detail.dataset.permissionDetail = permission.capability
    const intro = create(document, 'div', 'cxm-permission-detail-intro')
    const introCopy = create(document, 'div')
    introCopy.append(create(document, 'p', 'cxm-copy', permission.reasonText))
    intro.append(createCapabilityIcon(document, permission.capability), introCopy)
    detail.append(intro)

    const info = forms.section('权限信息')
    for (const [label, value] of [
      ['申请类型', permission.required ? '必需权限' : '可选权限'],
      ['可用状态', capabilityAvailabilityLabel(permission.availability.status)],
      ['能力标识', permission.capability],
    ]) {
      const row = create(document, 'div', 'cxm-settings-info-row')
      row.append(create(document, 'div', 'cxm-settings-info-label', label), create(document, 'div', 'cxm-settings-info-value', value))
      info.content.append(row)
    }
    detail.append(info.root)

    if (permission.authorizationOrigin !== undefined) {
      const authorization = forms.section(
        permission.authorizationOrigin === 'certified-implicit' ? '认证自动批准的 DOM 权限' : '最近授权来源',
        permission.authorizationReason ?? (permission.authorizationOrigin === 'certified-implicit'
          ? 'Host 根据精确制品认证投影自动批准；权限仍由 PermissionBroker 签发并审计。'
          : '由用户显式确认。'),
      )
      authorization.root.dataset.permissionAuthorizationOrigin = permission.authorizationOrigin
      if (permission.certification !== undefined) {
        for (const [label, value] of [
          ['制品', `${permission.certification.pluginId}@${permission.certification.version}`],
          ['完整性', permission.certification.integrity],
          ['审核策略', `${permission.certification.reviewPolicy.id}@${permission.certification.reviewPolicy.version}`],
          ['证据', permission.certification.evidence.reference],
          ['投影 revision', permission.certification.revision],
          ['投影 fingerprint', permission.certification.fingerprint],
        ]) {
          const row = create(document, 'div', 'cxm-settings-info-row')
          row.append(create(document, 'div', 'cxm-settings-info-label', label), create(document, 'div', 'cxm-settings-info-value', value))
          authorization.content.append(row)
        }
      }
      detail.append(authorization.root)
    }

    const policySection = forms.section('访问策略', '选择每次询问、始终允许或始终拒绝；策略由 Host 保存并执行。')
    const policyItem = forms.item({
      id: `cxm-permission-policy-${permission.capability.replaceAll('.', '-')}`,
      label: '权限策略',
      help: permission.required ? '拒绝必需权限会停止插件运行。' : '可随时返回此页修改。',
    })
    const policySelect = createPermissionPolicySelect(forms, permission, async (policy, control) => {
      await commitPermissionPolicy(plugin.id, permission, policy, control)
    })
    policySelect.classList.add('cxm-permission-detail-policy')
    policySelect.id = policyItem.label.htmlFor
    policySelect.setAttribute('aria-labelledby', policyItem.label.id)
    policyItem.control.append(policySelect)
    policySection.content.append(policyItem.root)
    detail.append(policySection.root)
    if (permission.required && permission.policy === 'deny') {
      const blocked = create(document, 'div', 'cxm-notice', '这是一项必需权限。保持“始终拒绝”时，插件将停止运行。')
      blocked.dataset.tone = 'warning'
      detail.append(blocked)
    }

    if (hasCapabilityScope(permission.scope)) {
      detail.append(createSectionTitle(document, '使用范围'))
      detail.append(create(document, 'pre', 'cxm-code', formatConfig(permission.scope)))
    }

    detail.append(createSectionTitle(document, '能力提供方'))
    if (permission.availability.providers.length === 0) {
      detail.append(create(document, 'div', 'cxm-empty', permission.availability.reasonText))
    } else {
      const providers = create(document, 'div', 'cxm-flat-list')
      providers.setAttribute('role', 'list')
      providers.dataset.permissionProviders = permission.capability
      for (const provider of permission.availability.providers) {
        const providerItem = create(document, 'div', 'cxm-flat-item cxm-permission-provider-item')
        providerItem.setAttribute('role', 'listitem')
        providerItem.dataset.permissionProvider = provider.providerId
        const copy = create(document, 'div', 'cxm-permission-copy')
        copy.append(
          create(document, 'span', 'cxm-permission-name', provider.providerNameText),
          create(document, 'span', 'cxm-permission-reason', provider.reasonText),
        )
        providerItem.append(copy, create(document, 'span', 'cxm-kind-badge', capabilityAvailabilityLabel(provider.status)))
        if (provider.scope !== undefined && hasCapabilityScope(provider.scope)) {
          const scope = create(document, 'pre', 'cxm-code', formatConfig(provider.scope))
          scope.dataset.permissionProviderScope = provider.providerId
          providerItem.append(scope)
        }
        providers.append(providerItem)
      }
      detail.append(providers)
    }

    detail.append(createSectionTitle(document, '本次运行审计'))
    const target = permission.lastRequested === undefined ? '无' : JSON.stringify(permission.lastRequested)
    const audit = permission.lastUsedAt === undefined && permission.lastDeniedAt === undefined && permission.denialCount === 0
      ? '本次运行尚无调用记录'
      : `最近目标：${target} · 最近允许：${permission.lastUsedAt ?? '无'} · 最近拒绝：${permission.lastDeniedAt ?? '无'} · 拒绝次数：${permission.denialCount}`
    detail.append(create(document, 'p', 'cxm-copy cxm-permission-audit', audit))
    if (operationError !== undefined) detail.append(create(document, 'div', 'cxm-error', operationError))
    content.append(detail)
  }

  const fieldLabel = (field: CordisXConfigFieldSnapshot): string => {
    const productLabel = field.label?.trim()
    if (productLabel !== undefined && productLabel !== '') return productLabel
    const value = String(field.path[field.path.length - 1] ?? 'value')
    return value
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replaceAll(/[._-]+/g, ' ')
      .replace(/^./, character => character.toUpperCase())
  }

  /**
   * Launcher services deliberately do not appear in Manager Settings.  The
   * owning plugin is the only product entry point, while this Host-rendered
   * adapter keeps schema projection, CAS, portal controls, and error policy
   * out of the plugin bundle.
   */
  const renderPluginServiceConfiguration = (plugin: ManagerPluginSnapshot, panel: HTMLElement): void => {
    if (plugin.id !== 'cli-proxy-api' || model.listServiceConfigs === undefined) return
    const seat = create(document, 'div', 'cxm-plugin-service-config')
    seat.dataset.pluginServiceConfig = plugin.id
    seat.append(forms.empty(productLocale(model.snapshot().localization.locale) === 'zh-CN' ? '正在读取 Provider 配置…' : 'Loading Provider configuration…'))
    panel.append(seat)

    const unavailable = (reason: unknown): string => {
      const code = reason instanceof Error ? reason.message : String(reason)
      if (code === 'permission-denied') return productLocale(model.snapshot().localization.locale) === 'zh-CN'
        ? '没有权限查看 Provider 配置。' : 'You do not have permission to view Provider configuration.'
      return productLocale(model.snapshot().localization.locale) === 'zh-CN'
        ? 'Provider 配置当前不可用。' : 'Provider configuration is currently unavailable.'
    }
    const render = (descriptors: readonly HostServiceConfigDescriptor[]): void => {
      if (!seat.isConnected) return
      seat.replaceChildren()
      if (descriptors.length === 0) {
        seat.append(forms.empty(productLocale(model.snapshot().localization.locale) === 'zh-CN'
          ? 'Provider 配置当前不可用。' : 'Provider configuration is currently unavailable.'))
        return
      }
      for (const descriptor of descriptors) {
        const locale = model.snapshot().localization.locale
        const runtime = descriptor.identity.serviceId === 'providers-runtime'
        const title = productLocale(locale) === 'zh-CN'
          ? (runtime ? 'Provider 连接' : '下次启动')
          : (runtime ? 'Provider connections' : 'Next launch')
        const description = productLocale(locale) === 'zh-CN'
          ? (runtime ? '保存后重启 Provider 服务；当前连接不会被伪造成原生连接。' : '保存为下次应用启动候选值；重启应用后生效。')
          : (runtime ? 'Saving restarts the Provider service; it never impersonates the native connection.' : 'Saved as the next app-start candidate and takes effect after restart.')
        const section = forms.section(title, description)
        section.root.dataset.serviceConfig = descriptor.identity.serviceId
        section.root.dataset.configApplies = descriptor.configApplies
        const form = forms.form(`${plugin.id}-${descriptor.identity.serviceId}`)
        form.dataset.serviceConfigForm = descriptor.identity.serviceId
        const configuration = descriptor.configuration as unknown as Record<string, CordisXJsonValue>
        const field: CordisXConfigFieldSnapshot = {
          namespace: plugin.id,
          path: ['providers'],
          type: 'array',
          label: productLocale(locale) === 'zh-CN' ? 'Provider 列表' : 'Provider list',
          description: productLocale(locale) === 'zh-CN'
            ? '使用已声明的 providerId、端点和模型映射；凭据引用由 Host 安全保管。'
            : 'Use declared providerId, endpoint, and model mappings; credential references stay Host-managed.',
          value: Array.isArray(configuration.providers) ? configuration.providers : [],
          disabled: !descriptor.writable,
          required: true,
        }
        const item = forms.item({ id: `cxm-service-${descriptor.identity.serviceId}-providers`, label: field.label!, ...(field.description === undefined ? {} : { help: field.description }), required: true, fullWidth: true })
        item.root.dataset.serviceConfigPath = `${descriptor.identity.serviceId}.providers`
        const candidate = (typeof globalThis.structuredClone === 'function'
          ? globalThis.structuredClone(descriptor.configuration)
          : JSON.parse(JSON.stringify(descriptor.configuration))) as Record<string, CordisXJsonValue>
        let dirty = false
        const control = forms.control(field, item.label.htmlFor, (value, issue) => {
          item.setError(issue)
          if (issue === undefined && Array.isArray(value)) {
            candidate.providers = value as unknown as CordisXJsonValue
            dirty = true
            setTDesignDisabled(save, false)
          } else {
            setTDesignDisabled(save, true)
          }
        })
        forms.connect(item, control)
        item.control.append(control.root)
        section.content.append(item.root)
        const footer = create(document, 'div', 'cxf-actions cxm-service-config-footer')
        const status = create(document, 'span', 'cxf-status')
        status.setAttribute('role', 'status')
        if (descriptor.restartRequired) {
          status.dataset.state = 'dirty'
          status.textContent = productLocale(locale) === 'zh-CN' ? '已有候选配置，重启应用后生效。' : 'A candidate is waiting for app restart.'
        }
        const save = forms.button(productLocale(locale) === 'zh-CN' ? '保存 Provider 配置' : 'Save Provider configuration', { type: 'submit', variant: 'primary' })
        setTDesignDisabled(save, true)
        footer.append(status, save)
        form.append(section.root, footer)
        form.addEventListener('submit', event => {
          event.preventDefault()
          if (!dirty || item.root.dataset.invalid === 'true' || model.updateServiceConfig === undefined) return
          setTDesignDisabled(save, true)
          form.setAttribute('aria-busy', 'true')
          status.dataset.state = 'saving'
          status.textContent = hostConfigApplyMessage(descriptor.configApplies, 'saving', locale)
          const mutation: HostServiceConfigMutation = {
            contract: 'cordisx.service-config-mutation/v1', schemaVersion: 1,
            identity: descriptor.identity, scope: descriptor.scope, expectedRevision: descriptor.revision,
            configuration: candidate as unknown as HostServiceConfigMutation['configuration'],
          }
          void model.updateServiceConfig(mutation).then(async result => {
            if (result.status === 'rejected' || result.status === 'conflict') {
              const text = result.error.code === 'permission-denied'
                ? (productLocale(locale) === 'zh-CN' ? '没有权限修改 Provider 配置。' : 'You do not have permission to modify Provider configuration.')
                : result.error.code === 'conflict'
                  ? (productLocale(locale) === 'zh-CN' ? '配置已更新，请重新检查后再保存。' : 'Configuration changed; review it before saving again.')
                  : (productLocale(locale) === 'zh-CN' ? 'Provider 配置未保存。' : 'Provider configuration was not saved.')
              status.dataset.state = 'error'
              status.textContent = text
              return
            }
            status.dataset.state = 'saved'
            status.textContent = result.status === 'staged'
              ? (productLocale(locale) === 'zh-CN' ? '已保存，重启应用后生效。' : 'Saved; it takes effect after app restart.')
              : (productLocale(locale) === 'zh-CN' ? '已保存，Provider 服务已重启。' : 'Saved; the Provider service restarted.')
            dirty = false
            const fresh = await model.listServiceConfigs?.(plugin.id)
            if (fresh !== undefined) render(fresh)
          }).catch(error => {
            status.dataset.state = 'error'
            status.textContent = unavailable(error)
          }).finally(() => {
            form.removeAttribute('aria-busy')
          })
        })
        seat.append(form)
        if (descriptor.secrets.length > 0) {
          seat.append(forms.note(productLocale(locale) === 'zh-CN'
            ? '凭据仅以安全引用保存；此处不会显示或读取凭据值。'
            : 'Credentials are stored only as secure references; values are never displayed or read here.'))
        }
      }
    }
    void model.listServiceConfigs(plugin.id).then(render).catch(error => {
      if (!seat.isConnected) return
      seat.replaceChildren(forms.alert(unavailable(error), 'warning'))
    })
  }

  const renderPluginConfiguration = (plugin: ManagerPluginSnapshot, panel: HTMLElement): void => {
    const locale = model.snapshot().localization.locale
    const descriptor = plugin.configuration
    if (descriptor === undefined || descriptor.schemaKind !== 'schemastery') {
      panel.append(forms.empty(managerCopy(locale, 'form.empty-no-schema')))
      renderPluginServiceConfiguration(plugin, panel)
      return
    }
    const sensitiveRoles = ['secret', 'credential', 'credential-ref', 'permission', 'capability']
    // A schema can deliberately expose a stable, read-only reference alongside
    // editable settings. Keep that product-facing value in the Host form so it
    // retains its label, help, a11y relationship, and disabled TDesign chrome;
    // only actions and custom renderer mounting remain edit-only below.
    const visibleFields = descriptor.fields
    const editableFields = descriptor.writable ? visibleFields.filter(field => !field.disabled
      && !sensitiveRoles.includes(field.role ?? '') && selectHostFormPrimitive(field) !== 'unsupported') : []
    if (visibleFields.length === 0) {
      panel.append(forms.empty(managerCopy(locale, 'form.empty-no-fields')))
      renderPluginServiceConfiguration(plugin, panel)
      return
    }

    let draft = configDrafts.get(plugin.id)
    if (draft === undefined) {
      draft = { baseRevision: descriptor.revision, values: new Map(), operations: new Map(), issues: new Map(), state: 'pristine' }
      configDrafts.set(plugin.id, draft)
    } else if (draft.baseRevision !== descriptor.revision && draft.operations.size === 0) {
      draft.baseRevision = descriptor.revision
      if (draft.state !== 'saved') draft.state = 'pristine'
      delete draft.message
    }

    const form = forms.form(plugin.id)
    form.dataset.pluginConfigForm = plugin.id
    form.dataset.state = draft.state
    const groupKeys = new Set(visibleFields.map(field => field.group?.id ?? '__root__'))
    const needsGeneralHeading = groupKeys.size > 1
    let generalGrid: HTMLElement | undefined
    const groupGrids = new Map<string, HTMLElement>()
    const gridFor = (field: CordisXConfigFieldSnapshot): HTMLElement => {
      if (field.group !== undefined) {
        const existing = groupGrids.get(field.group.id)
        if (existing !== undefined) return existing
        const title = field.group.title
        if (title !== undefined || needsGeneralHeading) {
          const section = forms.section(title ?? managerCopy(locale, 'form.section-general'), field.group.description, field.group.icon)
          groupGrids.set(field.group.id, section.content)
          form.append(section.root)
          return section.content
        }
        const grid = forms.grid()
        groupGrids.set(field.group.id, grid)
        form.append(grid)
        return grid
      }
      if (generalGrid !== undefined) return generalGrid
      if (needsGeneralHeading) {
        const section = forms.section(managerCopy(locale, 'form.section-general'))
        generalGrid = section.content
        form.append(section.root)
      } else {
        generalGrid = forms.grid()
        form.append(generalGrid)
      }
      return generalGrid
    }
    let submit: TDesignButtonElement | undefined
    let actions: HTMLElement | undefined
    for (const [index, field] of visibleFields.entries()) {
      const grid = gridFor(field)
      const pathKey = JSON.stringify(field.path)
      const controlId = `cxm-config-${plugin.id}-${index}`
      const sensitive = field.role !== undefined && sensitiveRoles.includes(field.role)
      const primitive = selectHostFormPrimitive(field)
      const item = forms.item({
        id: controlId,
        label: fieldLabel(field),
        ...(field.description === undefined ? {} : { help: field.description }),
        required: field.required,
        ...(field.icon === undefined ? {} : { icon: field.icon }),
        fullWidth: sensitive || ['textarea', 'json-textarea', 'path-input', 'tag-input', 'multi-select', 'object-array', 'unsupported'].includes(primitive),
      })
      item.root.dataset.configPath = field.path.join('.')
      item.root.dataset.hostFormPrimitive = primitive

      if (sensitive) {
        const control = forms.control(field, controlId, () => undefined)
        forms.connect(item, control)
        item.control.append(control.root)
        grid.append(item.root)
        continue
      }

      const setDraft = (value: unknown, issue?: string): void => {
        draft!.values.set(pathKey, value)
        draft!.operations.set(pathKey, value === undefined
          ? { op: 'unset', path: field.path }
          : { op: 'set', path: field.path, value: value as CordisXJsonValue })
        const locale = model.snapshot().localization.locale
        const validationIssue = issue ?? validateHostFormValue(field, value, locale)
        if (validationIssue === undefined) draft!.issues.delete(pathKey)
        else draft!.issues.set(pathKey, validationIssue)
        item.setError(validationIssue)
        draft!.state = 'dirty'
        delete draft!.message
        form.dataset.state = 'dirty'
        const status = actions?.querySelector<HTMLElement>('.cxf-status')
          ?? form.querySelector<HTMLElement>('.cxf-status')
        if (status !== null) {
          status.dataset.state = 'dirty'
          status.textContent = hostConfigApplyMessage(descriptor.applies, 'dirty', locale)
        }
        if (actions !== undefined && !actions.isConnected) form.insertBefore(actions, form.firstChild)
        if (submit !== undefined) setTDesignDisabled(submit, !descriptor.writable || busyPluginId !== undefined
          || draft!.operations.size === 0 || draft!.issues.size > 0)
      }
      const renderedField = {
        ...field,
        ...(draft.values.has(pathKey) ? { value: draft.values.get(pathKey) } : {}),
        disabled: field.disabled || !descriptor.writable,
      }
      const defaultHolder = create(document, 'div')
      const control = forms.control(renderedField, controlId, setDraft)
      forms.connect(item, control)
      defaultHolder.append(control.root)
      item.control.append(defaultHolder)
      item.setError(draft.issues.get(pathKey))
      if (model.mountConfigRenderer !== undefined && !field.disabled && descriptor.writable) {
        const custom = create(document, 'div', 'cxm-config-renderer cxf-custom-seat')
        custom.hidden = true
        item.control.append(custom)
        void model.mountConfigRenderer(plugin.id, renderedField, custom, setDraft).then(mount => {
          if (!item.root.isConnected) {
            void mount.dispose()
            return
          }
          configRendererMounts.add(mount)
          if (mount.mounted) {
            custom.hidden = false
            const focusable = custom.querySelector<HTMLElement>('input,select,textarea,button,[tabindex]')
            if (focusable !== null) {
              if (focusable.id === '') focusable.id = controlId
              focusable.dataset.hostFormPrimitive = 'custom'
              focusable.setAttribute('aria-describedby', [item.help?.id, item.error.id].filter(Boolean).join(' '))
              if (field.required) focusable.setAttribute('aria-required', 'true')
            }
            defaultHolder.remove()
          }
        }).catch(() => undefined)
      }
      if (descriptor.writable) {
        const fieldMenu = forms.fieldActionMenu({
          label: fieldLabel(field),
          ...(field.icon === undefined ? {} : { icon: field.icon }),
          canUseDefault: () => field.hasDefault === true,
          hasFieldDraft: () => draft!.operations.has(pathKey),
          useDefault: () => {
            if (field.hasDefault !== true) return
            const defaultValue = field.defaultValue
            draft!.values.set(pathKey, defaultValue)
            draft!.operations.set(pathKey, { op: 'unset', path: field.path })
            const issue = validateHostFormValue(field, defaultValue, model.snapshot().localization.locale)
            if (issue === undefined) draft!.issues.delete(pathKey)
            else draft!.issues.set(pathKey, issue)
            draft!.state = 'dirty'
            delete draft!.message
            renderContent()
          },
          rollback: () => {
            draft!.values.delete(pathKey)
            draft!.operations.delete(pathKey)
            draft!.issues.delete(pathKey)
            draft!.state = draft!.operations.size === 0 ? 'pristine' : 'dirty'
            delete draft!.message
            renderContent()
          },
          copyPath: async () => {
            const clipboard = document.defaultView?.navigator.clipboard
            if (typeof clipboard?.writeText !== 'function') return false
            try {
              await clipboard.writeText(field.path.join('.'))
              return true
            } catch {
              return false
            }
          },
        })
        item.labelRow.prepend(fieldMenu.trigger)
        configFieldActionMenus.add(fieldMenu)
      }
      grid.append(item.root)
    }
    if (editableFields.length > 0) {
      actions = create(document, 'div', 'cxf-actions cxf-form-footer')
      const status = create(document, 'span', 'cxf-status')
      status.dataset.state = draft.state
      status.setAttribute('role', 'status')
      status.textContent = draft.state === 'saving' ? hostConfigApplyMessage(descriptor.applies, 'saving', locale)
        : draft.state === 'saved' ? hostConfigApplyMessage(descriptor.applies, 'saved', locale)
          : draft.operations.size > 0 ? hostConfigApplyMessage(descriptor.applies, 'dirty', locale) : ''
      const resetDraft = forms.button(managerCopy(locale, 'form.undo-changes'), {
        action: 'undo', density: 'icon',
        ...(descriptor.actionIcons?.reset === undefined ? {} : { icon: descriptor.actionIcons.reset }),
      })
      setTDesignDisabled(resetDraft, draft.operations.size === 0 || busyPluginId !== undefined)
      resetDraft.addEventListener('click', () => {
        draft!.values.clear()
        draft!.operations.clear()
        draft!.issues.clear()
        draft!.state = 'pristine'
        delete draft!.message
        renderContent()
      })
      submit = forms.button(busyPluginId === plugin.id ? managerCopy(locale, 'form.saving') : managerCopy(locale, 'form.save-configuration'), {
        type: 'submit', variant: 'primary', density: 'icon', action: 'save',
        ...(descriptor.actionIcons?.save === undefined ? {} : { icon: descriptor.actionIcons.save }),
      })
      setTDesignDisabled(submit, !descriptor.writable || busyPluginId !== undefined || draft.operations.size === 0 || draft.issues.size > 0)
      actions.append(status, resetDraft, submit)
      if (draft.operations.size > 0 || ['saving', 'saved', 'conflict', 'error'].includes(draft.state)) form.insertBefore(actions, form.firstChild)
      form.addEventListener('submit', async (event) => {
        event.preventDefault()
        if (model.updatePluginConfig === undefined || draft!.operations.size === 0 || draft!.issues.size > 0) return
        busyPluginId = plugin.id
        draft!.state = 'saving'
        delete draft!.message
        setTDesignDisabled(submit!, true)
        submit!.setAttribute('aria-label', managerCopy(model.snapshot().localization.locale, 'form.saving'))
        submit!.setAttribute('title', managerCopy(model.snapshot().localization.locale, 'form.saving'))
        status.dataset.state = 'saving'
        status.textContent = hostConfigApplyMessage(descriptor.applies, 'saving', model.snapshot().localization.locale)
        form.setAttribute('aria-busy', 'true')
        try {
          await model.updatePluginConfig(plugin.id, draft!.baseRevision, [...draft!.operations.values()])
          draft!.values.clear()
          draft!.operations.clear()
          draft!.issues.clear()
          draft!.state = 'saved'
          draft!.message = managerCopy(locale, 'form.configuration-saved')
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          draft!.state = /conflict|revision/iu.test(message) ? 'conflict' : 'error'
          draft!.message = draft!.state === 'conflict'
            ? managerCopy(locale, 'form.conflict-retained')
            : managerCopy(model.snapshot().localization.locale, 'form.configuration-save-failed')
        } finally {
          busyPluginId = undefined
          renderContent()
        }
      })
    }
    panel.append(form)
    if (!descriptor.writable) panel.append(forms.note(managerCopy(locale, 'form.readonly-note')))
    if (draft.message !== undefined) panel.append(forms.alert(draft.message, draft.state === 'saved' ? 'info' : 'error'))
    renderPluginServiceConfiguration(plugin, panel)
  }

  const mountLunaConsole = (
    container: HTMLElement,
    projections: readonly PluginConsoleLunaEntryProjection[],
    pluginId: string,
    latest: HTMLButtonElement,
  ): void => {
    const state = consoleScrollStates.get(pluginId) ?? { follow: true, scrollTop: 0 }
    consoleScrollStates.set(pluginId, state)
    let desiredTheme = resolveHostTheme(document).theme
    interface LunaLogRecord {
      readonly container: HTMLElement
      copy(): void
      select(): void
    }
    interface LunaConsoleViewer {
      destroy(): void
      setOption(name: string, value: unknown): void
      renderViewport(options?: unknown): void
      on(name: string, listener: (record: LunaLogRecord) => void): void
      insert(options: {
        readonly type: CordisXPluginConsoleEntryV1['method']
        readonly args: readonly unknown[]
        readonly header: { readonly time: string; readonly from: string }
      }): void
    }
    let viewer: LunaConsoleViewer | undefined
    let resizeObserver: ResizeObserver | undefined
    let destroyed = false
    const entriesByRecord = new WeakMap<LunaLogRecord, CordisXPluginConsoleEntryV1>()
    let pendingEntry: CordisXPluginConsoleEntryV1 | undefined
    const isAtBottom = (): boolean => container.scrollHeight - container.clientHeight - container.scrollTop <= 4
    const syncLatest = (): void => { latest.hidden = state.follow || container.scrollHeight <= container.clientHeight + 4 }
    const scrollToLatest = (): void => {
      state.follow = true
      container.scrollTop = container.scrollHeight
      state.scrollTop = container.scrollTop
      syncLatest()
    }
    const onScroll = (): void => {
      state.scrollTop = container.scrollTop
      state.follow = isAtBottom()
      syncLatest()
    }
    const focusReplacement = (): void => queueMicrotask(() => {
      ;[...document.querySelectorAll<HTMLElement>('[data-plugin-console]')]
        .find(item => item.dataset.pluginConsole === pluginId)?.focus()
    })
    const selectRelative = (offset: number): void => {
      if (projections.length === 0) return
      const current = projections.findIndex(item => item.entry.entryId === selectedConsoleEntry)
      const next = Math.max(0, Math.min(projections.length - 1, (current < 0 ? (offset > 0 ? -1 : projections.length) : current) + offset))
      selectedConsoleEntry = projections[next]?.entry.entryId
      state.scrollTop = container.scrollTop
      renderContent()
      focusReplacement()
    }
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        selectRelative(event.key === 'ArrowDown' ? 1 : -1)
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'c' && selectedConsoleEntry !== undefined) {
        const selected = projections.find(item => item.entry.entryId === selectedConsoleEntry)?.entry
        if (selected !== undefined) {
          event.preventDefault()
          void copyConsoleText(pluginConsoleEntryCopyText(selected)).catch(() => undefined)
        }
      }
    }
    const onLatest = (): void => scrollToLatest()
    container.tabIndex = 0
    container.setAttribute('aria-label', 'Luna Console 插件控制台正文；使用上下方向键选择记录')
    container.addEventListener('scroll', onScroll)
    container.addEventListener('keydown', onKeydown)
    latest.addEventListener('click', onLatest)
    const restoreScroll = (): void => {
      if (destroyed) return
      if (state.follow) container.scrollTop = container.scrollHeight
      else container.scrollTop = Math.min(state.scrollTop, Math.max(0, container.scrollHeight - container.clientHeight))
      state.scrollTop = container.scrollTop
      syncLatest()
    }
    const refreshLunaViewport = (): void => {
      viewer?.renderViewport()
      const view = document.defaultView
      if (view?.requestAnimationFrame !== undefined) {
        view.requestAnimationFrame(() => {
          if (destroyed) return
          viewer?.renderViewport()
          restoreScroll()
        })
      } else queueMicrotask(() => {
        if (!destroyed) {
          viewer?.renderViewport()
          restoreScroll()
        }
      })
    }
    const mount = {
      destroy: (): void => {
        if (destroyed) return
        destroyed = true
        resizeObserver?.disconnect()
        container.removeEventListener('scroll', onScroll)
        container.removeEventListener('keydown', onKeydown)
        latest.removeEventListener('click', onLatest)
        viewer?.destroy()
        lunaConsoleMounts.delete(mount)
      },
      setTheme: (theme: 'dark' | 'light'): void => {
        desiredTheme = theme
        viewer?.setOption('theme', theme)
      },
    }
    lunaConsoleMounts.add(mount)
    void import('luna-console').then(module => {
      if (destroyed || !container.isConnected) return
      const Constructor = module.default as unknown as new (
        target: HTMLElement,
        options?: {
          readonly asyncRender?: boolean
          readonly showHeader?: boolean
          readonly accessGetter?: boolean
          readonly unenumerable?: boolean
          readonly lazyEvaluation?: boolean
          readonly maxNum?: number
          readonly theme?: 'dark' | 'light'
        },
      ) => LunaConsoleViewer
      viewer = new Constructor(container, {
        asyncRender: false, showHeader: true, accessGetter: false, unenumerable: true,
        lazyEvaluation: false, maxNum: 2000, theme: desiredTheme,
      })
      viewer.on('insert', (record) => {
        if (pendingEntry === undefined) return
        entriesByRecord.set(record, pendingEntry)
        record.container.dataset.consoleEntry = pendingEntry.entryId
        record.container.dataset.consoleMethod = pendingEntry.method
        record.container.dataset.consoleSource = pendingEntry.source
      })
      viewer.on('select', (record) => {
        const entry = entriesByRecord.get(record)
        if (entry === undefined || selectedConsoleEntry === entry.entryId) return
        selectedConsoleEntry = entry.entryId
        state.scrollTop = container.scrollTop
        renderContent()
      })
      for (const projection of projections) {
        pendingEntry = projection.entry
        viewer.insert({ type: projection.type, args: projection.args, header: projection.header })
      }
      pendingEntry = undefined
      // Luna virtualizes against the dimensions present at construction. A tab
      // can be connected before it is visible, so refresh after inserting the
      // first records and again on the next frame.
      refreshLunaViewport()
      const ResizeObserverConstructor = document.defaultView?.ResizeObserver
      if (ResizeObserverConstructor !== undefined) {
        resizeObserver = new ResizeObserverConstructor(() => {
          viewer?.renderViewport()
          if (state.follow) scrollToLatest()
          else syncLatest()
        })
        resizeObserver.observe(container)
        const space = container.querySelector<HTMLElement>('.luna-console-logs-space')
        if (space !== null) resizeObserver.observe(space)
      }
      refreshLunaViewport()
    }).catch((error: unknown) => {
      if (destroyed) return
      container.classList.remove('cxm-console-luna')
      const reason = error instanceof Error ? error.message : 'unknown renderer error'
      container.replaceChildren(create(document, 'div', 'cxm-console-empty', `Luna Console 正文组件加载失败：${reason}`))
    })
  }

  const copyConsoleText = async (value: string): Promise<void> => {
    const clipboard = document.defaultView?.navigator.clipboard
    if (clipboard !== undefined) {
      await clipboard.writeText(value)
      return
    }
    const textarea = create(document, 'textarea')
    textarea.value = value
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    ;(document.body ?? document.documentElement).append(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }

  const exportPluginConsole = (pluginId: string, page: CordisXPluginConsolePageV1): void => {
    const view = document.defaultView
    if (view === null || typeof view.Blob !== 'function' || typeof view.URL.createObjectURL !== 'function') return
    const payload = serializePluginConsoleExport(page)
    const url = view.URL.createObjectURL(new view.Blob([payload], { type: 'application/json' }))
    const link = create(document, 'a')
    link.href = url
    link.download = `${pluginId}-logs.json`
    link.hidden = true
    document.body.append(link)
    link.click()
    link.remove()
    view.setTimeout(() => view.URL.revokeObjectURL(url), 0)
  }

  const renderPluginDetail = (snapshot: ManagerSnapshot, id: string): void => {
    const plugin = snapshot.plugins.find(item => item.id === id)
    setHeading(copy('plugins.heading'), snapshot)
    if (plugin === undefined) {
      content.append(create(document, 'div', 'cxm-empty', '插件已不在当前 bundle 中'))
      return
    }
    const activeFacet = routeState.kind === 'plugin' ? routeState.facet : 'readme'
    content.append(createLocalTabs(document, localizeTabs(PLUGIN_DETAIL_TABS), activeFacet, 'data-plugin-detail-tab', (tab) => {
      void navigateRoute({ kind: 'plugin', pluginId: id, facet: tab as PluginDetailTab })
    }))

    if (activeFacet === 'readme') {
      const panel = createTabPanel(document, copy('plugin-tab.readme'))
      if (plugin.readme?.trim() === '') {
        panel.append(create(document, 'div', 'cxm-empty', '该插件没有随当前 bundle 提供 README.md'))
      } else if (plugin.readme === undefined) {
        panel.append(create(document, 'div', 'cxm-empty', '该插件没有随当前 bundle 提供 README.md'))
      } else {
        const readme = renderSafeMarkdown(document, plugin.readme)
        panel.append(readme)
        // Safe Markdown creates text-only DOM synchronously. Shiki merely
        // projects its fenced-code text into Host-owned token spans afterward.
        void highlightSafeMarkdownCodeBlocks(readme, resolveHostTheme(document).theme).catch(() => undefined)
      }
      content.append(panel)
      return
    }

    if (activeFacet === 'config') {
      const panel = createTabPanel(document, copy('plugin-tab.configuration'))
      renderPluginConfiguration(plugin, panel)
      content.append(panel)
      return
    }

    if (activeFacet === 'permissions') {
      const panel = createTabPanel(document, copy('plugin-tab.permissions'))
      const permissions = snapshot.permissions.filter(item => item.identity.source === plugin.source && item.identity.id === plugin.id)
      if (permissions.length === 0) {
        panel.append(create(document, 'div', 'cxm-empty', '该插件没有申请任何权限。'))
      }
      const permissionList = create(document, 'div')
      permissionList.classList.add('cxm-flat-list', 'cxm-settings-group')
      permissionList.setAttribute('role', 'list')
      permissionList.dataset.managerGroup = 'capability-declarations'
      for (const permission of permissions) {
        const presentation = capabilityPresentation(permission.capability)
        const item = create(document, 'div', 'cxm-flat-item cxm-permission-item')
        item.setAttribute('role', 'listitem')
        item.setAttribute('aria-label', presentation.name)
        item.dataset.permissionItem = permission.capability
        const open = create(document, 'button', 'cxm-permission-open')
        open.type = 'button'
        open.dataset.permissionOpen = permission.capability
        const copy = create(document, 'span', 'cxm-permission-copy')
        const title = create(document, 'span', 'cxm-permission-title')
        title.append(create(document, 'span', 'cxm-permission-name', presentation.name))
        if (permission.required) title.append(create(document, 'span', 'cxm-required-badge', '必需'))
        copy.append(title, create(document, 'span', 'cxm-permission-reason', permission.reasonText))
        open.append(createCapabilityIcon(document, permission.capability), copy)
        activateManagerListRow(open, () => {
          operationError = undefined
          void navigateRoute({ kind: 'permission', pluginId: plugin.id, capability: permission.capability, fingerprint: permission.fingerprint })
        })
        const control = create(document, 'div', 'cxm-permission-control')
        control.append(
          createPermissionPolicySelect(forms, permission, async (policy, select) => {
            await commitPermissionPolicy(plugin.id, permission, policy, select)
          }),
        )
        item.append(open, control)
        permissionList.append(item)
      }
      if (permissions.length > 0) panel.append(permissionList)
      if (operationError !== undefined) panel.append(create(document, 'div', 'cxm-error', operationError))
      content.append(panel)
      return
    }

    const pluginRegistrations = snapshot.registrations.filter(item => item.owner === plugin.id)
    const pluginCommands = snapshot.commands.filter(item => item.owner === plugin.id)
    const pluginRoutes = snapshot.navigation.routes.filter(item => item.owner === plugin.id)
    const pluginPages = snapshot.navigation.pages.filter(item => item.owner === plugin.id)
    const appendRuntimeDiagnostics = (target: HTMLElement): void => {
      const runtimeDiagnostics = create(document, 'details', 'cxm-diagnostics')
      runtimeDiagnostics.dataset.runtimeDiagnostics = 'platform'
      runtimeDiagnostics.append(create(document, 'summary', undefined, copy('runtime.diagnostics')))
      const diagnosticsBody = create(document, 'div', 'cxm-diagnostics-body')
      let hasDiagnostics = false
      if (plugin.error !== undefined) {
        diagnosticsBody.append(create(document, 'div', 'cxm-error', plugin.error))
        hasDiagnostics = true
      }
      if (plugin.blockedReason !== undefined) {
        diagnosticsBody.append(create(document, 'div', 'cxm-error', plugin.blockedReason))
        hasDiagnostics = true
      }
      if (operationError !== undefined) {
        diagnosticsBody.append(create(document, 'div', 'cxm-error', operationError))
        hasDiagnostics = true
      }
      if (plugin.configuration !== undefined && !plugin.configuration.writable) {
        const configSchema = plugin.configuration.schemaKind === 'schemastery'
          ? 'Schemastery'
          : plugin.configuration.schemaKind === 'standard' ? 'Standard Schema' : copy('runtime.not-declared')
        const configurationDiagnostics = create(document, 'div', 'cxm-copy', `${copy('runtime.configuration')}: ${configSchema} · ${plugin.configuration.applies} · ${copy('runtime.revision')} ${plugin.configuration.revision} · ${copy('runtime.last-good')} ${plugin.configuration.lastGoodRevision} · ${copy('runtime.writer')} ${plugin.configuration.writable ? copy('runtime.available') : copy('runtime.unavailable')}`)
        configurationDiagnostics.dataset.configDiagnostics = plugin.id
        diagnosticsBody.append(configurationDiagnostics)
        hasDiagnostics = true
      }
      for (const provider of (snapshot.capabilityProviders ?? []).filter(item => item.kind !== 'current-connection' && item.status !== 'supported')) {
        diagnosticsBody.append(create(document, 'div', 'cxm-copy', `${provider.providerNameText} · ${capabilityAvailabilityLabel(provider.status, snapshot.localization.locale)} · ${provider.reasonText}`))
        hasDiagnostics = true
      }
      const adapter = snapshot.platform
      for (const diagnostic of adapter.diagnostics) {
        diagnosticsBody.append(create(document, 'div', 'cxm-error', `${diagnostic.code} · ${diagnostic.message}`))
        hasDiagnostics = true
      }
      const unattributed = (model.pluginConsole?.(plugin.id)?.unattributedEntries ?? 0)
      if (unattributed > 0 && dismissedConsoleWarnings.get(plugin.id) !== unattributed) {
        const warning = create(document, 'div', 'cxm-notice cxm-console-warning')
        warning.dataset.tone = 'warning'
        warning.append(create(document, 'span', undefined, copy('console.ownership-warning').replace('{count}', String(unattributed))))
        const dismissWarning = managerIconAction('close', copy('console.dismiss-ownership-warning'))
        dismissWarning.addEventListener('click', () => { dismissedConsoleWarnings.set(plugin.id, unattributed); renderContent() })
        warning.append(dismissWarning)
        diagnosticsBody.append(warning)
        hasDiagnostics = true
      }
      if (!hasDiagnostics) return
      runtimeDiagnostics.append(diagnosticsBody)
      target.append(runtimeDiagnostics)
    }
    if (activeFacet === 'runtime') {
      const panel = createTabPanel(document, copy('plugin-tab.runtime'))
      const blocked = plugin.status === 'blocked' || plugin.status === 'failed'
      const permissionBlocked = plugin.status === 'permission-blocked'
      const restorable = blocked || permissionBlocked
      const overview = create(document, 'section', 'cxm-runtime-overview')
      const status = create(document, 'section', 'cxm-runtime-status')
      status.dataset.pluginRuntimeStatus = plugin.id
      const icon = create(document, 'span', 'cxm-runtime-status-icon')
      icon.append(createManagerIcon(document, plugin.status === 'active' ? 'runtime' : 'diagnostics'))
      const statusCopy = create(document, 'span', 'cxm-runtime-status-copy')
      const hasDetail = plugin.error !== undefined || plugin.blockedReason !== undefined
      statusCopy.append(
        create(document, 'span', 'cxm-runtime-status-label', statusLabel(plugin.status, snapshot.localization.locale)),
        create(document, 'span', 'cxm-runtime-status-meta', hasDetail ? copy('runtime.status-details') : copy('runtime.healthy')),
      )
      status.append(icon, statusCopy)
      if (plugin.status !== 'configured-disabled') {
        const action = managerIconAction(restorable ? 'enable-plugin' : 'disable-plugin', restorable ? copy('runtime.reauthorize') : copy('runtime.block-plugin'), { disabled: busyPluginId !== undefined })
        action.dataset.pluginRuntimeAction = plugin.id
        action.addEventListener('click', async () => {
          busyPluginId = plugin.id
          renderContent()
          try { if (restorable) await authorizeAndRestore(plugin); else await model.setPluginBlocked(plugin.id, true) }
          catch (error) { operationError = error instanceof Error ? error.message : String(error) }
          finally { busyPluginId = undefined; renderContent() }
        })
        status.append(action)
      }
      const facts = create(document, 'div', 'cxm-runtime-status-facts')
      for (const [label, value] of [
        [copy('runtime.active-contributions'), pluginRegistrations.filter(item => item.visible && item.valid).length],
        [copy('runtime.commands'), pluginCommands.length],
      ] as const) {
        const fact = create(document, 'span', 'cxm-runtime-status-fact')
        fact.append(create(document, 'strong', undefined, String(value)), create(document, 'span', undefined, label))
        facts.append(fact)
      }
      overview.append(status, facts)
      const consolePage = model.pluginConsole?.(plugin.id) ?? {
        contract: 'cordisx.plugin-console-page/v1' as const, schemaVersion: 1 as const,
        plugin: { source: plugin.source, pluginId: plugin.id }, generation: 'manager-unavailable',
        generatedAt: Date.now(), partialObservability: true, entries: [],
      }
      const consoleSummary = summarizePluginConsole(consolePage)
      const consoleOverview = create(document, 'section', 'cxm-runtime-console-summary')
      consoleOverview.dataset.runtimeConsoleSummary = plugin.id
      consoleOverview.setAttribute('aria-label', copy('console.performance'))
      for (const [label, value] of [
        [copy('console.requests'), consoleSummary.requests],
        [copy('console.successes'), consoleSummary.successes],
        [copy('console.failures'), consoleSummary.failures],
        [copy('console.denied'), consoleSummary.denials],
      ] as const) {
        const metric = create(document, 'div', 'cxm-runtime-console-metric')
        metric.append(create(document, 'strong', undefined, String(value)), create(document, 'span', undefined, label))
        consoleOverview.append(metric)
      }
      const performance = create(document, 'details', 'cxm-runtime-console-performance')
      performance.append(create(document, 'summary', undefined, `${copy('console.performance')} ${consoleSummary.averageDurationMs === undefined ? '—' : `${consoleSummary.averageDurationMs.toFixed(1)}ms`}`))
      performance.append(create(document, 'div', 'cxm-runtime-console-performance-body', consoleSummary.consumption.length === 0
        ? copy('console.no-host-api-metrics')
        : consoleSummary.consumption.join('   ')))
      consoleOverview.append(performance)
      overview.append(consoleOverview)
      panel.append(overview)
      if (operationError !== undefined) {
        const notice = create(document, 'div', 'cxm-notice', copy('runtime.status-attention'))
        notice.dataset.tone = 'warning'
        panel.append(notice)
      }
      content.append(panel)
      return
    }
    if (activeFacet === 'logs') {
      const panel = createTabPanel(document, copy('plugin-tab.logs'))
      panel.classList.add('cxm-console-panel')
      const livePage = model.pluginConsole?.(plugin.id) ?? {
        contract: 'cordisx.plugin-console-page/v1', schemaVersion: 1,
        plugin: { source: plugin.source, pluginId: plugin.id }, generation: 'manager-unavailable',
        generatedAt: Date.now(), partialObservability: true, entries: [],
      }
      if (consolePaused && (consolePausedPage === undefined || consolePausedPage.plugin.pluginId !== plugin.id)) consolePausedPage = livePage
      const page = consolePaused ? consolePausedPage ?? livePage : livePage
      const sources = [...new Set(page.entries.map(entry => entry.source))].sort()
      const normalizedQuery = consoleQuery.trim().toLocaleLowerCase()
      const filtered = page.entries.filter(entry => (
        (consoleMethod === 'all' || entry.method === consoleMethod)
        && (consoleKind === 'all'
          || consoleKind === 'host-api' && (entry.kind === 'invocation' || entry.kind === 'permission')
          || entry.kind === consoleKind)
        && (consoleSource === 'all' || entry.source === consoleSource)
        && (normalizedQuery === '' || `${entry.message} ${entry.source} ${entry.correlationId ?? ''} ${entry.args.map(argument => argument.preview).join(' ')}`.toLocaleLowerCase().includes(normalizedQuery))
      ))
      const projections = filtered.map(projectPluginConsoleEntryForLuna)
      const controls = create(document, 'div', 'cxm-console-controls')
      const search = create(document, 'input')
      search.type = 'search'
      search.placeholder = copy('console.search-placeholder')
      search.value = consoleQuery
      search.dataset.consoleSearch = plugin.id
      search.addEventListener('input', () => { consoleQuery = search.value; renderContent() })
      const select = (label: string, value: string, values: readonly string[], change: (value: string) => void): TDesignSelectElement<string> => forms.select(
        label,
        values.map(item => ({ value: item, label: item === 'all' ? copy('console.all') : item })),
        value,
        next => {
          if (next === undefined) return
          change(next)
          renderContent()
        },
      )
      controls.append(
        search,
        select(copy('console.level'), consoleMethod, ['all', 'debug', 'log', 'info', 'warn', 'error'], value => { consoleMethod = value }),
        select(copy('console.kind'), consoleKind, ['all', 'host-api', 'console', 'lifecycle', 'diagnostic'], value => { consoleKind = value }),
        select(copy('console.source'), consoleSource, ['all', ...sources], value => { consoleSource = value }),
      )
      const scrollState = consoleScrollStates.get(plugin.id) ?? { follow: true, scrollTop: 0 }
      consoleScrollStates.set(plugin.id, scrollState)
      const actionToolbar = create(document, 'div', 'cxm-console-action-toolbar')
      actionToolbar.setAttribute('role', 'toolbar')
      actionToolbar.setAttribute('aria-label', copy('console.toolbar'))
      const iconAction = (
        action: string,
        icon: ManagerIconToken,
        label: string,
        options: { readonly pressed?: boolean; readonly disabled?: boolean; readonly description?: string } = {},
        invoke: () => void,
      ): HTMLButtonElement => {
        const button = create(document, 'button', 'cxm-manager-icon-action')
        button.type = 'button'
        button.dataset.consoleAction = action
        button.dataset.cordisxNoDrag = 'true'
        button.setAttribute('aria-label', label)
        if (options.pressed !== undefined) button.setAttribute('aria-pressed', String(options.pressed))
        if (options.description !== undefined) button.setAttribute('aria-description', options.description)
        button.disabled = options.disabled === true
        button.append(createManagerIcon(document, icon))
        button.addEventListener('click', invoke)
        button.addEventListener('keydown', event => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          event.stopPropagation()
          button.click()
        })
        tooltips.attach(button, () => options.description === undefined ? label : `${label} · ${options.description}`, 'top', 80)
        return button
      }
      const pauseLabel = consolePaused ? copy('console.resume') : copy('console.pause')
      const pause = iconAction('pause', consolePaused ? 'console-resume' : 'console-pause', pauseLabel, { pressed: consolePaused }, () => {
        consolePaused = !consolePaused
        consolePausedPage = consolePaused ? model.pluginConsole?.(plugin.id) ?? livePage : undefined
        renderContent()
      })
      const followLabel = scrollState.follow ? copy('console.stop-following') : copy('console.follow')
      const autoScroll = iconAction('follow', 'console-follow', followLabel, { pressed: scrollState.follow }, () => {
        scrollState.follow = !scrollState.follow
        renderContent()
      })
      const clear = iconAction('clear', 'console-clear', copy('console.clear'), {
        disabled: page.entries.length === 0,
        description: copy('console.irreversible'),
      }, () => {
        model.clearPluginConsole?.(plugin.id)
        selectedConsoleEntry = undefined
        consolePausedPage = undefined
        renderContent()
      })
      const selected = page.entries.find(entry => entry.entryId === selectedConsoleEntry)
      const copyButton = iconAction('copy', 'console-copy', copy('console.copy'), { disabled: selected === undefined }, () => {
        if (selected !== undefined) void copyConsoleText(pluginConsoleEntryCopyText(selected)).catch(() => undefined)
      })
      const exportButton = iconAction('export', 'console-export', copy('console.export'), { disabled: page.entries.length === 0 }, () => {
        exportPluginConsole(plugin.id, page)
      })
      actionToolbar.append(pause, autoScroll, clear, copyButton, exportButton)
      controls.append(actionToolbar)
      panel.append(controls)

      const workspace = create(document, 'div', 'cxm-console-workspace')
      const body = create(document, 'div', 'cxm-console-body')
      const frame = create(document, 'div', 'cxm-console-frame')
      frame.dataset.pluginConsole = plugin.id
      if (projections.length === 0) {
        frame.append(create(document, 'div', 'cxm-console-empty', page.entries.length === 0 ? copy('console.empty') : copy('console.no-matches')))
      } else {
        frame.classList.add('cxm-console-luna')
      }
      const latest = managerIconAction('console-follow', copy('console.back-to-latest'), { className: 'cxm-console-latest' })
      latest.hidden = true
      body.append(frame, latest)
      if (selected !== undefined) {
        workspace.dataset.inspector = 'true'
        const inspector = create(document, 'aside', 'cxm-console-inspector')
        inspector.dataset.consoleDetail = selected.entryId
        const inspectorHead = create(document, 'div', 'cxm-console-inspector-head')
        inspectorHead.append(create(document, 'span', undefined, copy('console.entry-details')))
        const closeInspector = managerIconAction('close', copy('console.close-details'))
        closeInspector.addEventListener('click', () => { selectedConsoleEntry = undefined; renderContent() })
        inspectorHead.append(closeInspector)
        const grid = create(document, 'dl', 'cxm-console-inspector-grid')
        const metadata: readonly (readonly [string, string | number | undefined])[] = [
          [copy('console.field.timestamp'), new Date(selected.time).toISOString()],
          [copy('console.field.plugin'), `${selected.plugin.pluginId} · ${selected.plugin.source}`],
          [copy('console.field.generation'), selected.generation],
          [copy('console.field.source'), selected.source],
          [copy('console.field.kind'), selected.kind],
          [copy('console.field.coverage'), selected.coverage],
          [copy('console.field.correlation'), selected.correlationId],
          [copy('console.field.phase'), selected.phase],
          [copy('console.field.status'), selected.status],
          [copy('console.field.duration'), selected.durationMs === undefined ? undefined : `${selected.durationMs.toFixed(1)}ms`],
          [copy('console.field.session'), selected.sessionId],
          [copy('console.field.trigger'), selected.trigger === undefined ? undefined : `${selected.trigger.kind}${selected.trigger.registrationId === undefined ? '' : ` · ${selected.trigger.registrationId}`}`],
          [copy('console.field.owner'), selected.effectiveOwner === undefined ? undefined : `${selected.effectiveOwner.pluginId} · ${selected.effectiveOwner.source}`],
          [copy('console.field.request-metrics'), selected.request === undefined ? undefined : JSON.stringify(selected.request)],
          [copy('console.field.result-metrics'), selected.result === undefined ? undefined : JSON.stringify(selected.result)],
        ]
        for (const [label, value] of metadata) {
          if (value === undefined) continue
          grid.append(create(document, 'dt', undefined, label), create(document, 'dd', undefined, String(value)))
        }
        inspector.append(inspectorHead, grid)
        workspace.append(body, inspector)
      } else workspace.append(body)
      panel.append(workspace)
      if (projections.length > 0) mountLunaConsole(frame, projections, plugin.id, latest)
      // The console page only carries actionable diagnostics. Runtime status
      // and API summaries stay on the dedicated Runtime status tab.
      appendRuntimeDiagnostics(panel)
      content.append(panel)
      return
    }

    if (activeFacet === 'extension-points') {
      const panel = createTabPanel(document, copy('plugin-tab.extension-points'))
      const points = (snapshot.extensionPoints?.points ?? []).filter(point => point.plugins.some(usage => (
        usage.identity.source === plugin.source && usage.identity.id === plugin.id
      )))
      const query = pluginExtensionPointQueries.get(plugin.id) ?? ''
      const items: HostCollectionItem[] = points.map(point => {
        const usage = point.plugins.find(item => item.identity.source === plugin.source && item.identity.id === plugin.id)
        const rowStatus = extensionPointRowStatus(snapshot, point, usage)
        const status: HostCollectionStatus | undefined = rowStatus === undefined
          ? undefined
          : { label: rowStatus.text, tone: rowStatus.state === 'pending' ? 'warning' : 'danger', detail: rowStatus.text }
        return {
          id: point.id,
          title: point.titleProjection.text,
          description: point.descriptionProjection.text,
          machineId: point.id,
          searchText: [
            ...(usage?.registrations.flatMap(item => [item.titleText, item.descriptionText ?? '', item.id, item.qualifiedId]) ?? []),
            ...(usage?.routes.flatMap(item => [item.qualifiedId, item.definition.path, item.definition.outlet]) ?? []),
          ],
          icon: () => createHostSurfaceIcon(document, point.icon),
          ...(status === undefined ? {} : { status }),
          onOpen: () => {
            operationError = undefined
            void navigateRoute({ kind: 'extension-point', pointId: point.id, facet: rowStatus === undefined ? 'usage' : 'diagnostics' })
          },
        }
      })
      mountHostCollection(panel, {
        id: `plugin-extension-points-${plugin.id}`,
        label: `${plugin.name}扩展点列表`,
        density: 'compact',
        items,
        search: {
          label: `搜索${plugin.name}的扩展点与贡献`,
          placeholder: '搜索扩展点、介绍、贡献名称或 id…',
          query,
          onQueryChange: value => { pluginExtensionPointQueries.set(plugin.id, value) },
        },
        emptyLabel: '当前插件没有使用任何扩展点',
        noMatchesLabel: '没有匹配的扩展点或贡献',
      })
      content.append(panel)
      return
    }

    const panel = createTabPanel(document, copy('plugin-tab.routes'))
    const query = pluginRouteQueries.get(plugin.id) ?? ''
    const routesForPage = (page: NavigationPageSnapshot): readonly RouteSnapshot[] => pluginRoutes.filter(route => (
      qualifiedNavigationId(route.owner, route.definition.page) === page.qualifiedId
    ))
    const items: HostCollectionItem[] = [
      ...pluginRoutes.map(route => routeCollectionItem(snapshot, route, () => {
        void navigateRoute({ kind: 'route', qualifiedId: route.qualifiedId })
      })),
      ...pluginPages.map(page => pageCollectionItem(snapshot, page, routesForPage(page), () => {
        void navigateRoute({ kind: 'page', qualifiedId: page.qualifiedId })
      })),
    ]
    mountHostCollection(panel, {
      id: `plugin-routes-${plugin.id}`,
      label: `${plugin.name}路由与页面列表`,
      items,
      search: {
        label: `搜索${plugin.name}的路由与页面`,
        placeholder: '搜索标题、说明、位置、页面或 id…',
        query,
        onQueryChange: value => { pluginRouteQueries.set(plugin.id, value) },
      },
      emptyLabel: '当前插件没有注册路由或页面',
      noMatchesLabel: '没有匹配的路由或页面',
    }, root => {
      for (const open of root.querySelectorAll<HTMLButtonElement>('[data-collection-open]')) {
        const id = open.dataset.collectionOpen
        if (id?.startsWith('route:')) open.dataset.routeProductRow = id.slice('route:'.length)
        if (id?.startsWith('page:')) open.dataset.pageProductRow = id.slice('page:'.length)
      }
    })
    content.append(panel)
  }

  const createMarketplaceTrustBadge = (
    dimension: 'official' | 'certified',
    label: string,
    tooltip: string,
  ): HTMLSpanElement => {
    const badge = create(document, 'span', 'cxm-marketplace-trust-badge')
    badge.dataset.trustDimension = dimension
    badge.setAttribute('role', 'img')
    badge.setAttribute('aria-label', tooltip)
    badge.append(
      createManagerIcon(document, dimension === 'official' ? 'marketplace-official' : 'marketplace-certified'),
      create(document, 'span', undefined, label),
    )
    tooltips.attach(badge, () => tooltip, 'top')
    return badge
  }

  type ManagerActionMenuItem = {
    readonly id: string
    readonly label: string
    readonly icon: ManagerIconToken
    readonly disabled?: boolean
    readonly invoke: () => void | Promise<void>
  }

  const openManagerActionMenu = (
    trigger: HTMLButtonElement,
    label: string,
    items: readonly ManagerActionMenuItem[],
  ): void => {
    closePluginActionMenu(false)
    tooltips.hide()
    const popup = create(document, 'div', 'cxm-plugin-menu-popup')
    popup.dataset.managerActionMenu = label
    popup.setAttribute('role', 'menu')
    popup.setAttribute('aria-label', label)
    for (const item of items) {
      const action = create(document, 'button', 'cxm-plugin-menu-item')
      action.type = 'button'
      action.dataset.managerMenuAction = item.id
      action.setAttribute('role', 'menuitem')
      action.disabled = item.disabled === true
      action.append(createManagerIcon(document, item.icon), create(document, 'span', undefined, item.label))
      action.addEventListener('click', () => {
        closePluginActionMenu(true)
        void item.invoke()
      })
      popup.append(action)
    }
    const unmount = mountPortal(popup)
    trigger.setAttribute('aria-expanded', 'true')
    const closeMenu = (restoreFocus = false): void => {
      pluginActionMenuOpen = false
      pluginActionMenuContainsEvent = () => false
      repositionPluginActionMenu = () => {}
      trigger.setAttribute('aria-expanded', 'false')
      unmount()
      if (closePluginActionMenu === closeMenu) closePluginActionMenu = () => {}
      if (restoreFocus && trigger.isConnected) trigger.focus()
    }
    const enabledItems = (): HTMLButtonElement[] => [...popup.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
    const positionMenu = (): void => {
      if (!popup.isConnected || !trigger.isConnected) return closeMenu(false)
      const triggerRect = trigger.getBoundingClientRect()
      const popupRect = popup.getBoundingClientRect()
      const view = document.defaultView
      const edge = 8
      const left = Math.min(
        Math.max(edge, triggerRect.right - popupRect.width),
        Math.max(edge, (view?.innerWidth ?? document.documentElement.clientWidth) - popupRect.width - edge),
      )
      const below = triggerRect.bottom + 6
      const top = below + popupRect.height <= (view?.innerHeight ?? document.documentElement.clientHeight) - edge
        ? below
        : Math.max(edge, triggerRect.top - popupRect.height - 6)
      popup.style.left = `${Math.round(left)}px`
      popup.style.top = `${Math.round(top)}px`
    }
    popup.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeMenu(true)
        return
      }
      const enabled = enabledItems()
      const current = enabled.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'ArrowDown'
        ? enabled[(current + 1 + enabled.length) % enabled.length]
        : event.key === 'ArrowUp'
          ? enabled[(current - 1 + enabled.length) % enabled.length]
          : event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1) : undefined
      if (next === undefined) return
      event.preventDefault()
      event.stopPropagation()
      next.focus()
    })
    closePluginActionMenu = closeMenu
    pluginActionMenuOpen = true
    pluginActionMenuContainsEvent = event => event.composedPath().some(item => item === popup || item === trigger)
    repositionPluginActionMenu = positionMenu
    positionMenu()
    enabledItems()[0]?.focus()
  }

  const sourceMenuItems = (): readonly ManagerActionMenuItem[] => [
    {
      id: 'create', label: copy('marketplace.source-menu.create'), icon: 'marketplace-source-add',
      invoke: () => navigateRoute({ kind: 'marketplace-source', page: 'create' }),
    },
    {
      id: 'clipboard', label: copy('marketplace.source-menu.clipboard'), icon: 'marketplace-source-copy',
      invoke: () => importMarketplaceSourceFromClipboard(),
    },
    {
      id: 'manage', label: copy('marketplace.source-menu.manage'), icon: 'marketplace-source-edit',
      invoke: () => navigateRoute({ kind: 'marketplace-source', page: 'index' }),
    },
  ]

  const refreshPublisherGrantStatus = async (plugin: MarketplaceCatalogPlugin): Promise<void> => {
    if (plugin.commerce === undefined || publisherGrantStatuses.get(plugin.identity) === 'loading') return
    publisherGrantStatuses.set(plugin.identity, 'loading')
    try {
      const value = await publisherGrantClient.request('status', { pluginId: plugin.id, version: plugin.version }) as { status?: unknown }
      const status = typeof value?.status === 'string' ? value.status : 'unavailable'
      if (publisherGrantStatuses.get(plugin.identity) !== status) { publisherGrantStatuses.set(plugin.identity, status); renderContent() }
    } catch {
      if (publisherGrantStatuses.get(plugin.identity) !== 'unavailable') { publisherGrantStatuses.set(plugin.identity, 'unavailable'); renderContent() }
    }
  }

  const renderMarketplaceList = (managerSnapshot: ManagerSnapshot): void => {
    const snapshot = marketplace.snapshot()
    setHeading(copy('marketplace.heading'), managerSnapshot, { icon: 'marketplace' })
    content.dataset.marketplaceDiscovery = 'true'
    const page = create(document, 'section', 'cxm-marketplace-discovery')
    page.dataset.marketplaceDiscoveryPage = 'true'
    const tools = create(document, 'div', 'cxm-marketplace-discovery-tools')
    const toolbar = create(document, 'div', 'cxm-toolbar')
    const sourceMenu = managerIconAction('marketplace-source-add', copy('marketplace.source-menu-label'), {
      className: 'cxm-toolbar-icon-action',
      description: copy('marketplace.source-menu-description'),
    })
    sourceMenu.dataset.marketplaceSourceMenu = 'true'
    sourceMenu.setAttribute('aria-haspopup', 'menu')
    sourceMenu.setAttribute('aria-expanded', 'false')
    sourceMenu.addEventListener('click', event => {
      event.stopPropagation()
      if (sourceMenu.getAttribute('aria-expanded') === 'true') closePluginActionMenu(true)
      else openManagerActionMenu(sourceMenu, copy('marketplace.source-menu-label'), sourceMenuItems())
    })
    const certifiedFilter = create(document, 'button', 'cxm-marketplace-filter')
    certifiedFilter.type = 'button'
    certifiedFilter.dataset.marketplaceCertifiedOnly = 'true'
    certifiedFilter.setAttribute('aria-pressed', String(marketplaceCertifiedOnly))
    certifiedFilter.setAttribute('aria-label', marketplaceCertifiedOnly ? copy('marketplace.filter-all') : copy('marketplace.filter-certified'))
    certifiedFilter.append(
      createManagerIcon(document, 'marketplace-certified', undefined, { state: marketplaceCertifiedOnly ? 'active' : 'default' }),
      create(document, 'span', undefined, copy('marketplace.filter-certified-only')),
    )
    certifiedFilter.addEventListener('click', () => {
      marketplaceCertifiedOnly = !marketplaceCertifiedOnly
      renderContent()
      content.querySelector<HTMLButtonElement>('[data-marketplace-certified-only]')?.focus()
    })
    const officialFilter = create(document, 'button', 'cxm-marketplace-filter')
    officialFilter.type = 'button'
    officialFilter.dataset.marketplaceOfficialOnly = 'true'
    officialFilter.setAttribute('aria-pressed', String(marketplaceOfficialOnly))
    officialFilter.setAttribute('aria-label', marketplaceOfficialOnly ? copy('marketplace.filter-all') : copy('marketplace.filter-official'))
    officialFilter.append(
      createManagerIcon(document, 'marketplace-official', undefined, { state: marketplaceOfficialOnly ? 'active' : 'default' }),
      create(document, 'span', undefined, copy('marketplace.filter-official-only')),
    )
    officialFilter.addEventListener('click', () => {
      marketplaceOfficialOnly = !marketplaceOfficialOnly
      renderContent()
      content.querySelector<HTMLButtonElement>('[data-marketplace-official-only]')?.focus()
    })
    const ranked = searchMarketplaceCatalog(snapshot.plugins, {
      query: marketplaceQuery,
      currentLocale: managerSnapshot.localization.locale,
      certifiedOnly: marketplaceCertifiedOnly,
      officialOnly: marketplaceOfficialOnly,
      ...(model.marketplaceEligibility === undefined ? {} : { eligibility: plugin => model.marketplaceEligibility!(plugin) }),
    })
    const results = create(document, 'div', 'cxm-marketplace-results')
    results.dataset.marketplaceResultsScroll = 'true'
    const items: HostCollectionItem[] = ranked.map(({ plugin, projection: metadata, ranking }) => {
      const trustLabels = [
        ...(plugin.official === undefined ? [] : [copy('marketplace.official')]),
        ...(plugin.certification === undefined ? [] : [copy('marketplace.certified')]),
      ]
      const status: HostCollectionStatus | undefined = trustLabels.length === 0
        ? undefined
        : {
            label: trustLabels.join('、'),
            tone: plugin.certification === undefined ? 'neutral' : 'success',
            detail: trustLabels.join('、'),
          }
      return {
        id: plugin.identity,
        title: metadata.name,
        description: metadata.description,
        machineId: plugin.id,
        searchText: [
          plugin.version,
          metadata.feedName,
          plugin.identity,
          plugin.license,
          ...metadata.keywords,
          ...metadata.authors.map(author => author.name),
        ],
        icon: () => createPluginIcon(document, metadata.name, plugin.icon),
        ...(plugin.icon === undefined ? {} : { iconKind: 'artwork' as const }),
        ...(status === undefined ? {} : { status }),
        openLabel: `${copy('marketplace.open')} · ${metadata.name}`,
        onOpen: () => {
          rememberListScroll()
          void navigateRoute({ kind: 'marketplace', identity: plugin.identity, facet: 'overview' })
        },
      }
    })
    const view = mountHostCollection(results, {
      id: 'marketplace',
      label: copy('marketplace.collection-label'),
      items,
      search: {
        label: copy('marketplace.search-label'),
        placeholder: copy('marketplace.search-placeholder'),
        clearLabel: copy('marketplace.search-clear'),
        query: marketplaceQuery,
        onQueryChange: value => {
          marketplaceQuery = value
          renderContent()
          const replacement = content.querySelector<HTMLInputElement>('[data-collection-search="marketplace"]')
          replacement?.focus()
          replacement?.setSelectionRange(value.length, value.length)
        },
      },
      emptyLabel: snapshot.sources.length === 0 ? copy('marketplace.empty-no-sources') : copy('marketplace.no-plugins'),
      noMatchesLabel: copy('marketplace.no-matches'),
    }, root => {
      for (const item of root.querySelectorAll<HTMLElement>('[data-collection-item]')) {
        const rankedItem = ranked.find(entry => entry.plugin.identity === item.dataset.collectionItem)
        if (rankedItem === undefined) continue
        const { plugin, ranking } = rankedItem
        item.dataset.marketplacePlugin = plugin.id
        item.dataset.marketplaceOfficial = String(plugin.official !== undefined)
        item.dataset.marketplaceCertified = String(plugin.certification !== undefined)
        item.dataset.marketplaceRankingTier = ranking.textTier
        item.dataset.marketplaceRankingOfficialPriority = String(ranking.officialPriority)
        item.dataset.marketplaceRankingExplanation = marketplaceRankingDescription(ranking)
        const title = item.querySelector<HTMLElement>('.cxc-title')
        if (title !== null && (plugin.official !== undefined || plugin.certification !== undefined)) {
          const titleRow = create(document, 'span', 'cxm-marketplace-title-row')
          const badges = create(document, 'span', 'cxm-marketplace-trust-badges')
          if (plugin.official !== undefined) badges.append(createMarketplaceTrustBadge(
            'official',
            copy('marketplace.official'),
            productLocale(managerSnapshot.localization.locale) === 'zh-CN'
              ? 'CordisX 官方发布者身份；只影响 Marketplace 身份、筛选与排序，不改变权限。'
              : 'CordisX Official publisher identity. It affects Marketplace identity, filtering, and ordering only, never permissions.',
          ))
          if (plugin.certification !== undefined) badges.append(createMarketplaceTrustBadge(
            'certified',
            copy('marketplace.certified'),
            productLocale(managerSnapshot.localization.locale) === 'zh-CN'
              ? 'CordisX 已审核当前版本的明确制品；不参与排序，也不代表绝对安全。'
              : 'CordisX reviewed this exact versioned artifact. It does not affect ordering or guarantee absolute safety.',
          ))
          title.replaceWith(titleRow)
          titleRow.append(title, badges)
        }
      }
    })
    const search = view.element.querySelector<HTMLElement>('.cxc-search')
    if (search !== null) toolbar.append(search)
    toolbar.append(sourceMenu)
    const filters = create(document, 'div', 'cxm-marketplace-filter-row')
    filters.setAttribute('aria-label', '插件商店筛选')
    filters.append(officialFilter, certifiedFilter)
    tools.append(toolbar, filters)
    page.append(tools, results)
    content.append(page)
  }

  const renderMarketplaceDetail = (managerSnapshot: ManagerSnapshot, identityValue: string): void => {
    const plugin = marketplace.snapshot().plugins.find(item => item.identity === identityValue)
    setHeading(copy('plugins.heading'), managerSnapshot)
    if (plugin === undefined) {
      content.append(create(document, 'div', 'cxm-empty', '该插件已不在当前聚合结果中'))
      return
    }
    const metadata = projectMarketplacePlugin(plugin, managerSnapshot.localization.locale)
    const chinese = productLocale(managerSnapshot.localization.locale) === 'zh-CN'
    const activeFacet = routeState.kind === 'marketplace' ? routeState.facet : 'overview'
    content.append(createLocalTabs(document, localizeTabs(MARKETPLACE_DETAIL_TABS), activeFacet, 'data-marketplace-detail-tab', (tab) => {
      void navigateRoute({ kind: 'marketplace', identity: identityValue, facet: tab as MarketplaceDetailTab })
    }))

    if (activeFacet === 'overview') {
      const panel = createTabPanel(document, copy('marketplace-tab.overview'))
      panel.append(create(document, 'p', 'cxm-detail-description', metadata.description))
      const fields = create(document, 'div', 'cxm-detail-grid')
      for (const [label, value] of [
        ['版本', `v${plugin.version}`],
        ['CordisX 兼容范围', plugin.compatibility.cordisx],
        ['许可证', plugin.license],
        ['插件标识', plugin.id],
      ]) {
        const field = create(document, 'div', 'cxm-field')
        field.append(create(document, 'div', 'cxm-field-label', label), create(document, 'div', 'cxm-field-value', value))
        fields.append(field)
      }
      panel.append(fields)
      if (plugin.official !== undefined || plugin.certification !== undefined) {
        panel.append(createSectionTitle(document, chinese ? 'Marketplace 身份与审核信息' : 'Marketplace identity and review information'))
        const trustList = create(document, 'div', 'cxm-marketplace-trust-list')
        const appendEvidence = (target: HTMLElement, href: string): void => {
          const evidence = configureExternalLink(create(document, 'a', 'cxm-action cxm-marketplace-trust-evidence'), href)
          evidence.append(create(document, 'span', undefined, chinese ? '查看受保护审核证据' : 'View protected review evidence'), createManagerIcon(document, 'external-link', 'cxm-action-icon'))
          target.append(evidence)
        }
        if (plugin.official !== undefined) {
          const official = plugin.official
          const item = create(document, 'section', 'cxm-marketplace-trust-item')
          item.dataset.marketplaceTrustDimension = 'official'
          const title = create(document, 'div', 'cxm-marketplace-trust-title')
          title.append(createManagerIcon(document, 'marketplace-official'), create(document, 'span', undefined, chinese ? '官方' : 'Official'))
          item.append(
            title,
            create(document, 'p', 'cxm-marketplace-trust-copy', `${official.label.fallback}。${official.description.fallback}`),
            create(document, 'p', 'cxm-marketplace-trust-copy', chinese
              ? '“官方”表示该插件由 CordisX 团队通过受信任发布者、源码仓库与包命名空间创建并持续维护。它只影响 Marketplace 身份、筛选和同等相关性内的产品排序；不会改变 PermissionBroker 决策，也不自动等于“已认证”。'
              : 'Official means CordisX creates and maintains this plugin through a trusted publisher, source repository, and package namespace. It affects Marketplace identity, filters, and ordering among equally relevant results only. It never changes PermissionBroker decisions or automatically means Certified.'),
          )
          appendEvidence(item, official.reviewer.evidenceRef)
          trustList.append(item)
        }
        if (plugin.certification !== undefined) {
          const certification = plugin.certification
          const [reviewSummary, permissionBoundary, trustRootBoundary] = marketplaceCertifiedDetailCopy(certification, plugin.version, chinese)
          const item = create(document, 'section', 'cxm-marketplace-trust-item')
          item.dataset.marketplaceTrustDimension = 'certified'
          const title = create(document, 'div', 'cxm-marketplace-trust-title')
          title.append(createManagerIcon(document, 'marketplace-certified'), create(document, 'span', undefined, chinese ? '已认证' : 'Certified'))
          item.append(
            title,
            create(document, 'p', 'cxm-marketplace-trust-copy', `${certification.label.fallback}。${certification.description.fallback}`),
            create(document, 'p', 'cxm-marketplace-trust-copy', reviewSummary),
            create(document, 'p', 'cxm-marketplace-trust-copy', permissionBoundary),
            create(document, 'p', 'cxm-marketplace-trust-copy', trustRootBoundary),
          )
          appendEvidence(item, certification.reviewer.evidenceRef)
          trustList.append(item)
        }
        panel.append(trustList)
        const boundary = create(document, 'div', 'cxm-notice', chinese ? '认证不是绝对安全保证。' : 'Certification is not an absolute safety guarantee.')
        boundary.dataset.marketplaceTrustBoundary = 'true'
        panel.append(boundary)
      }
      if (metadata.keywords.length > 0) {
        panel.append(createSectionTitle(document, '关键词'))
        panel.append(create(document, 'p', 'cxm-copy', metadata.keywords.join(' · ')))
      }
      if (plugin.commerce !== undefined) {
        void refreshPublisherGrantStatus(plugin)
        panel.append(createSectionTitle(document, '开发者授权'))
        const commerce = create(document, 'section', 'cxm-marketplace-trust-item')
        commerce.dataset.publisherGrant = plugin.id
        const current = publisherGrantStatuses.get(plugin.identity)
        const label = current === 'authorized' ? '已授权' : current === 'refresh-due' ? '即将到期' : current === 'grace' ? '离线宽限期' : current === 'expired' ? '已过期' : current === 'device-mismatch' ? '设备不匹配' : current === 'revoked' ? '已撤销' : current === 'invalid-signature' ? '签名无效' : current === 'loading' ? '正在检查授权…' : '未授权'
        commerce.append(create(document, 'p', 'cxm-marketplace-trust-copy', `授权状态：${label}`))
        commerce.append(create(document, 'p', 'cxm-marketplace-trust-copy', 'CordisX 只验证开发者签名的授权声明。付款、退款和售后由开发者负责。'))
        const actions = create(document, 'div', 'cxm-manager-inline-actions')
        const purchase = create(document, 'button', 'cxm-action')
        purchase.type = 'button'; purchase.dataset.publisherGrantPurchase = plugin.id
        purchase.append(create(document, 'span', undefined, '前往开发者购买'), createManagerIcon(document, 'external-link', 'cxm-action-icon'))
        purchase.addEventListener('click', () => { void (async () => {
          try {
            const challenge = await publisherGrantClient.request('challenge')
            const href = new URL(plugin.commerce!.purchaseUrl)
            href.searchParams.set('cordisxDeviceChallenge', btoa(unescape(encodeURIComponent(JSON.stringify(challenge))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')))
            document.defaultView?.open(href.href, '_blank', 'noopener,noreferrer')
          } catch { publisherGrantStatuses.set(plugin.identity, 'unavailable'); renderContent() }
        })() })
        const copyChallenge = create(document, 'button', 'cxm-action')
        copyChallenge.type = 'button'; copyChallenge.dataset.publisherGrantChallenge = plugin.id
        copyChallenge.append(create(document, 'span', undefined, '复制设备挑战'))
        copyChallenge.addEventListener('click', () => { void (async () => {
          try { const challenge = await publisherGrantClient.request('challenge'); await document.defaultView?.navigator.clipboard?.writeText(JSON.stringify(challenge)); copyChallenge.replaceChildren('已复制') } catch { copyChallenge.replaceChildren('设备密钥不可用') }
        })() })
        const importGrant = create(document, 'button', 'cxm-action')
        importGrant.type = 'button'; importGrant.dataset.publisherGrantImport = plugin.id; importGrant.append(create(document, 'span', undefined, '导入授权声明'))
        importGrant.addEventListener('click', () => {
          const input = create(document, 'input') as HTMLInputElement; input.type = 'file'; input.accept = 'application/json,.json'; input.hidden = true
          input.addEventListener('change', () => { void (async () => {
            const file = input.files?.[0]; if (file === undefined) return
            try { const result = await publisherGrantClient.request('import', JSON.parse(await file.text())) as { status?: unknown }; publisherGrantStatuses.set(plugin.identity, typeof result?.status === 'string' ? result.status : 'unavailable') } catch { publisherGrantStatuses.set(plugin.identity, 'invalid-signature') }
            input.remove(); renderContent()
          })() }, { once: true })
          document.body?.append(input); input.click()
        })
        const importClipboard = create(document, 'button', 'cxm-action')
        importClipboard.type = 'button'; importClipboard.dataset.publisherGrantClipboard = plugin.id; importClipboard.append(create(document, 'span', undefined, '从剪贴板导入'))
        importClipboard.addEventListener('click', () => { void (async () => {
          try { const text = await document.defaultView?.navigator.clipboard?.readText(); const result = await publisherGrantClient.request('import', JSON.parse(text ?? '')) as { status?: unknown }; publisherGrantStatuses.set(plugin.identity, typeof result?.status === 'string' ? result.status : 'unavailable') } catch { publisherGrantStatuses.set(plugin.identity, 'invalid-signature') }
          renderContent()
        })() })
        actions.append(purchase, copyChallenge, importGrant, importClipboard)
        if (plugin.commerce.manageUrl !== undefined) { const manage = configureExternalLink(create(document, 'a', 'cxm-action'), plugin.commerce.manageUrl); manage.append('管理授权'); actions.append(manage) }
        if (plugin.commerce.recoveryUrl !== undefined) { const recover = configureExternalLink(create(document, 'a', 'cxm-action'), plugin.commerce.recoveryUrl); recover.append('恢复授权'); actions.append(recover) }
        commerce.append(actions); panel.append(commerce)
      }
      content.append(panel)
      return
    }

    const panel = createTabPanel(document, copy('marketplace-tab.authors-source'))
    const links = create(document, 'div', 'cxm-link-list')
    links.setAttribute('role', 'list')
    const appendLink = (label: string, value: string, href: string): void => {
      const row = create(document, 'div', 'cxm-link-row')
      row.setAttribute('role', 'listitem')
      const copy = create(document, 'div', 'cxm-link-row-copy')
      copy.append(create(document, 'div', 'cxm-link-row-title', label), create(document, 'code', 'cxm-link-row-value', value))
      const link = configureExternalLink(create(document, 'a', 'cxm-action'), href)
      link.append(create(document, 'span', undefined, '打开'), createManagerIcon(document, 'external-link', 'cxm-action-icon'))
      row.append(copy, link)
      links.append(row)
    }
    for (const author of metadata.authors) {
      if (author.url === undefined) {
        const row = create(document, 'div', 'cxm-link-row')
        row.setAttribute('role', 'listitem')
        row.append(create(document, 'div', 'cxm-link-row-title', `作者 · ${author.name}`))
        links.append(row)
      } else appendLink(`作者 · ${author.name}`, author.url, author.url)
    }
    appendLink('插件源码', plugin.source, plugin.source)
    if (plugin.homepage !== undefined) appendLink('插件主页', plugin.homepage, plugin.homepage)
    if (plugin.manifest !== undefined) appendLink('插件 Manifest', plugin.manifest, plugin.manifest)
    if (plugin.icon !== undefined) appendLink('插件图标', plugin.icon, plugin.icon)
    appendLink(`商店来源 · ${metadata.feedName}`, plugin.feedUrl, plugin.feedUrl)
    appendLink('商店主页', plugin.feedHomepage, plugin.feedHomepage)
    panel.append(links)
    content.append(panel)
  }

  const marketplaceSourceState = (
    record: MarketplaceSourceRecord,
    snapshot = marketplace.snapshot(),
  ): MarketplaceSourceSnapshot => snapshot.sourceStates.find(item => item.url === record.url) ?? {
    url: record.url,
    enabled: record.enabled,
    official: record.url === OFFICIAL_MARKETPLACE_SOURCE,
    ...(record.local === undefined ? {} : { local: record.local }),
    status: 'loading',
    phase: record.enabled ? 'idle' : 'disabled',
    stale: false,
    revalidating: false,
    attempts: 0,
  }

  const runMarketplaceSourceOperation = async (
    operation: () => Promise<void>,
    success: string,
  ): Promise<boolean> => {
    sourcesBusy = true
    sourceOperationError = undefined
    sourceOperationDiagnostic = undefined
    sourceOperationNotice = undefined
    renderContent()
    try {
      await operation()
      sourceOperationNotice = success
      return true
    } catch (error) {
      sourceOperationError = copy('marketplace.source.operation-failed')
      sourceOperationDiagnostic = error instanceof Error ? error.message : String(error)
      return false
    } finally {
      sourcesBusy = false
      renderContent()
    }
  }

  const sourceErrorAlert = (): HTMLElement | undefined => {
    if (sourceOperationError === undefined) return undefined
    const alert = forms.alert(sourceOperationError, 'error')
    if (sourceOperationDiagnostic !== undefined && sourceOperationDiagnostic !== '') alert.title = sourceOperationDiagnostic
    return alert
  }

  const importMarketplaceSourceFromClipboard = async (): Promise<void> => {
    let value: string | null | undefined
    const navigator = document.defaultView?.navigator as Navigator & { clipboard?: { readText(): Promise<string> } }
    try {
      value = typeof navigator?.clipboard?.readText === 'function'
        ? await navigator.clipboard.readText()
        : document.defaultView?.prompt(copy('marketplace.source.clipboard-prompt'))
    } catch (error) {
      sourceOperationError = copy('marketplace.source.clipboard-unavailable')
      sourceOperationDiagnostic = error instanceof Error ? error.message : String(error)
      sourceOperationNotice = undefined
      renderContent()
      return
    }
    if (value === undefined || value === null) return
    const imported = await runMarketplaceSourceOperation(
      async () => { await marketplace.importSource(value!) },
      copy('marketplace.source.imported'),
    )
    if (imported) await navigateRoute({ kind: 'marketplace-source', page: 'index' })
  }

  const renderMarketplaceSourceIndex = (managerSnapshot: ManagerSnapshot): void => {
    const snapshot = marketplace.snapshot()
    setHeading(copy('marketplace.source.index-heading'), managerSnapshot)
    const page = create(document, 'section', 'cxm-marketplace-source-page')
    page.dataset.marketplaceSourcePage = 'index'
    const toolbar = create(document, 'div', 'cxm-marketplace-source-toolbar')
    const add = managerIconAction('marketplace-source-add', copy('marketplace.source.add'), { disabled: sourcesBusy })
    add.dataset.marketplaceSourceCreate = 'true'
    add.addEventListener('click', () => { void navigateRoute({ kind: 'marketplace-source', page: 'create' }) })
    const clipboard = managerIconAction('marketplace-source-copy', copy('marketplace.source-menu.clipboard'), { disabled: sourcesBusy })
    clipboard.dataset.marketplaceSourceClipboard = 'true'
    clipboard.addEventListener('click', () => { void importMarketplaceSourceFromClipboard() })
    toolbar.append(add, clipboard)
    page.append(toolbar)
    if (sourceOperationNotice !== undefined) page.append(forms.alert(sourceOperationNotice, 'info'))
    const errorAlert = sourceErrorAlert()
    if (errorAlert !== undefined) page.append(errorAlert)

    const items: HostCollectionItem[] = snapshot.sourceRecords.map((record, index) => {
      const state = marketplaceSourceState(record, snapshot)
      const projection = projectMarketplaceSource(state, managerSnapshot.localization.locale)
      const status = !record.enabled
        ? { label: copy('marketplace.source.disabled'), tone: 'neutral' as const }
        : state.status === 'failed'
          ? { label: copy('marketplace.source.failed'), tone: 'danger' as const }
          : state.revalidating
            ? { label: copy('marketplace.source.updating'), tone: 'progress' as const }
            : state.stale
              ? { label: copy('marketplace.source.cached'), tone: 'warning' as const }
              : undefined
      return {
        id: record.url,
        title: projection.name,
        description: projection.description ?? copy('marketplace.source.no-description'),
        machineId: record.url,
        searchText: projection.searchValues,
        icon: () => createManagerIcon(document, record.url === OFFICIAL_MARKETPLACE_SOURCE ? 'marketplace-official' : 'marketplace'),
        ...(status === undefined ? {} : { status }),
        openLabel: `${copy('marketplace.source.open')} · ${projection.name}`,
        onOpen: () => { void navigateRoute({ kind: 'marketplace-source', page: 'edit', url: record.url }) },
        actions: [
          {
            id: record.enabled ? 'disable' : 'enable',
            label: record.enabled ? copy('marketplace.source.disable') : copy('marketplace.source.enable'),
            icon: () => createManagerIcon(document, record.enabled ? 'disable-plugin' : 'enable-plugin'),
            placement: 'direct',
            disabled: sourcesBusy,
            onInvoke: async () => {
              await runMarketplaceSourceOperation(
                async () => { await marketplace.setSourceEnabled(record.url, !record.enabled) },
                record.enabled ? copy('marketplace.source.disabled-notice') : copy('marketplace.source.enabled-notice'),
              )
            },
          },
          {
            id: 'edit', label: copy('marketplace.source.edit'), icon: () => createManagerIcon(document, 'marketplace-source-edit'), placement: 'overflow',
            disabled: sourcesBusy,
            onInvoke: () => { void navigateRoute({ kind: 'marketplace-source', page: 'edit', url: record.url }) },
          },
          {
            id: 'move-up', label: copy('marketplace.source.move-up'), icon: () => createManagerIcon(document, 'marketplace-source-move-up'), placement: 'overflow',
            disabled: sourcesBusy || index === 0,
            onInvoke: async () => { await runMarketplaceSourceOperation(async () => { await marketplace.moveSource(record.url, index - 1) }, copy('marketplace.source.moved-notice')) },
          },
          {
            id: 'move-down', label: copy('marketplace.source.move-down'), icon: () => createManagerIcon(document, 'marketplace-source-move-down'), placement: 'overflow',
            disabled: sourcesBusy || index === snapshot.sourceRecords.length - 1,
            onInvoke: async () => { await runMarketplaceSourceOperation(async () => { await marketplace.moveSource(record.url, index + 1) }, copy('marketplace.source.moved-notice')) },
          },
          {
            id: 'remove', label: copy('marketplace.source.remove'), icon: () => createManagerIcon(document, 'uninstall-plugin'), placement: 'overflow', tone: 'danger',
            disabled: sourcesBusy || record.url === OFFICIAL_MARKETPLACE_SOURCE,
            ...(record.url === OFFICIAL_MARKETPLACE_SOURCE ? { unavailableReason: copy('marketplace.source.official-remove-unavailable') } : {}),
            onInvoke: async () => { await runMarketplaceSourceOperation(async () => { await marketplace.removeSource(record.url) }, copy('marketplace.source.removed-notice')) },
          },
        ],
      }
    })
    marketplaceCollectionView?.dispose()
    marketplaceCollectionView = createHostCollection(document, {
      id: 'marketplace-sources',
      label: copy('marketplace.source.collection-label'),
      layout: 'rows',
      items,
      search: {
        label: copy('marketplace.source.search-label'),
        placeholder: copy('marketplace.source.search-placeholder'),
        clearLabel: copy('marketplace.source.search-clear'),
        query: sourceQuery,
        onQueryChange: query => { sourceQuery = query },
        icon: () => createManagerIcon(document, 'search'),
        clearIcon: () => createManagerIcon(document, 'close'),
      },
      emptyLabel: copy('marketplace.source.empty'),
      noMatchesLabel: copy('marketplace.source.no-matches'),
      moreLabel: copy('marketplace.source.more-actions'),
      moreIcon: () => createManagerIcon(document, 'more'),
      tooltips,
      attachPortalTheme: portal => theme.attach(portal),
    })
    page.append(marketplaceCollectionView.element)
    content.append(page)
  }

  const renderMarketplaceSourceForm = (
    managerSnapshot: ManagerSnapshot,
    mode: 'create' | 'edit',
    existing?: MarketplaceSourceRecord,
  ): void => {
    const isCreate = mode === 'create'
    const state = existing === undefined ? undefined : marketplaceSourceState(existing)
    const projection = state === undefined ? undefined : projectMarketplaceSource(state, managerSnapshot.localization.locale)
    setHeading(isCreate ? copy('marketplace.source.create-heading') : copy('marketplace.source.edit-heading'), managerSnapshot)
    const page = create(document, 'section', 'cxm-marketplace-source-page cxf-scope')
    page.dataset.marketplaceSourcePage = mode
    const form = forms.form(`marketplace-source-${mode}`)
    let urlValue = existing?.url ?? ''
    let nameValue = existing?.local?.name ?? ''
    let descriptionValue = existing?.local?.description ?? ''
    let noteValue = existing?.local?.note ?? ''
    let sourceUrlItem: ReturnType<HostFormAdapter['item']> | undefined
    const identitySection = forms.section(
      isCreate ? copy('marketplace.source.url-section') : projection?.name ?? copy('marketplace.source.edit-heading'),
      isCreate ? copy('marketplace.source.url-help') : copy('marketplace.source.readonly-url-help'),
    )
    if (isCreate) {
      const urlItem = forms.item({ id: 'cxm-marketplace-source-url', label: copy('marketplace.source.url-label'), required: true, fullWidth: true })
      sourceUrlItem = urlItem
      const field: CordisXConfigFieldSnapshot = {
        namespace: 'cordisx.host', path: ['marketplaceSource', 'url'], type: 'string', role: 'url', value: urlValue, disabled: sourcesBusy, required: true,
      }
      const control = forms.control(field, 'cxm-marketplace-source-url', value => {
        urlValue = typeof value === 'string' ? value.trim() : ''
        urlItem.setError(urlValue === '' || /^https:\/\//iu.test(urlValue) ? undefined : copy('marketplace.source.url-invalid'))
      })
      setTDesignProps(control.focusTarget as TDesignElement, { placeholder: 'https://example.com/cordisx-marketplace.json' })
      forms.connect(urlItem, control)
      urlItem.control.append(control.root)
      identitySection.content.append(urlItem.root)
    } else {
      const urlItem = forms.item({ id: 'cxm-marketplace-source-url-readonly', label: copy('marketplace.source.url-label'), fullWidth: true })
      const value = create(document, 'div', 'cxm-marketplace-source-readonly', existing!.url)
      value.dataset.marketplaceSourceCanonicalUrl = existing!.url
      urlItem.control.append(value)
      identitySection.content.append(urlItem.root)
    }
    form.append(identitySection.root)

    const localSection = forms.section(copy('marketplace.source.local-section'), copy('marketplace.source.local-help'))
    const appendTextField = (
      id: string,
      label: string,
      role: 'url' | 'textarea' | undefined,
      value: string,
      onChange: (value: string) => void,
      help: string,
    ): void => {
      const item = forms.item({ id, label, help, fullWidth: role === 'textarea' })
      const field: CordisXConfigFieldSnapshot = {
        namespace: 'cordisx.host', path: ['marketplaceSource', 'local', id], type: 'string', value, disabled: sourcesBusy, required: false,
        ...(role === undefined ? {} : { role }),
      }
      const control = forms.control(field, id, next => onChange(typeof next === 'string' ? next : ''))
      forms.connect(item, control)
      item.control.append(control.root)
      localSection.content.append(item.root)
    }
    appendTextField('cxm-marketplace-source-name', copy('marketplace.source.name-label'), undefined, nameValue, value => { nameValue = value }, copy('marketplace.source.name-help'))
    appendTextField('cxm-marketplace-source-description', copy('marketplace.source.description-label'), 'textarea', descriptionValue, value => { descriptionValue = value }, copy('marketplace.source.description-help'))
    appendTextField('cxm-marketplace-source-note', copy('marketplace.source.note-label'), 'textarea', noteValue, value => { noteValue = value }, copy('marketplace.source.note-help'))
    form.append(localSection.root)

    const submit = forms.button(isCreate ? copy('marketplace.source.create') : copy('marketplace.source.save'), { type: 'submit', variant: 'primary' })
    setTDesignDisabled(submit, sourcesBusy)
    const actions = create(document, 'div', 'cxf-actions')
    actions.append(submit)
    form.append(actions)
    form.addEventListener('submit', event => {
      event.preventDefault()
      let normalized = existing?.url
      if (isCreate) {
        if (urlValue === '') {
          sourceUrlItem?.setError(copy('marketplace.source.url-required'))
          return
        }
        try {
          normalized = normalizeMarketplaceSource(urlValue)
        } catch {
          sourceUrlItem?.setError(copy('marketplace.source.url-invalid'))
          return
        }
        if (marketplace.snapshot().sourceRecords.some(item => item.url === normalized)) {
          sourceUrlItem?.setError(copy('marketplace.source.duplicate'))
          return
        }
      }
      if (normalized === undefined) return
      const name = nameValue.trim()
      const description = descriptionValue.trim()
      const note = noteValue.trim()
      const local = {
        ...(name === '' ? {} : { name }),
        ...(description === '' ? {} : { description }),
        ...(note === '' ? {} : { note }),
      }
      const source: MarketplaceSourceRecord = {
        url: normalized,
        enabled: existing?.enabled ?? true,
        ...(Object.keys(local).length === 0 ? {} : { local }),
      }
      void runMarketplaceSourceOperation(
        async () => { await marketplace.upsertSource(source) },
        isCreate ? copy('marketplace.source.added') : copy('marketplace.source.saved'),
      ).then(saved => {
        if (saved) void navigateRoute({ kind: 'marketplace-source', page: 'index' })
      })
    })
    page.append(form)
    const errorAlert = sourceErrorAlert()
    if (errorAlert !== undefined) page.append(errorAlert)
    content.append(page)
  }

  const renderMarketplaceSourcePage = (managerSnapshot: ManagerSnapshot, route: Extract<ManagerRouteState, { kind: 'marketplace-source' }>): void => {
    if (route.page === 'index') return renderMarketplaceSourceIndex(managerSnapshot)
    if (route.page === 'create') return renderMarketplaceSourceForm(managerSnapshot, 'create')
    const source = marketplace.snapshot().sourceRecords.find(item => item.url === route.url)
    if (source === undefined) return renderMarketplaceSourceIndex(managerSnapshot)
    renderMarketplaceSourceForm(managerSnapshot, 'edit', source)
  }

  const settingsTabs = (snapshot: ManagerSnapshot): readonly ManagerSettingsTabSnapshot[] => (
    snapshot.settingsTabs ?? CORDISX_BUILTIN_MANAGER_SETTINGS_TABS
  )

  const stopSettingsContent = async (): Promise<void> => {
    const mount = settingsMount
    const mountId = settingsMountId
    settingsMount = undefined
    settingsMountId = undefined
    if (mount === undefined && mountId === undefined) return
    mount?.abort()
    if (model.closeSettingsTabContent !== undefined) await model.closeSettingsTabContent()
    else await mount?.dispose()
  }

  const resetSettings = async (): Promise<void> => {
    settingsTransition += 1
    if (settingsMount === undefined && settingsMountId === undefined) {
      if (activePrimary() === 'settings') routeState = { kind: 'primary', primary: 'settings' }
      settingsError = undefined
      settingsTransitioning = false
      settingsRoot = undefined
      settingsPanel = undefined
      settingsPanelBody = undefined
      return
    }
    settingsTransitioning = true
    try {
      await stopSettingsContent()
    } finally {
      if (activePrimary() === 'settings') routeState = { kind: 'primary', primary: 'settings' }
      settingsError = undefined
      settingsTransitioning = false
      settingsRoot = undefined
      settingsPanel = undefined
      settingsPanelBody = undefined
    }
  }

  const focusSettingsTab = (id: string): void => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('[data-settings-tab]')]
      .find(candidate => candidate.dataset.settingsTab === id)
    button?.focus()
  }

  const activateSettingsTab = async (id: string, restoreFocus: boolean, recordHistory = true): Promise<void> => {
    const tab = settingsTabs(model.snapshot()).find(candidate => candidate.id === id)
    if (tab === undefined || tab.disabled || settingsTransitioning) return
    const previousRoute = routeState
    const nextRoute: ManagerRouteState = { kind: 'settings', tabId: id }
    if (routeKey(previousRoute) === routeKey(nextRoute) && (tab.builtin || settingsMountId === id)) {
      if (restoreFocus) focusSettingsTab(id)
      return
    }
    if (recordHistory && routeKey(previousRoute) !== routeKey(nextRoute)) navigationHistory.push(previousRoute)
    const token = ++settingsTransition
    settingsTransitioning = true
    settingsMount?.abort()
    try {
      await stopSettingsContent()
      if (token !== settingsTransition) return
      routeState = nextRoute
      settingsError = undefined
      settingsTransitioning = false
      renderContent()
      if (!tab.builtin) {
        if (model.mountSettingsTab === undefined || settingsPanelBody === undefined) throw new Error('manager settings page mount is unavailable')
        settingsPanel?.setAttribute('aria-busy', 'true')
        settingsPanelBody.replaceChildren()
        settingsMountId = id
        const mount = await model.mountSettingsTab(id, settingsPanelBody)
        if (token !== settingsTransition || currentSettingsTab() !== id) {
          mount.abort()
          await mount.dispose()
          return
        }
        settingsMount = mount
        settingsMountId = id
        settingsPanel?.removeAttribute('aria-busy')
      }
      if (restoreFocus) focusSettingsTab(id)
    } catch (error) {
      if (token !== settingsTransition) return
      settingsMount?.abort()
      await stopSettingsContent().catch(() => {})
      settingsError = error instanceof Error ? error.message : String(error)
      routeState = { kind: 'settings', tabId: MANAGER_SETTINGS_FALLBACK }
      settingsTransitioning = false
      renderContent()
      if (restoreFocus) focusSettingsTab(MANAGER_SETTINGS_FALLBACK)
    }
  }

  const renderSettings = (snapshot: ManagerSnapshot): void => {
    setHeading('配置', snapshot, { icon: 'settings' })
    const items = settingsTabs(snapshot)
    const settingsTab = currentSettingsTab()
    const active = items.find(item => item.id === settingsTab)
    if ((active === undefined || active.disabled) && !settingsTransitioning) {
      settingsTransition += 1
      settingsTransitioning = true
      settingsMount?.abort()
      void stopSettingsContent().catch(error => {
        settingsError = error instanceof Error ? error.message : String(error)
      }).finally(() => {
        routeState = { kind: 'settings', tabId: MANAGER_SETTINGS_FALLBACK }
        settingsTransitioning = false
        renderContent()
      })
      return
    }

    if (settingsRoot === undefined || !settingsRoot.isConnected) {
      settingsRoot = create(document, 'div', 'cxm-settings-root')
      settingsRoot.dataset.settingsRoot = 'true'
      const tabs = create(document, 'div', 'cxm-tabs')
      tabs.dataset.settingsTablist = 'true'
      const panel = create(document, 'div', 'cxm-settings-panel')
      panel.id = 'cordisx-manager-settings-panel'
      panel.setAttribute('role', 'tabpanel')
      panel.tabIndex = 0
      const body = create(document, 'div', 'cxm-settings-panel-body')
      body.dataset.settingsPanelBody = 'true'
      panel.append(body)
      settingsRoot.append(tabs, panel)
      content.append(settingsRoot)
      settingsPanel = panel
      settingsPanelBody = body
    }

    const tablist = settingsRoot.querySelector<HTMLElement>('[data-settings-tablist]')!
    const focusedTabId = document.activeElement instanceof document.defaultView!.HTMLElement
      ? document.activeElement.dataset.settingsTab
      : undefined
    tablist.setAttribute('role', 'tablist')
    tablist.setAttribute('aria-label', 'CordisX 配置标签页')
    tablist.setAttribute('aria-orientation', 'horizontal')
    tablist.replaceChildren()
    const enabled = items.filter(item => !item.disabled)
    for (const item of items) {
      const button = create(document, 'button', 'cxm-tab')
      button.type = 'button'
      button.id = `cordisx-manager-settings-tab-${item.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`
      button.dataset.settingsTab = item.id
      button.dataset.settingsOwner = item.owner
      button.setAttribute('role', 'tab')
      button.setAttribute('aria-controls', 'cordisx-manager-settings-panel')
      button.setAttribute('aria-selected', String(item.id === settingsTab))
      button.tabIndex = item.id === settingsTab ? 0 : -1
      button.disabled = item.disabled
      if (item.disabled) button.setAttribute('aria-disabled', 'true')
      if (item.disabledReason !== undefined) button.title = item.disabledReason
      const visibleContent = create(document, 'span', 'cxm-tab-content')
      const icon = createHostSurfaceIcon(document, item.icon)
      icon.classList.add('cxm-tab-icon', 'cxm-settings-tab-icon')
      visibleContent.append(icon, create(document, 'span', undefined, item.title))
      button.append(visibleContent)
      button.addEventListener('click', () => { void activateSettingsTab(item.id, true) })
      button.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          void activateSettingsTab(item.id, true)
          return
        }
        const current = enabled.findIndex(candidate => candidate.id === item.id)
        let next: ManagerSettingsTabSnapshot | undefined
        if (event.key === 'ArrowRight') next = enabled[(current + 1) % enabled.length]
        if (event.key === 'ArrowLeft') next = enabled[(current - 1 + enabled.length) % enabled.length]
        if (event.key === 'Home') next = enabled[0]
        if (event.key === 'End') next = enabled.at(-1)
        if (next === undefined) return
        event.preventDefault()
        void activateSettingsTab(next.id, true)
      })
      tablist.append(button)
    }
    const activeButton = tablist.querySelector<HTMLButtonElement>(`[data-settings-tab="${settingsTab}"]`)
    if (activeButton !== null) settingsPanel?.setAttribute('aria-labelledby', activeButton.id)
    if (focusedTabId !== undefined) {
      tablist.querySelector<HTMLButtonElement>(`[data-settings-tab="${focusedTabId}"]`)?.focus()
    }

    if (settingsPanelBody === undefined || settingsMountId === settingsTab) return
    settingsPanelBody.replaceChildren()
    settingsPanel?.removeAttribute('aria-busy')
    if (!settingsTab.startsWith('host:')) {
      settingsPanel?.setAttribute('aria-busy', 'true')
      settingsPanelBody.append(create(document, 'div', 'cxm-notice', settingsTransitioning ? '正在切换配置页面…' : '正在加载插件配置页面…'))
    }
    if (settingsError !== undefined) settingsPanelBody.append(create(document, 'div', 'cxm-error', `插件配置页面错误：${settingsError}`))
  }

  const disposeSettingsForRouteChange = async (): Promise<void> => {
    settingsTransition += 1
    settingsTransitioning = true
    settingsMount?.abort()
    try {
      await stopSettingsContent()
    } finally {
      settingsTransitioning = false
      settingsError = undefined
      settingsRoot = undefined
      settingsPanel = undefined
      settingsPanelBody = undefined
    }
  }

  const stopManagerContent = async (): Promise<void> => {
    const mount = managerContentMount
    const mountId = managerContentMountId
    managerContentMount = undefined
    managerContentMountId = undefined
    if (mount === undefined && mountId === undefined) return
    mount?.abort()
    if (model.closeManagerContent !== undefined) await model.closeManagerContent()
    else await mount?.dispose()
  }

  const resetManagerContent = async (): Promise<void> => {
    managerContentTransition += 1
    if (managerContentMount === undefined && managerContentMountId === undefined) {
      managerContentError = undefined
      managerContentTransitioning = false
      managerContentRoot = undefined
      return
    }
    managerContentTransitioning = true
    try {
      await stopManagerContent()
    } finally {
      managerContentError = undefined
      managerContentTransitioning = false
      managerContentRoot = undefined
    }
  }

  const focusManagerContentNavigation = (id: string): void => {
    navButtons.get(`manager-content:${id}`)?.focus()
  }

  const focusManagerContentTab = (id: string): void => {
    content.querySelectorAll<HTMLButtonElement>('[data-manager-content-tab]').forEach(button => {
      if (button.dataset.managerContentTab === id) button.focus()
    })
  }

  type ManagerContentFocusRestore =
    | { readonly kind: 'navigation' }
    | { readonly kind: 'tab'; readonly id: string }
    | undefined

  const managerContentReferenceKey = (reference: CordisXRouteReference): string => (
    `${reference.id}\u0000${JSON.stringify(Object.entries(reference.params ?? {}).sort(([left], [right]) => left.localeCompare(right)))}`
  )

  const managerContentKey = (id: string, reference: CordisXRouteReference): string => `${id}\u0000${managerContentReferenceKey(reference)}`

  // Encode each local-id code point independently. Concatenated punctuation
  // cannot alias: e.g. "a.b" and "a-b" deliberately produce different IDs.
  const managerContentDomIdPart = (value: string): string => [...value]
    .map(character => character.codePointAt(0)!.toString(16))
    .join('-')

  const managerContentPanelId = (id: string): string => `cordisx-manager-content-panel-${managerContentDomIdPart(id)}`

  const managerContentTabId = (id: string, tabId: string): string => (
    `cordisx-manager-content-tab-${managerContentDomIdPart(id)}-${managerContentDomIdPart(tabId)}`
  )

  const managerContentFocusRestore = (id: string, reference: CordisXRouteReference): ManagerContentFocusRestore => {
    const tabs = model.managerContentPresentation?.(id, reference)?.tabs ?? []
    const active = tabs.filter(tab => managerContentReferenceKey(tab.route) === managerContentReferenceKey(reference))
    return active.length === 1 ? { kind: 'tab', id: active[0]!.id } : { kind: 'navigation' }
  }

  const activateManagerContent = async (
    id: string,
    reference: CordisXRouteReference | undefined,
    restoreFocus: ManagerContentFocusRestore,
    recordHistory = true,
  ): Promise<void> => {
    const item = settingsNavigationItems(model.snapshot()).find(candidate => candidate.id === id)
    if (item === undefined || managerContentTransitioning) return
    const resolvedReference = reference ?? item.route
    if (model.managerContentPresentation !== undefined && model.managerContentPresentation(id, resolvedReference) === undefined) return
    const previousRoute = routeState
    const nextRoute: ManagerRouteState = { kind: 'manager-content', id, reference: resolvedReference }
    const mountKey = managerContentKey(id, resolvedReference)
    if (routeKey(previousRoute) === routeKey(nextRoute) && managerContentMountId === mountKey) {
      if (restoreFocus?.kind === 'navigation') focusManagerContentNavigation(id)
      if (restoreFocus?.kind === 'tab') focusManagerContentTab(restoreFocus.id)
      return
    }
    if (recordHistory && routeKey(previousRoute) !== routeKey(nextRoute)) navigationHistory.push(previousRoute)
    const token = ++managerContentTransition
    managerContentTransitioning = true
    managerContentMount?.abort()
    try {
      await stopManagerContent()
      if (token !== managerContentTransition) return
      routeState = nextRoute
      managerContentError = undefined
      managerContentTransitioning = false
      renderContent()
      if (model.mountManagerContent === undefined || managerContentRoot === undefined) {
        throw new Error('manager content page mount is unavailable')
      }
      managerContentRoot.setAttribute('aria-busy', 'true')
      const loading = create(document, 'div', 'cxm-notice', '正在加载插件页面…')
      managerContentRoot.replaceChildren(loading)
      managerContentMountId = mountKey
      const mount = await model.mountManagerContent(id, resolvedReference, managerContentRoot, {
        navigate: next => activateManagerContent(id, next, undefined),
        back: async () => {
          const active = routeState
          if (active.kind !== 'manager-content') return
          const presentation = model.managerContentPresentation?.(active.id, active.reference)
          if (presentation?.parent !== undefined) await activateManagerContent(active.id, presentation.parent, { kind: 'navigation' })
          else await navigateBack()
        },
      })
      if (token !== managerContentTransition || routeState.kind !== 'manager-content'
        || routeState.id !== id || managerContentKey(id, routeState.reference) !== mountKey) {
        mount.abort()
        await mount.dispose()
        return
      }
      managerContentMount = mount
      managerContentMountId = mountKey
      loading.remove()
      managerContentRoot.removeAttribute('aria-busy')
      if (restoreFocus?.kind === 'navigation') focusManagerContentNavigation(id)
      if (restoreFocus?.kind === 'tab') focusManagerContentTab(restoreFocus.id)
    } catch (error) {
      if (token !== managerContentTransition) return
      managerContentMount?.abort()
      await stopManagerContent().catch(() => {})
      managerContentError = error instanceof Error ? error.message : String(error)
      routeState = { kind: 'primary', primary: 'plugins' }
      managerContentTransitioning = false
      renderContent()
      if (restoreFocus !== undefined) navButtons.get('plugins')?.focus()
    }
  }

  const renderManagerContent = (snapshot: ManagerSnapshot, id: string, reference: CordisXRouteReference): void => {
    const item = settingsNavigationItems(snapshot).find(candidate => candidate.id === id)
    if (item === undefined) return
    const projection = model.managerContentPresentation?.(id, reference) ?? {
      title: item.pageTitle,
      description: item.pageDescription,
      icon: item.icon,
      tabs: [],
    }
    // The current exact route is the only authority for selection. An invalid
    // projection is rendered as an untabbed page instead of emitting a broken
    // tablist with no active tab or an orphaned aria-labelledby reference.
    const activeTabs = projection.tabs.filter(tab => (
      managerContentReferenceKey(tab.route) === managerContentReferenceKey(reference)
    ))
    const activeTab = activeTabs.length === 1 ? activeTabs[0] : undefined
    const tabs = activeTab === undefined
      ? []
      : projection.tabs.map(tab => ({ ...tab, active: tab === activeTab }))
    // A Manager navigation row is the page's first-level parent. Its icon and
    // label form the Host header, so route history never adds a duplicate Back
    // control or a "Plugins / …" breadcrumb above plugin-owned body content.
    setDirectManagerNavigationHeading(item.title, item.icon)
    if (managerContentRoot === undefined || !managerContentRoot.isConnected) {
      managerContentRoot = create(document, 'div', 'cxm-manager-content-root')
      managerContentRoot.dataset.managerContentRoot = 'true'
      content.append(managerContentRoot)
    }
    const focusedTabId = document.activeElement instanceof document.defaultView!.HTMLElement
      ? document.activeElement.dataset.managerContentTab
      : undefined
    content.querySelector<HTMLElement>('[data-manager-content-tabs]')?.remove()
    if (tabs.length > 0 && activeTab !== undefined) {
      const tablist = create(document, 'div', 'cxm-tabs')
      tablist.dataset.managerContentTabs = 'true'
      tablist.setAttribute('role', 'tablist')
      tablist.setAttribute('aria-label', projection.title)
      tablist.setAttribute('aria-orientation', 'horizontal')
      const panelId = managerContentPanelId(id)
      managerContentRoot.id = panelId
      managerContentRoot.setAttribute('role', 'tabpanel')
      managerContentRoot.tabIndex = 0
      for (const tab of tabs) {
        const button = create(document, 'button', 'cxm-tab')
        button.type = 'button'
        button.id = managerContentTabId(id, tab.id)
        button.dataset.managerContentTab = tab.id
        button.setAttribute('role', 'tab')
        button.setAttribute('aria-controls', panelId)
        button.setAttribute('aria-selected', String(tab.active))
        button.tabIndex = tab.active ? 0 : -1
        const visibleContent = create(document, 'span', 'cxm-tab-content')
        const icon = createHostSurfaceIcon(document, tab.icon)
        icon.classList.add('cxm-tab-icon')
        visibleContent.append(icon, create(document, 'span', undefined, tab.label))
        button.append(visibleContent)
        const activate = (): void => { void activateManagerContent(id, tab.route, { kind: 'tab', id: tab.id }, false) }
        button.addEventListener('click', activate)
        button.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            activate()
            return
          }
          const current = tabs.findIndex(candidate => candidate.id === tab.id)
          let next: (typeof tabs)[number] | undefined
          if (event.key === 'ArrowRight') next = tabs[(current + 1) % tabs.length]
          if (event.key === 'ArrowLeft') next = tabs[(current - 1 + tabs.length) % tabs.length]
          if (event.key === 'Home') next = tabs[0]
          if (event.key === 'End') next = tabs.at(-1)
          if (next === undefined) return
          event.preventDefault()
          void activateManagerContent(id, next.route, { kind: 'tab', id: next.id }, false)
        })
        tablist.append(button)
      }
      managerContentRoot.setAttribute('aria-labelledby', managerContentTabId(id, activeTab.id))
      content.insertBefore(tablist, managerContentRoot)
      if (focusedTabId !== undefined) focusManagerContentTab(focusedTabId)
    } else {
      managerContentRoot.removeAttribute('role')
      managerContentRoot.removeAttribute('aria-labelledby')
      managerContentRoot.removeAttribute('tabindex')
      managerContentRoot.removeAttribute('id')
    }
    const mountKey = managerContentKey(id, reference)
    managerContentRoot.dataset.managerContentId = id
    managerContentRoot.dataset.managerContentRoute = reference.id
    if (managerContentMountId !== mountKey) {
      managerContentRoot.replaceChildren(create(document, 'div', 'cxm-notice', managerContentTransitioning ? '正在切换插件页面…' : '插件页面尚未加载。'))
      if (!managerContentTransitioning && managerContentError === undefined) {
        queueMicrotask(() => {
          if (routeState.kind !== 'manager-content' || routeState.id !== id
            || managerContentKey(id, routeState.reference) !== mountKey || managerContentMountId === mountKey || managerContentTransitioning) return
          void activateManagerContent(id, reference, undefined, false)
        })
      }
    }
    if (managerContentError !== undefined) managerContentRoot.append(create(document, 'div', 'cxm-error', '无法打开插件页面。'))
  }

  const syncSettingsNavigation = (snapshot: ManagerSnapshot): void => {
    const focusedId = document.activeElement instanceof document.defaultView!.HTMLElement
      ? document.activeElement.dataset.managerNavigationId
      : undefined
    for (const [id] of navButtons) {
      if (id.startsWith('manager-content:')) navButtons.delete(id)
    }
    for (const previous of nav.querySelectorAll<HTMLElement>('[data-settings-navigation-item]')) previous.remove()
    const aboutButton = navButtons.get('about')
    if (aboutButton === undefined) return
    const items = settingsNavigationItems(snapshot)
    const build = (item: ManagerSettingsNavigationItemSnapshot): HTMLButtonElement => {
      const button = create(document, 'button', 'cxm-nav-button')
      button.type = 'button'
      button.dataset.settingsNavigationItem = item.id
      button.dataset.managerNavigationId = `manager-content:${item.id}`
      button.dataset.settingsNavigationGroup = item.group
      button.setAttribute('aria-label', item.title)
      button.setAttribute('aria-description', item.description)
      button.disabled = item.disabled
      if (item.disabled) button.setAttribute('aria-disabled', 'true')
      if (item.disabledReason !== undefined) button.title = item.disabledReason
      const icon = createHostSurfaceIcon(document, item.icon)
      icon.classList.add('cxm-nav-icon')
      icon.setAttribute('aria-hidden', 'true')
      button.append(icon, create(document, 'span', 'cxm-nav-label', item.title))
      button.addEventListener('click', () => {
        if (!item.disabled) void activateManagerContent(item.id, item.route, { kind: 'navigation' })
      })
      button.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          if (!item.disabled) void activateManagerContent(item.id, item.route, { kind: 'navigation' })
          return
        }
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const candidates = [...nav.querySelectorAll<HTMLButtonElement>('.cxm-nav-button')].filter(candidate => !candidate.disabled)
        const index = candidates.indexOf(button)
        const next = event.key === 'Home' ? candidates[0]
          : event.key === 'End' ? candidates.at(-1)
            : candidates.at((index + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length)
        next?.focus()
      })
      navButtons.set(`manager-content:${item.id}`, button)
      return button
    }
    // The old Settings row is intentionally absent. Both compatibility groups share
    // this Host-owned virtual seam immediately before About, never a plugin anchor.
    for (const item of items) nav.insertBefore(build(item), aboutButton)
    if (focusedId !== undefined) navButtons.get(focusedId)?.focus()
  }

  const navigateRoute = async (
    target: ManagerRouteState,
    options: { readonly recordHistory?: boolean; readonly restoreFocus?: boolean } = {},
  ): Promise<void> => {
    const recordHistory = options.recordHistory ?? true
    const restoreFocus = options.restoreFocus ?? false
    const next = normalizeRoute(model.snapshot(), target)
    if (routeKey(next) === routeKey(routeState)) return
    if (next.kind === 'settings') {
      await activateSettingsTab(next.tabId, restoreFocus, recordHistory)
      return
    }
    if (next.kind === 'manager-content') {
      await activateManagerContent(
        next.id,
        next.reference,
        restoreFocus ? managerContentFocusRestore(next.id, next.reference) : undefined,
        recordHistory,
      )
      return
    }
    const previous = routeState
    if (recordHistory) navigationHistory.push(previous)
    if (activePrimary(previous) === 'settings') await disposeSettingsForRouteChange()
    if (previous.kind === 'manager-content') {
      await resetManagerContent()
    }
    routeState = next
    renderContent()
    if (next.kind === 'primary') restoreListScroll()
    if (restoreFocus && next.kind === 'primary') navButtons.get(next.primary)?.focus()
  }

  const navigateBack = async (): Promise<void> => {
    const snapshot = model.snapshot()
    let target: ManagerRouteState | undefined
    while (navigationHistory.length > 0 && target === undefined) {
      const candidate = navigationHistory.pop()
      if (candidate === undefined) break
      const normalized = normalizeRoute(snapshot, candidate)
      if (routeKey(normalized) !== routeKey(routeState)) target = normalized
    }
    if (target === undefined) {
      const segments = resolvePageRoute(snapshot).segments
      target = [...segments].reverse().find(segment => (
        segment.target !== undefined && routeKey(segment.target) !== routeKey(routeState)
      ))?.target
    }
    if (target !== undefined) await navigateRoute(target, { recordHistory: false, restoreFocus: true })
    else navButtons.get(activePrimary())?.focus()
  }

  function renderContent(): void {
    tooltips.hide()
    disposeConfigFieldActionMenus()
    disposeLunaConsoles()
    marketplaceCollectionView?.dispose()
    marketplaceCollectionView = undefined
    delete content.dataset.marketplaceDiscovery
    delete content.dataset.managerListPage
    delete content.dataset.managerContentPage
    const snapshot = model.snapshot()
    renderedLocale = snapshot.localization.locale
    syncPrimaryChrome(renderedLocale)
    const normalized = normalizeRoute(snapshot)
    const normalizedRouteChanged = routeKey(normalized) !== routeKey(routeState)
    const removedActiveManagerContent = routeState.kind === 'manager-content'
      && normalized.kind === 'primary' && normalized.primary === 'plugins'
    if (normalizedRouteChanged) {
      routeState = normalized
      if (removedActiveManagerContent) void resetManagerContent().then(renderContent).catch(() => {})
    }
    const primary = activePrimary()
    syncSettingsNavigation(snapshot)
    const preserveManagerContent = routeState.kind === 'manager-content' && managerContentRoot?.isConnected === true
    if (!preserveManagerContent) {
      disposeHostCollections()
      disposeConfigRenderers()
      content.replaceChildren()
      delete content.dataset.scrollMode
    }
    for (const [id, button] of navButtons) {
      const selected = id === primary
      if (selected) button.setAttribute('aria-current', 'page')
      else button.removeAttribute('aria-current')
      button.removeAttribute('aria-selected')
      button.tabIndex = selected ? 0 : -1
      const icon = button.querySelector<HTMLElement>(':scope > .cordisx-host-icon')
      const surfaceToken = icon?.dataset.hostIcon
      const managerToken = icon?.dataset.hostIconKey as ManagerIconToken | undefined
      if (icon !== null && icon !== undefined && managerToken !== undefined && surfaceToken === undefined) {
        icon.replaceChildren(renderManagerIconSvg(document, managerToken, {
          state: selected ? 'active' : 'default',
          theme: resolveHostTheme(document).theme,
        }).svg)
      } else if (surfaceToken !== undefined) {
        const key = hostSurfaceIconKey(surfaceToken)
        if (icon !== null && icon !== undefined && key !== undefined) icon.replaceChildren(renderHostIconSvg(document, key, {
          state: selected ? 'active' : 'default',
          theme: resolveHostTheme(document).theme,
        }).svg)
      }
    }
    if (removedActiveManagerContent) queueMicrotask(() => navButtons.get('plugins')?.focus())
    if (routeState.kind === 'permission') return renderPermissionDetail(snapshot, routeState.pluginId, routeState.capability, routeState.fingerprint)
    if (routeState.kind === 'plugin') return renderPluginDetail(snapshot, routeState.pluginId)
    if (routeState.kind === 'marketplace') return renderMarketplaceDetail(snapshot, routeState.identity)
    if (routeState.kind === 'marketplace-source') return renderMarketplaceSourcePage(snapshot, routeState)
    if (routeState.kind === 'extension-point') return renderExtensionPointDetail(snapshot, routeState.pointId)
    if (routeState.kind === 'route') return renderRouteDetail(snapshot, routeState.qualifiedId)
    if (routeState.kind === 'page') return renderPageDetail(snapshot, routeState.qualifiedId)
    if (routeState.kind === 'manager-content') {
      content.dataset.managerContentPage = 'true'
      return renderManagerContent(snapshot, routeState.id, routeState.reference)
    }
    if (routeState.kind !== 'primary') return renderPluginList(snapshot)
    if (routeState.primary === 'about') renderAbout(snapshot)
    if (routeState.primary === 'extension-points') renderExtensionPointList(snapshot)
    if (routeState.primary === 'routes') renderRouteList(snapshot)
    if (routeState.primary === 'plugins') renderPluginList(snapshot)
    if (routeState.primary === 'marketplace') renderMarketplaceList(snapshot)
    if (normalizedRouteChanged) restoreListScroll()
  }

  const open = (): void => {
    modal.hidden = false
    trigger.setAttribute('aria-expanded', 'true')
    syncHostUiTheme()
    renderContent()
    close.focus()
  }
  const dismiss = (): void => {
    disposeHostCollections()
    disposeConfigRenderers()
    disposeConfigFieldActionMenus()
    disposeLunaConsoles()
    marketplaceCollectionView?.dispose()
    marketplaceCollectionView = undefined
    settingsMount?.abort()
    if (settingsMount !== undefined || settingsMountId !== undefined) void resetSettings().catch(() => {})
    if (managerContentMount !== undefined || managerContentMountId !== undefined) void resetManagerContent().catch(() => {})
    modal.hidden = true
    trigger.setAttribute('aria-expanded', 'false')
    trigger.focus()
  }
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.key !== 'Escape' || modal.hidden) return
    if (pluginActionMenuOpen) {
      event.preventDefault()
      closePluginActionMenu(true)
      return
    }
    dismiss()
  }
  trigger.addEventListener('click', open)
  close.addEventListener('click', dismiss)
  content.addEventListener('click', (event) => {
    const target = event.target instanceof document.defaultView!.Element ? event.target : undefined
    if (target?.closest('a[href]') !== null && target !== undefined) hideForExternalNavigation()
  })
  const closeMenuOutside = (event: Event): void => {
    if (!pluginActionMenuOpen || pluginActionMenuContainsEvent(event)) return
    closePluginActionMenu(true)
  }
  const repositionMenu = (): void => repositionPluginActionMenu()
  document.addEventListener('pointerdown', closeMenuOutside, true)
  document.addEventListener('click', closeMenuOutside, true)
  document.defaultView?.addEventListener('resize', repositionMenu)
  document.defaultView?.addEventListener('scroll', repositionMenu, true)
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) dismiss()
  })
  document.addEventListener('keydown', onKeydown)
  for (const [id, button] of navButtons) {
    button.addEventListener('click', () => {
      void navigateRoute({ kind: 'primary', primary: id as ManagerTab })
    })
    button.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        void navigateRoute({ kind: 'primary', primary: id as ManagerTab }, { restoreFocus: true })
        return
      }
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const candidates = [...nav.querySelectorAll<HTMLButtonElement>('.cxm-nav-button')].filter(candidate => !candidate.disabled)
      const index = candidates.indexOf(button)
      const next = event.key === 'Home' ? candidates[0]
        : event.key === 'End' ? candidates.at(-1)
          : candidates.at((index + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length)
      next?.focus()
    })
  }

  let currentTarget: HTMLElement | undefined
  let scheduled = false
  const reconcile = (): void => {
    scheduled = false
    syncHostUiTheme()
    const target = options.triggerTarget?.() ?? resolveManagerTriggerTarget(document)
    if (target === undefined) {
      trigger.remove()
      currentTarget = undefined
      return
    }
    if (target === currentTarget && trigger.isConnected && trigger.previousElementSibling === target) return
    target.after(trigger)
    currentTarget = target
  }
  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(reconcile)
  }
  const Observer = document.defaultView?.MutationObserver
  const observer = Observer === undefined ? undefined : new Observer(() => {
    schedule()
  })
  const themeObserver = Observer === undefined ? undefined : new Observer(syncHostUiTheme)
  if (document.documentElement !== null) observer?.observe(document.documentElement, { childList: true, subtree: true })
  if (document.documentElement !== null) themeObserver?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme', 'data-color-theme', 'data-color-scheme'],
  })
  reconcile()
  renderContent()
  const unsubscribeRuntime = model.subscribe(renderContent)
  const unsubscribePluginConsole = model.subscribePluginConsole?.(pluginId => {
    if (!consolePaused && routeState.kind === 'plugin' && routeState.pluginId === pluginId
      && (routeState.facet === 'runtime' || routeState.facet === 'logs')) renderContent()
  }) ?? (() => {})
  const unsubscribeMarketplace = marketplace.subscribe(renderContent)
  void marketplace.reload()

  return () => {
    breadcrumbCleanup()
    disposeHostCollections()
    disposeConfigRenderers()
    disposeConfigFieldActionMenus()
    disposeLunaConsoles()
    marketplaceCollectionView?.dispose()
    marketplaceCollectionView = undefined
    settingsMount?.abort()
    void stopSettingsContent().catch(() => {})
    observer?.disconnect()
    themeObserver?.disconnect()
    unsubscribeRuntime()
    unsubscribePluginConsole()
    unsubscribeMarketplace()
    marketplace.dispose()
    tooltips.dispose()
    marketplaceFetcher.dispose()
    publisherGrantClient.dispose()
    document.removeEventListener('keydown', onKeydown)
    document.removeEventListener('pointerdown', closeMenuOutside, true)
    document.removeEventListener('click', closeMenuOutside, true)
    document.defaultView?.removeEventListener('resize', repositionMenu)
    document.defaultView?.removeEventListener('scroll', repositionMenu, true)
    closePluginActionMenu(false)
    trigger.removeEventListener('click', open)
    trigger.remove()
    for (const [portal, detachTheme] of ownedPortals) {
      detachTheme()
      portal.remove()
    }
    ownedPortals.clear()
    detachModalTheme()
    modal.remove()
    style.remove()
    theme.dispose()
  }
}
