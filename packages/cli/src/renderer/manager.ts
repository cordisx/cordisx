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
  CordisXPermissionAuthorizationDecisionV2,
  CordisXPermissionAuthorizationPlanV2,
  CordisXPermissionCapabilityV2,
} from '../permission-contracts.js'
import { PermissionAuthorizationViewModel } from '../permission-authorization-view-model.js'
import {
  BrowserMarketplaceModel,
  OFFICIAL_MARKETPLACE_SOURCE,
  normalizeMarketplaceSource,
  projectMarketplacePlugin,
  projectMarketplaceSourceName,
  searchMarketplaceCatalog,
  type MarketplaceCatalogEligibility,
  type MarketplaceCatalogPlugin,
  type MarketplaceFetcher,
  type MarketplaceModel,
  type MarketplaceStorage,
} from './marketplace.js'
import { renderSafeMarkdown } from './markdown.js'
import type { CommandSnapshot } from './commands.js'
import { resolveManagerTriggerTarget } from './host-probes.js'
import { createHostSurfaceIcon, createManagerIcon, type ManagerIconToken } from './icons.js'
import type {
  ManagedSettingsPageMount,
  NavigationPageSnapshot,
  NavigationSnapshot,
  RouteSnapshot,
} from './navigation.js'
import type { SurfaceContributionSnapshot } from './surfaces.js'
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
import type {
  CordisXCapabilityAvailabilityState,
  CordisXCapabilityProviderFamily,
  CordisXCapabilityProviderKind,
} from '../capability-availability-contracts.js'
import cordisxMarkDark from '../../assets/brand/cordisx-mark-dark.svg'
import cordisxMarkLight from '../../assets/brand/cordisx-mark-light.svg'
import { HostTooltipController } from './tooltips.js'
import { HostThemeProjection, resolveHostTheme } from './host-theme.js'
import { HOST_FORM_STYLES, HostFormAdapter, selectHostFormPrimitive, validateHostFormValue } from './host-form.js'
import { BrowserPermissionAuthorizationDialog } from './permission-authorization-dialog.js'
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
}

export interface ManagerPermissionSnapshot {
  readonly identity: CordisXPluginIdentity
  readonly capability: CordisXPlatformCapability
  readonly required: boolean
  readonly reason: CordisXLocalizedText
  readonly reasonText: string
  readonly scope: CordisXCapabilityScope
  readonly policy: CordisXPermissionPolicy
  readonly lastRequested?: RequestedScope
  readonly lastUsedAt?: string
  readonly lastDeniedAt?: string
  readonly denialCount: number
  readonly blockedReason?: string
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
  readonly scope?: CordisXCapabilityScope
}

export interface ManagerCapabilityAvailabilitySnapshot {
  readonly status: CordisXCapabilityAvailabilityState
  readonly reasonText: string
  readonly providers: readonly ManagerCapabilityProviderSnapshot[]
}

export interface ManagerSnapshot {
  readonly version: string
  readonly plugins: readonly ManagerPluginSnapshot[]
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
  readonly settingsTabs?: readonly ManagerSettingsTabSnapshot[]
  readonly pluginLifecycle?: {
    readonly profileId: string
    readonly revision: number
    readonly runtimeGeneration: string
    readonly operationsAvailable: boolean
  }
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

export interface ManagerModel {
  snapshot(): ManagerSnapshot
  pluginConsole?(id: string): CordisXPluginConsolePageV1
  clearPluginConsole?(id: string): void
  subscribePluginConsole?(listener: (pluginId: string) => void): () => void
  setPluginBlocked(id: string, blocked: boolean): Promise<void>
  updatePluginConfig?(id: string, expectedRevision: number, operations: readonly ConfigMutationOperation[]): Promise<void>
  mountConfigRenderer?(
    pluginId: string,
    field: CordisXConfigFieldSnapshot,
    container: HTMLElement,
    setDraft: (value: unknown) => void,
  ): Promise<ConfigRendererMountHandle>
  setPermissionPolicy(id: string, capability: CordisXPlatformCapability, policy: CordisXPermissionPolicy): Promise<void>
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
  requestPluginLifecycle?(operation: CordisXPluginLifecycleOperationV1): Promise<CordisXPluginLifecycleResultV1>
  setExtensionPointPolicy?(source: string, pluginId: string, pointId: string, policy: 'inherit' | 'allow' | 'deny'): Promise<void>
  mountSettingsTab?(id: string, panelBody: HTMLElement): Promise<ManagedSettingsPageMount>
  closeSettingsTabContent?(): Promise<void>
  subscribe(listener: () => void): () => void
}

type ManagerTab = 'about' | 'extension-points' | 'routes' | 'plugins' | 'marketplace' | 'settings'
type PluginDetailTab = 'readme' | 'config' | 'permissions' | 'runtime' | 'extension-points' | 'routes'
type ExtensionPointDetailTab = 'usage' | 'information' | 'diagnostics'
type MarketplaceDetailTab = 'overview' | 'authors-source'
type LocalTabIcon = ManagerIconToken
type ManagerRouteState =
  | { readonly kind: 'primary'; readonly primary: ManagerTab }
  | { readonly kind: 'plugin'; readonly pluginId: string; readonly facet: PluginDetailTab }
  | { readonly kind: 'permission'; readonly pluginId: string; readonly capability: CordisXPlatformCapability }
  | { readonly kind: 'marketplace'; readonly identity: string; readonly facet: MarketplaceDetailTab }
  | { readonly kind: 'extension-point'; readonly pointId: string; readonly facet: ExtensionPointDetailTab }
  | { readonly kind: 'route'; readonly qualifiedId: string }
  | { readonly kind: 'settings'; readonly tabId: string }

interface ManagerBreadcrumbSegment {
  readonly id: string
  readonly label: string
  readonly target?: ManagerRouteState
}

interface ManagerPageRoute {
  readonly id: string
  readonly primary: ManagerTab
  readonly segments: readonly ManagerBreadcrumbSegment[]
}

interface BreadcrumbProjection {
  readonly visible: readonly number[]
  readonly overflow: readonly number[]
}

const MANAGER_STYLE_ID = 'cordisx-manager-style'
const MANAGER_SETTINGS_FALLBACK = 'host:marketplace'
const PLUGIN_DETAIL_TABS: readonly { readonly id: PluginDetailTab; readonly label: string; readonly icon: LocalTabIcon }[] = [
  { id: 'readme', label: 'README', icon: 'document' },
  { id: 'config', label: '配置管理', icon: 'configuration' },
  { id: 'permissions', label: '权限', icon: 'permissions' },
  { id: 'runtime', label: '运行状态', icon: 'runtime' },
  { id: 'extension-points', label: '扩展点位', icon: 'outlets' },
  { id: 'routes', label: '路由', icon: 'routes' },
]
const EXTENSION_POINT_DETAIL_TABS: readonly { readonly id: ExtensionPointDetailTab; readonly label: string; readonly icon: LocalTabIcon }[] = [
  { id: 'usage', label: '使用情况', icon: 'plugins' },
  { id: 'information', label: '点位信息', icon: 'point-info' },
  { id: 'diagnostics', label: '诊断', icon: 'diagnostics' },
]
const MARKETPLACE_DETAIL_TABS: readonly { readonly id: MarketplaceDetailTab; readonly label: string; readonly icon: LocalTabIcon }[] = [
  { id: 'overview', label: '概览', icon: 'overview' },
  { id: 'authors-source', label: '作者与来源', icon: 'authors-source' },
]
export const CORDISX_BUILTIN_MANAGER_SETTINGS_TABS: readonly ManagerSettingsTabSnapshot[] = Object.freeze([
  Object.freeze({ id: 'host:marketplace', owner: 'host', title: '插件商店', icon: 'host:open', order: 100, disabled: false, builtin: true }),
  Object.freeze({ id: 'host:runtime', owner: 'host', title: '运行状态', icon: 'host:analytics', order: 200, disabled: false, builtin: true }),
  Object.freeze({ id: 'host:launcher', owner: 'host', title: '启动器', icon: 'host:settings', order: 300, disabled: false, builtin: true }),
])
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
  .cxm-material-icon,
  .cxm-material-icon svg,
  .cxm-plugin-icon,
  .cxm-status-dot,
  .cxm-dot {
    -webkit-user-select: none;
    user-select: none;
    -webkit-user-drag: none;
  }
  .cxm-material-icon {
    display: inline-grid;
    place-items: center;
    flex: none;
    line-height: 0;
    pointer-events: none;
  }
  .cxm-material-icon svg {
    display: block;
    width: 100%;
    height: 100%;
    fill: currentColor;
    pointer-events: none;
  }
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
  .cxm-nav { display: flex; min-height: 0; flex: 1; flex-direction: column; gap: 4px; }
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
  .cxm-nav-button[aria-selected="true"] { background: rgba(199, 204, 212, .14); color: #eef0f3; }
  .cxm-nav-button[data-tab="about"] { margin-top: auto; }
  .cxm-nav-icon { width: 20px; height: 20px; color: #b8bec8; }
  .cxm-nav-icon svg { width: 18px; height: 18px; }
  .cxm-nav-button:focus-visible,
  .cxm-close:focus-visible,
  .cxm-tab:focus-visible,
  .cxm-plugin-row:focus-visible,
  .cxm-action:focus-visible,
  .cxm-mini-action:focus-visible {
    outline: 2px solid #c7ccd4;
    outline-offset: 2px;
  }
  .cxm-main { display: flex; min-width: 0; min-height: 0; flex-direction: column; overflow: hidden; }
  .cxm-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 72px;
    flex: 0 0 auto;
    padding: 0 22px;
    border-bottom: 1px solid rgba(255, 255, 255, .08);
  }
  .cxm-heading { display: grid; grid-template-columns: 26px minmax(0, 1fr); align-items: start; column-gap: 9px; min-width: 0; flex: 1 1 auto; }
  .cxm-heading-row { display: contents; }
  .cxm-heading-title { display: flex; grid-column: 2; align-items: center; min-width: 0; min-height: 26px; color: #fff; font-size: 16px; font-weight: 700; line-height: 1.2; }
  .cxm-heading-current-heading { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  .cxm-heading p { grid-column: 1 / -1; margin: 3px 0 0; color: #7f899a; font-size: 11px; }
  .cxm-heading-leading {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    flex: none;
    box-sizing: border-box;
    border: 0;
    background: transparent;
    color: #d8dce3;
    align-self: start;
  }
  .cxm-heading-icon svg { width: 18px; height: 18px; transform: translateY(-.5px); }
  .cxm-back {
    padding: 0;
    cursor: pointer;
  }
  .cxm-back { border-radius: 7px; }
  .cxm-back-icon { width: 18px; height: 18px; }
  .cxm-back-icon svg { transform: translateY(-.5px); }
  .cxm-back:hover { background: rgba(199, 204, 212, .14); color: #eef0f3; }
  .cxm-back:focus-visible { outline: 2px solid #c7ccd4; outline-offset: 2px; }
  .cxm-breadcrumbs { min-width: 0; width: 100%; }
  .cxm-breadcrumb-list { display: flex; min-width: 0; margin: 0; padding: 0; align-items: center; list-style: none; white-space: nowrap; }
  .cxm-breadcrumb-item { display: inline-flex; min-width: 0; flex: 0 0 auto; align-items: center; }
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
    width: 30px;
    height: 30px;
    flex: none;
    border: 1px solid rgba(255, 255, 255, .1);
    border-radius: 9px;
    background: rgba(255, 255, 255, .04);
    color: #d8dce5;
    cursor: pointer;
  }
  .cxm-close-icon { width: 18px; height: 18px; }
  .cxm-content {
    min-height: 0;
    flex: 1 1 0%;
    overflow-x: hidden;
    overflow-y: auto;
    padding: 20px 22px 24px;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }
  .cxm-tabs {
    display: flex;
    gap: 5px;
    margin: -4px -8px 16px;
    padding: 0;
    overflow-x: auto;
  }
  .cxm-tab {
    display: inline-flex;
    align-items: center;
    flex: none;
    padding: 7px 9px;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: #858fa1;
    cursor: pointer;
    font: 11px/1.2 system-ui, sans-serif;
  }
  .cxm-tab-content { display: inline-grid; grid-template-columns: 18px max-content; align-items: center; gap: 7px; }
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
  .cxm-tab-panel > .cxm-section-title:first-child { margin-top: 0; }
  .cxm-flat-list {
    margin-top: 8px;
    border-top: 1px solid rgba(255, 255, 255, .08);
    border-bottom: 1px solid rgba(255, 255, 255, .08);
  }
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
  .cxm-permission-control .cxm-source-input { width: 118px; padding-block: 7px; }
  .cxm-permission-detail-intro { display: grid; grid-template-columns: 34px minmax(0, 1fr); align-items: center; gap: 12px; }
  .cxm-permission-detail-intro .cxm-capability-icon { width: 34px; height: 34px; }
  .cxm-permission-detail-intro .cxm-capability-icon svg { width: 26px; height: 26px; }
  .cxm-permission-detail-policy { display: grid; grid-template-columns: max-content minmax(160px, 260px); align-items: center; gap: 12px; margin-top: 18px; }
  .cxm-permission-detail-policy .cxm-field-label { white-space: nowrap; }
  .cxm-permission-provider-item { display: grid; grid-template-columns: minmax(0, 1fr) max-content; align-items: center; gap: 8px 16px; }
  .cxm-permission-provider-item > .cxm-code { grid-column: 1 / -1; margin: 0; }
  .cxm-permission-audit { margin-top: 16px; }
  .cxm-diagnostics { margin-top: 22px; border-top: 1px solid rgba(255, 255, 255, .08); }
  .cxm-diagnostics summary { padding: 14px 2px; color: #98a1b2; cursor: pointer; font-size: 11px; }
  .cxm-diagnostics[open] summary { color: #d8dce3; }
  .cxm-diagnostics-body { padding: 0 2px 4px; }
  .cxm-runtime-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .cxm-console-summary { display: flex; min-width: 0; align-items: stretch; gap: 1px; margin: 10px 0 8px; overflow: hidden; border: 1px solid rgba(255,255,255,.08); border-radius: 8px; background: rgba(255,255,255,.08); }
  .cxm-console-metric { min-width: 72px; padding: 7px 10px; background: #191b1f; }
  .cxm-console-metric strong { display: inline; color: #eceef2; font: 600 13px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .cxm-console-metric span { margin-left: 6px; color: #818a99; font-size: 9px; text-transform: uppercase; letter-spacing: .05em; }
  .cxm-console-performance { flex: 1; min-width: 0; background: #191b1f; }
  .cxm-console-performance summary { padding: 8px 10px; color: #8d96a8; cursor: pointer; font-size: 10px; list-style-position: inside; }
  .cxm-console-performance-body { padding: 0 10px 8px; color: #aab2c0; font: 10px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .cxm-console-controls { display: grid; grid-template-columns: minmax(150px, 1fr) repeat(3, minmax(90px, max-content)) max-content; gap: 7px; align-items: center; margin: 8px 0; }
  .cxm-console-controls input, .cxm-console-controls select { min-width: 0; height: 30px; border: 1px solid #353a42; border-radius: 6px; padding: 0 8px; background: #15171a; color: #d8dce3; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .cxm-console-action-toolbar { display: flex; flex: none; align-items: center; justify-content: flex-end; gap: 2px; min-width: 0; white-space: nowrap; }
  .cxm-console-warning { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-block: 8px; }
  .cxm-console-warning button { flex: none; border: 0; background: transparent; color: inherit; cursor: pointer; font-size: 11px; }
  .cxm-console-workspace { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; align-items: start; }
  .cxm-console-workspace[data-inspector="true"] { grid-template-columns: minmax(0, 1fr) minmax(220px, 280px); }
  .cxm-console-body { position: relative; min-width: 0; }
  .cxm-console-frame { width: 100%; max-height: min(52vh, 520px); overflow: auto; box-sizing: border-box; border: 1px solid #30343a; border-radius: 7px; background: #101215; scrollbar-gutter: stable; overscroll-behavior: contain; }
  .cxm-console-frame.cxm-console-luna { height: var(--cxm-console-content-height, 80px); min-height: 28px; color: #cad0da; cursor: default; }
  .cxm-console-frame.cxm-console-luna.luna-console { border: 1px solid #30343a; background: #101215; }
  .cxm-console-frame.cxm-console-luna .luna-console-log-content { font-size: 11px; line-height: 16px; }
  .cxm-console-frame.cxm-console-luna .luna-console-header { font-size: 10px; }
  .cxm-console-frame.cxm-console-luna:focus-visible { outline: 2px solid #8e98a9; outline-offset: 2px; }
  .cxm-console-latest { position: absolute; right: 14px; bottom: 12px; z-index: 1; height: 28px; border: 1px solid #4a515c; border-radius: 14px; padding: 0 10px; background: #252a31; color: #e3e7ee; box-shadow: 0 4px 14px rgba(0,0,0,.35); cursor: pointer; font-size: 10px; }
  .cxm-console-inspector { min-width: 0; overflow: hidden; border: 1px solid #30343a; border-radius: 7px; background: #141619; }
  .cxm-console-inspector-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-bottom: 1px solid #30343a; color: #cdd2db; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .cxm-console-inspector-head button { border: 0; background: transparent; color: #98a1b2; cursor: pointer; }
  .cxm-console-inspector-grid { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 10px; margin: 0; padding: 10px; font: 10px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .cxm-console-inspector-grid dt { color: #778294; }
  .cxm-console-inspector-grid dd { min-width: 0; margin: 0; overflow-wrap: anywhere; color: #bdc5d2; }
  .cxm-console-empty { display: grid; min-height: 180px; place-items: center; padding: 20px 16px; color: #737d8e; text-align: center; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
  [data-cordisx-manager-modal][data-cordisx-app-theme="light"] .cxm-console-summary { border-color: rgba(18,24,33,.12); background: rgba(18,24,33,.12); }
  [data-cordisx-manager-modal][data-cordisx-app-theme="light"] .cxm-console-metric,
  [data-cordisx-manager-modal][data-cordisx-app-theme="light"] .cxm-console-performance { background: #f4f5f7; }
  [data-cordisx-manager-modal][data-cordisx-app-theme="light"] .cxm-console-metric strong { color: #1d222b; }
  [data-cordisx-manager-modal][data-cordisx-app-theme="light"] .cxm-console-controls input,
  [data-cordisx-manager-modal][data-cordisx-app-theme="light"] .cxm-console-controls select { border-color: #c7ccd4; background: #fff; color: #20242c; }
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
  .cxm-marketplace-filter {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: max-content;
    height: 38px;
    box-sizing: border-box;
    padding: 0 11px;
    border: 1px solid rgba(255, 255, 255, .1);
    border-radius: 9px;
    background: rgba(255, 255, 255, .045);
    color: #aab2c0;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
  }
  .cxm-marketplace-filter:hover { border-color: rgba(199, 204, 212, .38); color: #eef0f4; }
  .cxm-marketplace-filter[aria-pressed="true"] { border-color: rgba(125, 211, 252, .45); background: rgba(125, 211, 252, .12); color: #dff5ff; }
  .cxm-marketplace-filter:focus-visible { outline: 2px solid #c7ccd4; outline-offset: 2px; }
  .cxm-marketplace-filter .cxm-material-icon { width: 17px; height: 17px; }
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
  .cxm-plugin-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
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
  .cxm-manager-icon-action, .cxm-plugin-icon-action, .cxm-plugin-menu-trigger { display: inline-grid; place-items: center; width: 30px; height: 30px; flex: none; box-sizing: border-box; border: 0; border-radius: 8px; background: transparent; color: #aeb5c3; cursor: pointer; }
  .cxm-manager-icon-action:hover:not(:disabled), .cxm-plugin-icon-action:hover:not(:disabled), .cxm-plugin-menu-trigger:hover { background: var(--cx-hover, rgba(199, 204, 212, .12)); color: var(--cx-text, #eef0f4); }
  .cxm-manager-icon-action:focus-visible, .cxm-plugin-icon-action:focus-visible, .cxm-plugin-menu-trigger:focus-visible { outline: 2px solid var(--cx-focus, #c7ccd4); outline-offset: 1px; }
  .cxm-manager-icon-action:disabled, .cxm-plugin-icon-action:disabled { cursor: default; opacity: var(--cx-disabled, .34); }
  .cxm-manager-icon-action[aria-pressed="true"] { background: var(--cx-pressed, rgba(199, 204, 212, .2)); color: var(--cx-text, #eef0f4); }
  .cxm-manager-icon-action .cxm-material-icon, .cxm-plugin-icon-action .cxm-material-icon, .cxm-plugin-menu-trigger .cxm-material-icon { width: 17px; height: 17px; }
  .cxm-plugin-menu { position: relative; }
  .cxm-plugin-menu-popup { position: fixed; z-index: 2147483646; top: 0; left: 0; width: max-content; min-width: 160px; max-width: min(240px, calc(100vw - 32px)); padding: 5px; border: 1px solid rgba(255,255,255,.13); border-radius: 10px; background: #20242d; box-shadow: 0 14px 44px rgba(0,0,0,.45); }
  .cxm-plugin-menu-item { display: flex; align-items: center; gap: 9px; width: 100%; border: 0; border-radius: 7px; padding: 8px 9px; background: transparent; color: #d9dde5; cursor: pointer; text-align: left; font: inherit; }
  .cxm-plugin-menu-item:hover:not(:disabled), .cxm-plugin-menu-item:focus-visible { background: rgba(199,204,212,.11); outline: none; }
  .cxm-plugin-menu-item:disabled { cursor: default; opacity: .42; }
  .cxm-plugin-menu-item[data-tone="danger"] { color: #ff9da5; }
  .cxm-plugin-menu-item .cxm-material-icon { width: 16px; height: 16px; }
  .cxm-plugin-menu-responsive { display: none; }
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
  .cxm-plugin-status-badge {
    position: absolute;
    right: -3px;
    bottom: -3px;
    width: 10px;
    height: 10px;
    box-sizing: border-box;
    border: 2px solid var(--cx-surface-raised, #171b24);
    border-radius: 50%;
    background: #6b7280;
    box-shadow: 0 0 0 1px rgb(0 0 0 / 16%);
  }
  .cxm-plugin-status-badge[data-status="active"] { background: #4ade80; }
  .cxm-plugin-status-badge[data-status="failed"], .cxm-plugin-status-badge[data-status="rollback-failed"] { background: #fb7185; }
  .cxm-plugin-status-badge[data-status="blocked"], .cxm-plugin-status-badge[data-status="permission-blocked"], .cxm-plugin-status-badge[data-status="configured-disabled"] { background: #fbbf24; }
  .cxm-plugin-status-badge[data-status="installing"], .cxm-plugin-status-badge[data-status="updating"], .cxm-plugin-status-badge[data-status="enabling"], .cxm-plugin-status-badge[data-status="disabling"], .cxm-plugin-status-badge[data-status="reloading"], .cxm-plugin-status-badge[data-status="uninstalling"], .cxm-plugin-status-badge[data-status="rolling-back"] { background: #60a5fa; }
  .cxm-plugin-body { min-width: 0; flex: 1; }
  .cxm-plugin-name { overflow: hidden; color: #f0f2f6; font-size: 12px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-plugin-name-row { display: flex; min-width: 0; align-items: center; gap: 6px; }
  .cxm-plugin-name-row > .cxm-plugin-name { min-width: 0; }
  .cxm-marketplace-trust-badges { display: inline-flex; flex: none; align-items: center; gap: 4px; }
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
  .cxm-marketplace-trust-badge .cxm-material-icon { width: 12px; height: 12px; }
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
  .cxm-lifecycle-dialog { width: min(520px, 100%); max-height: min(700px, calc(100vh - 48px)); overflow: auto; box-sizing: border-box; border: 1px solid #3b4048; border-radius: 14px; padding: 20px; background: #20242b; color: #edf0f4; box-shadow: 0 24px 80px rgb(0 0 0 / 45%); }
  .cxm-lifecycle-dialog h2 { margin: 0; font-size: 18px; }
  .cxm-lifecycle-dialog p { color: #bfc5ce; line-height: 1.5; }
  .cxm-lifecycle-impact { margin: 12px 0; padding: 10px 12px; border-radius: 9px; background: rgba(255,255,255,.05); color: #d7dbe3; }
  .cxm-lifecycle-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
  @container (max-width: 470px) {
    .cxm-plugin-icon-action[data-action-priority="3"] { display: none; }
    .cxm-plugin-menu-responsive[data-action-priority="3"] { display: flex; }
  }
  @container (max-width: 390px) {
    .cxm-plugin-icon-action[data-action-priority="2"] { display: none; }
    .cxm-plugin-menu-responsive[data-action-priority="2"] { display: flex; }
  }
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
  .cxm-marketplace-trust-title .cxm-material-icon { width: 17px; height: 17px; }
  .cxm-marketplace-trust-copy { margin: 6px 0 0; color: #9da6b6; font-size: 11px; }
  .cxm-marketplace-trust-meta { margin-top: 7px; color: #7f899a; font: 10px/1.5 ui-monospace, monospace; overflow-wrap: anywhere; }
  .cxm-marketplace-trust-evidence { display: inline-flex; margin-top: 8px; }
  .cxm-code { max-height: 140px; margin: 6px 0 0; overflow: auto; color: #bac2d2; font: 10px/1.45 ui-monospace, monospace; white-space: pre-wrap; }
  .cxm-config-renderer { min-height: 2rem; }
  .cxm-readme { max-width: 760px; color: #b8c0cf; font-size: 12px; line-height: 1.65; }
  .cxm-readme h1, .cxm-readme h2, .cxm-readme h3, .cxm-readme h4 { color: #f5f6f8; line-height: 1.3; }
  .cxm-readme h1 { margin: 2px 0 14px; font-size: 22px; }
  .cxm-readme h2 { margin: 24px 0 10px; font-size: 16px; }
  .cxm-readme h3, .cxm-readme h4 { margin: 18px 0 8px; font-size: 13px; }
  .cxm-readme p { margin: 0 0 12px; }
  .cxm-readme ul { margin: 0 0 14px; padding-left: 21px; }
  .cxm-readme li { margin: 4px 0; }
  .cxm-readme a { color: #d8dce3; text-decoration: none; }
  .cxm-readme a:hover { text-decoration: underline; }
  .cxm-readme code { padding: 1px 4px; border-radius: 4px; background: rgba(255, 255, 255, .065); color: #d8dce3; font: 10px/1.5 ui-monospace, monospace; }
  .cxm-readme pre { margin: 12px 0 16px; overflow: auto; padding: 12px 14px; border: 1px solid rgba(255, 255, 255, .08); border-radius: 10px; background: #0d1017; }
  .cxm-readme pre code { padding: 0; background: transparent; color: #c5ccda; white-space: pre; }
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
  .cxm-route-card-icon { width: 28px; height: 28px; flex: none; color: var(--cx-muted); }
  .cxm-route-card-icon svg { width: 19px; height: 19px; }
  .cxm-route-card-body { min-width: 0; flex: 1 1 auto; }
  .cxm-route-card-title { display: block; overflow: hidden; color: var(--cx-text); font-size: 12px; font-weight: 680; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-route-card-description { display: -webkit-box; margin-top: 3px; overflow: hidden; color: var(--cx-muted); font-size: 11px; line-height: 1.42; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .cxm-route-machine { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 8px 0 0; }
  .cxm-route-machine-item { display: grid; min-width: 0; grid-template-columns: max-content minmax(0, 1fr); gap: 5px; font-size: 10px; line-height: 1.4; }
  .cxm-route-machine dt { color: var(--cx-muted); }
  .cxm-route-machine dd { min-width: 0; margin: 0; overflow-wrap: anywhere; color: var(--cx-text); font-family: ui-monospace, monospace; user-select: text; }
  .cxm-route-metadata-diagnostic { display: flex; min-width: 0; align-items: center; gap: 5px; margin-top: 7px; color: var(--cx-muted); font-size: 10px; line-height: 1.35; }
  .cxm-route-metadata-diagnostic .cxm-material-icon { width: 13px; height: 13px; flex: none; }
  .cxm-route-state { display: flex; min-width: 0; align-items: center; gap: 5px; margin-top: 7px; color: var(--cx-danger); font-size: 10px; line-height: 1.35; }
  .cxm-usage-list { border-top: 1px solid rgba(255, 255, 255, .08); border-bottom: 1px solid rgba(255, 255, 255, .08); }
  .cxm-usage-item { padding: 12px 2px; }
  .cxm-usage-item + .cxm-usage-item { border-top: 1px solid rgba(255, 255, 255, .08); }
  .cxm-usage-header { display: grid; grid-template-columns: minmax(0, 1fr) minmax(150px, 190px); align-items: center; gap: 12px; }
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
  .cxm-source-form { display: flex; gap: 8px; margin-top: 16px; }
  .cxm-source-list { display: grid; gap: 8px; margin-top: 14px; }
  .cxm-source-row { display: flex; align-items: center; gap: 10px; padding: 11px; }
  .cxm-source-index { display: grid; place-items: center; width: 24px; height: 24px; flex: none; border-radius: 7px; background: rgba(199, 204, 212, .11); color: #d8dce3; font-size: 10px; font-weight: 700; }
  .cxm-source-body { min-width: 0; flex: 1; }
  .cxm-source-url { display: block; overflow: hidden; color: #c6ccd8; font: 10px/1.35 ui-monospace, monospace; text-decoration: none; text-overflow: ellipsis; white-space: nowrap; }
  a.cxm-source-url:hover { color: #fff; text-decoration: underline; }
  .cxm-source-state { display: flex; align-items: center; gap: 6px; margin-top: 4px; color: #737e90; font-size: 10px; }
  .cxm-source-actions { display: flex; flex: none; gap: 5px; }
  .cxm-mini-action { padding: 5px 7px; border: 1px solid rgba(255, 255, 255, .09); border-radius: 7px; background: transparent; color: #99a2b2; cursor: pointer; font: 10px/1.2 system-ui, sans-serif; }
  .cxm-mini-action:hover:not(:disabled) { color: #fff; border-color: rgba(199, 204, 212, .4); }
  .cxm-mini-action:disabled { cursor: default; opacity: .35; }
  @media (max-width: 760px) {
    .cxm-backdrop { padding: 10px; }
    .cxm-dialog { grid-template-columns: 168px minmax(0, 1fr); width: calc(100vw - 20px); height: calc(100vh - 20px); }
    .cxm-card-grid, .cxm-detail-grid, .cxm-plugin-list { grid-template-columns: 1fr; }
    .cxm-usage-header { grid-template-columns: minmax(0, 1fr); }
    .cxm-usage-header .cxm-source-input { width: 100%; }
    .cxm-usage-resources { margin-left: 42px; }
    .cxm-resource-row { grid-template-columns: minmax(0, 1fr); }
    .cxm-resource-id { grid-column: 1; grid-row: auto; }
    .cxm-console-controls { grid-template-columns: minmax(0, 1fr) repeat(2, minmax(90px, max-content)); }
    .cxm-console-action-toolbar { grid-column: 1 / -1; }
    .cxm-console-workspace[data-inspector="true"] { grid-template-columns: minmax(0, 1fr); }
    .cxm-catalog-row { gap: 8px; padding: 12px 2px; }
    .cxm-catalog-icon { width: 24px; height: 24px; }
    .cxm-catalog-status { max-width: 34%; }
    .cxm-route-card { gap: 9px; padding: 12px; }
    .cxm-route-card-icon { width: 24px; height: 24px; }
    .cxm-route-machine { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; }
  }
  @media (max-width: 520px) {
    .cxm-console-controls { grid-template-columns: minmax(0, 1fr) minmax(72px, 1fr); }
    .cxm-console-controls > input { grid-column: 1 / -1; }
    .cxm-console-action-toolbar { grid-column: 1 / -1; justify-content: flex-start; }
  }
`

const HOST_THEME_OVERLAY_STYLES = `
  [data-cordisx-manager-modal], .cxm-plugin-menu-popup, .cxm-lifecycle-overlay, .cxm-authorization-overlay { color: var(--cx-text); }
  .cxm-backdrop, .cxm-lifecycle-overlay, .cxm-authorization-overlay { background: var(--cx-backdrop); }
  .cxm-dialog, .cxm-lifecycle-dialog, .cxm-authorization-dialog { border-color: var(--cx-border); background: var(--cx-surface); color: var(--cx-text); box-shadow: 0 24px 80px var(--cx-shadow); }
  .cxm-sidebar { border-color: var(--cx-border); background: var(--cx-surface-raised); }
  .cxm-header, .cxm-about-actions, .cxm-about-action-item + .cxm-about-action-item, .cxm-flat-item + .cxm-flat-item { border-color: var(--cx-border); }
  .cxm-about-actions { background: var(--cx-surface-raised); }
  .cxm-nav-button, .cxm-heading p, .cxm-detail-description, .cxm-permission-reason, .cxm-copy, .cxm-source-state, .cxm-detail-id, .cxm-plugin-description, .cxm-plugin-meta, .cxm-catalog-description, .cxm-catalog-id, .cxm-catalog-status, .cxm-marketplace-trust-copy, .cxm-marketplace-trust-meta, .cxm-field-label { color: var(--cx-muted); }
  .cxm-nav-icon { color: currentColor; }
  .cxm-heading-leading { color: var(--cx-text); }
  .cxm-nav-button:hover, .cxm-nav-button[aria-selected="true"], .cxm-back:hover, .cxm-breadcrumb-action:hover, .cxm-breadcrumb-overflow > summary:hover, .cxm-tab:hover, .cxm-tab[aria-selected="true"], .cxm-about-action:hover, .cxm-about-action:focus-visible { background: var(--cx-hover); color: var(--cx-text); }
  .cxm-about-action-title, .cxm-about-action-copy { background: transparent; }
  .cxm-about-action-title { color: var(--cx-text); }
  .cxm-about-action-copy, .cxm-about-action-arrow { color: var(--cx-muted); }
  .cxm-about-action:hover .cxm-about-action-arrow, .cxm-about-action:focus-visible .cxm-about-action-arrow { color: var(--cx-text); }
  .cxm-heading-title, .cxm-breadcrumb-current, .cxm-card-value, .cxm-section-title, .cxm-about-name, .cxm-search, .cxm-source-input, .cxm-plugin-name, .cxm-catalog-title, .cxm-marketplace-trust-title, .cxm-field-value { color: var(--cx-text); }
  .cxm-card, .cxm-slot-card, .cxm-source-row, .cxm-field, .cxm-lifecycle-impact, .cxm-marketplace-trust-item, .cxm-marketplace-trust-badge { border-color: var(--cx-border); background: var(--cx-hover); }
  .cxm-search, .cxm-source-input, .cxm-close, .cxm-action, .cxm-mini-action, .cxm-marketplace-filter { border-color: var(--cx-border); background: var(--cx-surface-raised); color: var(--cx-text); }
  .cxm-action:hover:not(:disabled), .cxm-mini-action:hover:not(:disabled), .cxm-plugin-menu-item:hover:not(:disabled), .cxm-plugin-menu-item:focus-visible { border-color: var(--cx-primary); background: var(--cx-hover); color: var(--cx-text); }
  .cxm-plugin-menu-popup, .cxm-breadcrumb-menu { border-color: var(--cx-border); background: var(--cx-surface-raised); box-shadow: 0 12px 32px var(--cx-shadow); }
  .cxm-plugin-menu-item, .cxm-authorization-dialog > p, .cxm-authorization-reason, .cxm-authorization-choice { color: var(--cx-text); }
  .cxm-action[data-tone="danger"], .cxm-plugin-menu-item[data-tone="danger"] { color: var(--cx-danger); }
  .cxm-notice { border-color: var(--cx-border); background: var(--cx-hover); color: var(--cx-muted); }
  .cxm-catalog-status[data-tone="pending"] { color: var(--cx-primary); }
  .cxm-catalog-status[data-tone="unavailable"], .cxm-catalog-status[data-tone="error"] { color: var(--cx-danger); }
  .cxm-required-badge { background: var(--cx-hover); color: var(--cx-primary); }
  .cxm-nav-button:focus-visible, .cxm-close:focus-visible, .cxm-tab:focus-visible, .cxm-plugin-row:focus-visible, .cxm-action:focus-visible, .cxm-mini-action:focus-visible, .cxm-search:focus-visible, .cxm-source-input:focus-visible, .cxm-authorization-actions button:focus-visible { outline-color: var(--cx-focus); }
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

function lunaConsoleTime(timestamp: number): string {
  const date = new Date(timestamp)
  const parts = [date.getHours(), date.getMinutes(), date.getSeconds()].map(value => String(value).padStart(2, '0'))
  return `${parts.join(':')}.${String(date.getMilliseconds()).padStart(3, '0')}`
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
  return `${lunaConsoleTime(entry.time)} ${entry.method} ${entry.source} ${entry.kind === 'console' ? args || entry.message : `${entry.message}${args === '' ? '' : ` ${args}`}`}`
}

function capabilityPresentation(capability: CordisXPlatformCapability): CapabilityPresentation {
  const known = CAPABILITY_PRESENTATIONS[capability]
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

function createCapabilityIcon(document: Document, capability: CordisXPlatformCapability): HTMLSpanElement {
  return createManagerIcon(document, capabilityPresentation(capability).icon, 'cxm-capability-icon')
}

function capabilityAvailabilityLabel(status: CordisXCapabilityAvailabilityState): string {
  return status === 'supported' ? '可用' : status === 'degraded' ? '部分可用' : '不可用'
}

function createPermissionPolicySelect(
  document: Document,
  permission: ManagerPermissionSnapshot,
  onChange: (policy: CordisXPermissionPolicy, control: HTMLSelectElement) => Promise<void>,
): HTMLSelectElement {
  const policy = create(document, 'select', 'cxm-source-input cxf-control')
  policy.dataset.hostFormPrimitive = 'select'
  policy.dataset.permissionCapability = permission.capability
  policy.setAttribute('aria-label', `${capabilityPresentation(permission.capability).name}的权限策略`)
  for (const value of ['ask', 'allow', 'deny'] as const) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = POLICY_LABELS[value]
    option.selected = permission.policy === value
    policy.append(option)
  }
  policy.addEventListener('change', () => {
    void onChange(policy.value as CordisXPermissionPolicy, policy)
  })
  return policy
}

export async function requestPluginAuthorization(
  document: Document,
  plugin: Pick<ManagerPluginSnapshot, 'id' | 'name'>,
  plan: CordisXPermissionAuthorizationPlanV1,
  permissions: readonly ManagerPermissionSnapshot[],
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
    const forms = new HostFormAdapter(document)
    const overlay = create(document, 'div', 'cxm-authorization-overlay cxf-scope')
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
      .cxm-authorization-choice input { width: 17px; height: 17px; accent-color: var(--cx-primary); }
      .cxm-authorization-choice input:disabled { cursor: not-allowed; }
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
    const choices = new Map<CordisXPlatformCapability, HTMLInputElement>()
    for (const declaration of plan.declarations) {
      const projected = permissions.find(item => item.capability === declaration.capability)
      const presentation = capabilityPresentation(declaration.capability)
      const item = create(document, 'div', 'cxm-authorization-item')
      item.setAttribute('role', 'listitem')
      item.dataset.authorizationCapability = declaration.capability
      const choice = document.createElement('input')
      choice.type = 'checkbox'
      choice.className = 'cxf-checkbox'
      choice.checked = true
      choice.disabled = declaration.required
      choice.dataset.authorizationChoice = declaration.capability
      choice.setAttribute('aria-label', `${presentation.name}（${declaration.required ? '必需' : '可选'}）`)
      choices.set(declaration.capability, choice)
      const choiceLabel = create(document, 'label', 'cxm-authorization-choice cxf-choice')
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
    return result.status === 'confirmed' ? result.decision : undefined
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
    return result.status === 'confirmed' ? result.decision : undefined
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

function statusLabel(status: ManagerPluginStatus): string {
  if (status === 'active') return '运行中'
  if (status === 'blocked') return '已屏蔽'
  if (status === 'permission-blocked') return '权限阻止'
  if (status === 'failed') return '启动失败'
  if (status === 'installing') return '安装中'
  if (status === 'updating') return '更新中'
  if (status === 'enabling') return '启用中'
  if (status === 'disabling') return '禁用中'
  if (status === 'reloading') return '重载中'
  if (status === 'uninstalling') return '卸载中'
  if (status === 'rolling-back') return '正在恢复'
  if (status === 'rollback-failed') return '恢复失败'
  return '配置禁用'
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

function createPluginIcon(document: Document, name: string, status?: ManagerPluginStatus): HTMLSpanElement {
  const icon = create(document, 'span', 'cxm-plugin-icon', initials(name))
  if (status !== undefined) {
    const badge = create(document, 'span', 'cxm-plugin-status-badge')
    badge.dataset.status = status
    icon.append(badge)
  }
  return markDecorative(icon)
}

function pluginStatusDescription(plugin: ManagerPluginSnapshot, status: ManagerPluginStatus): string {
  const reason = status === 'failed' || status === 'rollback-failed'
    ? plugin.error
    : status === 'blocked' || status === 'permission-blocked' ? plugin.blockedReason ?? plugin.error : undefined
  return reason === undefined ? statusLabel(status) : `${statusLabel(status)}：${reason}`
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
  return `排序依据：${marketplaceTextTierLabel(ranking.textTier)}；官方身份加权 +${ranking.officialBoost}；认证状态加权 +${ranking.certificationBoost}。信任加权只在同一文本相关性层级内生效。`
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
export function installCordisXManager(document: Document, model: ManagerModel): () => void {
  const theme = new HostThemeProjection(document)
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
  style.textContent = `${lunaObjectViewerCss}\n${lunaDataGridCss}\n${lunaDomViewerCss}\n${lunaConsoleCss}\n${MANAGER_STYLES}\n${HOST_THEME_OVERLAY_STYLES}`
  ;(document.head ?? document.documentElement).append(style)

  const trigger = create(document, 'button')
  trigger.type = 'button'
  trigger.dataset.cordisxManagerTrigger = 'true'
  trigger.setAttribute('aria-label', '管理 CordisX 插件')
  trigger.setAttribute('aria-haspopup', 'dialog')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.title = 'CordisX 插件与扩展点'
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
  dialog.setAttribute('aria-label', 'CordisX 插件与扩展点管理器')

  const sidebar = create(document, 'aside', 'cxm-sidebar')
  const nav = create(document, 'nav', 'cxm-nav')
  nav.setAttribute('role', 'tablist')
  nav.setAttribute('aria-label', 'CordisX 管理器页面')
  const tabs: readonly { id: ManagerTab; icon?: ManagerIconToken; label: string; brand?: boolean }[] = [
    { id: 'plugins', icon: 'plugins', label: '插件' },
    { id: 'extension-points', icon: 'contributions', label: '扩展点' },
    { id: 'routes', icon: 'routes', label: '路由' },
    { id: 'marketplace', icon: 'marketplace', label: '插件商店' },
    { id: 'settings', icon: 'settings', label: '配置' },
    { id: 'about', label: '关于 CordisX', brand: true },
  ]
  let routeState: ManagerRouteState = { kind: 'primary', primary: 'plugins' }
  const navigationHistory: ManagerRouteState[] = []
  const navButtons = new Map<ManagerTab, HTMLButtonElement>()
  for (const tab of tabs) {
    const button = create(document, 'button', 'cxm-nav-button')
    button.type = 'button'
    button.dataset.tab = tab.id
    button.setAttribute('role', 'tab')
    const icon = tab.brand === true
      ? createAdaptiveBrandMark(document)
      : createManagerIcon(document, tab.icon ?? 'plugins', 'cxm-nav-icon')
    icon.classList.add('cxm-nav-icon')
    icon.setAttribute('aria-hidden', 'true')
    button.append(icon, create(document, 'span', undefined, tab.label))
    navButtons.set(tab.id, button)
    nav.append(button)
  }
  sidebar.append(nav)

  const main = create(document, 'div', 'cxm-main')
  const header = create(document, 'header', 'cxm-header')
  const heading = create(document, 'div', 'cxm-heading')
  const close = create(document, 'button', 'cxm-close')
  close.type = 'button'
  close.setAttribute('aria-label', '关闭 CordisX 管理器')
  close.append(createManagerIcon(document, 'close', 'cxm-close-icon'))
  header.append(heading, close)
  const content = create(document, 'div', 'cxm-content')
  main.append(header, content)
  dialog.append(sidebar, main)
  backdrop.append(dialog)
  modal.append(backdrop)
  ;(document.body ?? document.documentElement).append(modal)

  const marketplaceFetcher = createMarketplaceFetcher(document.defaultView)
  const marketplace: MarketplaceModel = new BrowserMarketplaceModel(
    safeStorage(document.defaultView),
    marketplaceFetcher.fetcher,
  )
  const tooltips = new HostTooltipController(document)
  const forms = new HostFormAdapter(document)
  let pluginQuery = ''
  let marketplaceQuery = ''
  let marketplaceCertifiedOnly = false
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
  let settingsRoot: HTMLDivElement | undefined
  let settingsPanel: HTMLDivElement | undefined
  let settingsPanelBody: HTMLDivElement | undefined
  let settingsMount: ManagedSettingsPageMount | undefined
  let settingsMountId: string | undefined
  let settingsTransition = 0
  let settingsTransitioning = false
  let settingsError: string | undefined
  const listScrollPositions = new Map<ManagerTab, number>()
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
  let sourcesBusy = false
  const lifecycleBusy = new Map<string, ManagerPluginStatus>()
  let lifecycleInstallBusy = false
  const configRendererMounts = new Set<ConfigRendererMountHandle>()
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

  const disposeConfigRenderers = (): void => {
    for (const mount of configRendererMounts) void mount.dispose()
    configRendererMounts.clear()
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
    closePluginActionMenu(false)
    settingsMount?.abort()
    if (settingsMount !== undefined || settingsMountId !== undefined) void resetSettings().catch(() => {})
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

  const requestLocalPackageDirectory = (): Promise<string | undefined> => new Promise(resolve => {
    const overlay = create(document, 'div', 'cxm-lifecycle-overlay')
    let unmountOverlay = (): void => {}
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    const panel = create(document, 'div', 'cxm-lifecycle-dialog')
    panel.append(
      create(document, 'h2', undefined, '导入本地插件'),
      create(document, 'p', undefined, '选择本地插件目录以导入。'),
      documentationLink('查看导入说明', PRODUCT_DOCUMENTATION.runtime),
    )
    const form = forms.form('local-package-directory')
    const item = forms.item({
      id: 'cxm-local-package-directory', label: '本地插件包绝对路径',
      help: '仅接受明确的本地绝对目录；Host 将先检查包内容，再进入授权和激活事务。', fullWidth: true, required: true,
    })
    let pathValue = ''
    const pathField: CordisXConfigFieldSnapshot = {
      namespace: 'cordisx.host', path: ['localPackageDirectory'], type: 'string', role: 'directory', value: '', disabled: false, required: true,
    }
    const control = forms.control(pathField, 'cxm-local-package-directory', value => {
      pathValue = typeof value === 'string' ? value.trim() : ''
      const absolute = pathValue.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(pathValue)
      item.setError(pathValue === '' ? '请输入本地包绝对路径' : absolute ? undefined : '请输入绝对路径')
    })
    control.focusTarget?.setAttribute('data-import-local-path', '')
    forms.connect(item, control)
    item.control.append(control.root)
    form.append(item.root)
    const actions = create(document, 'div', 'cxf-actions')
    const finish = (value?: string): void => {
      unmountOverlay()
      resolve(value)
    }
    const cancel = forms.button('取消')
    cancel.addEventListener('click', () => finish(), { once: true })
    const inspect = forms.button('检查并导入', { type: 'submit', variant: 'primary' })
    inspect.setAttribute('data-import-local-submit', '')
    form.addEventListener('submit', event => {
      event.preventDefault()
      const absolute = pathValue.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(pathValue)
      if (pathValue === '' || !absolute) {
        item.setError(pathValue === '' ? '请输入本地包绝对路径' : '请输入绝对路径')
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
    form.append(actions)
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

  const runLocalPackageInstall = async (): Promise<void> => {
    const sourceDirectory = await requestLocalPackageDirectory()
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
      const planV2 = await model.permissionLifecycleReviewPlanV2?.({
        kind: 'candidate',
        candidateId: inspection.candidateId,
      })
      let applied: CordisXPluginLifecycleResultV1
      if (planV2 !== undefined) {
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
        const planV2 = await model.permissionLifecycleReviewPlanV2?.({ kind: 'enable', pluginId: plugin.id })
        let result: CordisXPluginLifecycleResultV1
        if (planV2 !== undefined) {
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

  const activePrimary = (route: ManagerRouteState = routeState): ManagerTab => {
    if (route.kind === 'primary') return route.primary
    if (route.kind === 'plugin' || route.kind === 'permission') return 'plugins'
    if (route.kind === 'extension-point') return 'extension-points'
    if (route.kind === 'route') return 'routes'
    if (route.kind === 'marketplace') return 'marketplace'
    return 'settings'
  }

  const currentSettingsTab = (): string => routeState.kind === 'settings'
    ? routeState.tabId
    : MANAGER_SETTINGS_FALLBACK

  const pluginFacet = (id: PluginDetailTab): typeof PLUGIN_DETAIL_TABS[number] => (
    PLUGIN_DETAIL_TABS.find(item => item.id === id) ?? PLUGIN_DETAIL_TABS[0]!
  )
  const extensionPointFacet = (id: ExtensionPointDetailTab): typeof EXTENSION_POINT_DETAIL_TABS[number] => (
    EXTENSION_POINT_DETAIL_TABS.find(item => item.id === id) ?? EXTENSION_POINT_DETAIL_TABS[0]!
  )
  const marketplaceFacet = (id: MarketplaceDetailTab): typeof MARKETPLACE_DETAIL_TABS[number] => (
    MARKETPLACE_DETAIL_TABS.find(item => item.id === id) ?? MARKETPLACE_DETAIL_TABS[0]!
  )

  const resolvePageRoute = (snapshot: ManagerSnapshot): ManagerPageRoute => {
    const route = routeState
    const primary = activePrimary()
    const primaryLabels: Readonly<Record<ManagerTab, string>> = {
      plugins: '插件',
      'extension-points': '扩展点',
      routes: '路由',
      marketplace: '插件商店',
      settings: '配置',
      about: '关于 CordisX',
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
        id: `plugin:${route.pluginId}:permission:${route.capability}`,
        primary,
        segments: [
          root('plugins'),
          { id: `plugin:${route.pluginId}`, label: plugin?.name ?? route.pluginId, target: { kind: 'plugin', pluginId: route.pluginId, facet: 'readme' } },
          { id: `plugin:${route.pluginId}:facet:permissions`, label: pluginFacet('permissions').label, target: { kind: 'plugin', pluginId: route.pluginId, facet: 'permissions' } },
          { id: `plugin:${route.pluginId}:permission:${route.capability}`, label: capabilityPresentation(route.capability).name },
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
    const settingsItem = settingsTabs(snapshot).find(item => item.id === route.tabId)
    return {
      id: `settings:${route.tabId}`,
      primary,
      segments: [
        root('settings'),
        { id: `settings:${route.tabId}`, label: settingsItem?.title ?? route.tabId },
      ],
    }
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
    if (candidate.kind === 'marketplace') {
      const marketplaceSnapshot = marketplace.snapshot()
      if (!marketplaceSnapshot.loading && !marketplaceSnapshot.plugins.some(item => item.identity === candidate.identity)) {
        return { kind: 'primary', primary: 'marketplace' }
      }
    }
    if (candidate.kind === 'settings') {
      const item = settingsTabs(snapshot).find(item => item.id === candidate.tabId)
      if (item === undefined || item.disabled) return { kind: 'primary', primary: 'settings' }
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
        return item === null ? 0 : Math.max(item.getBoundingClientRect().width, item.scrollWidth)
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
    copy: string,
    snapshot: ManagerSnapshot,
    options: { readonly icon?: ManagerIconToken; readonly brand?: boolean } = {},
  ): void => {
    heading.replaceChildren()
    const pageRoute = resolvePageRoute(snapshot)
    const row = create(document, 'div', 'cxm-heading-row')
    if (pageRoute.segments.length > 1) {
      const back = create(document, 'button', 'cxm-heading-leading cxm-back')
      back.type = 'button'
      back.setAttribute('aria-label', '返回')
      back.append(createManagerIcon(document, 'back', 'cxm-back-icon'))
      back.addEventListener('click', () => { void navigateBack() })
      row.append(back)
    } else {
      const icon = options.brand === true
        ? createAdaptiveBrandMark(document)
        : createManagerIcon(document, options.icon ?? 'plugins')
      icon.classList.add('cxm-heading-leading', 'cxm-heading-icon')
      icon.setAttribute('aria-hidden', 'true')
      row.append(icon)
    }
    const title = create(document, 'div', 'cxm-heading-title')
    const current = pageRoute.segments.at(-1)?.label ?? ''
    title.append(create(document, 'h2', 'cxm-heading-current-heading', current), renderBreadcrumbs(pageRoute))
    row.append(title)
    heading.append(row, create(document, 'p', undefined, copy))
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
    setHeading('扩展点位', snapshot, { icon: 'contributions' })
    const search = createListSearch('extension-points', '搜索 CordisX 扩展点', '搜索名称、介绍、点位 id 或插件…', extensionPointQuery, value => { extensionPointQuery = value })
    content.append(search)

    const points = snapshot.extensionPoints?.points ?? []
    const catalogText = snapshot.extensionPoints?.catalogText
    const filtered = points.filter(point => matchesManagerSearch(extensionPointQuery, [
      point.titleProjection.text,
      point.descriptionProjection.text,
      point.id,
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
    ]))
    const list = create(document, 'div', 'cxm-catalog-list')
    list.setAttribute('role', 'list')
    list.setAttribute('aria-label', '扩展点列表')
    if (points.length === 0) list.append(create(document, 'div', 'cxm-empty', '当前宿主没有声明扩展点；请查看运行诊断。'))
    else if (filtered.length === 0) list.append(create(document, 'div', 'cxm-empty', '没有匹配的扩展点'))
    for (const point of filtered) {
      list.append(createExtensionPointCatalogItem(snapshot, point, facet => {
        rememberListScroll()
        operationError = undefined
        void navigateRoute({ kind: 'extension-point', pointId: point.id, facet })
      }))
    }
    content.append(list)
  }

  const renderExtensionPointDetail = (snapshot: ManagerSnapshot, id: string): void => {
    const point = snapshot.extensionPoints?.points.find(item => item.id === id)
    setHeading(point?.titleProjection.text ?? '扩展点当前不可用', snapshot)
    if (point === undefined) {
      content.append(create(document, 'div', 'cxm-empty', '该扩展点已不在当前宿主目录中'))
      return
    }
    const activeFacet = routeState.kind === 'extension-point' ? routeState.facet : 'usage'
    content.append(createLocalTabs(document, EXTENSION_POINT_DETAIL_TABS, activeFacet, 'data-extension-point-detail-tab', (tab) => {
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
        const policy = create(document, 'select', 'cxm-source-input')
        policy.setAttribute('aria-label', `${usage.name}使用${point.titleProjection.text}的策略`)
        for (const value of ['inherit', 'allow', 'deny'] as const) {
          const option = document.createElement('option')
          option.value = value
          option.textContent = value === 'inherit' ? '跟随宿主默认' : value === 'allow' ? '允许' : '拒绝'
          option.selected = usage.policy === value
          policy.append(option)
        }
        policy.disabled = model.setExtensionPointPolicy === undefined
        policy.addEventListener('change', async () => {
          policy.disabled = true
          operationError = undefined
          try {
            await model.setExtensionPointPolicy?.(usage.identity.source, usage.identity.id, point.id, policy.value as 'inherit' | 'allow' | 'deny')
          } catch (error) {
            operationError = error instanceof Error ? error.message : String(error)
          } finally {
            renderContent()
          }
        })
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
    setHeading('路由', snapshot, { icon: 'routes' })
    const search = createListSearch('routes', '搜索 CordisX 路由和页面', '搜索标题、说明、路径、页面、outlet 或插件…', routeQuery, value => { routeQuery = value })
    content.append(search)
    const filteredRoutes = snapshot.navigation.routes.filter(route => matchesManagerSearch(routeQuery, routeSearchValues(route)))
    const filteredPages = snapshot.navigation.pages.filter(page => matchesManagerSearch(
      routeQuery,
      pageSearchValues(page, snapshot.navigation.routes.filter(route => (
        qualifiedNavigationId(route.owner, route.definition.page) === page.qualifiedId
      ))),
    ))
    if (filteredRoutes.length === 0 && filteredPages.length === 0) {
      content.append(create(document, 'div', 'cxm-empty', '没有匹配的路由或页面'))
      return
    }
    if (filteredRoutes.length > 0) {
      const { section, list } = createRoutePageSection(
        'catalog-routes',
        '路由',
        '用户入口与 Host outlet 之间的结构化导航关系。',
        '路由列表',
      )
      for (const route of filteredRoutes) {
        list.append(createRouteProductRow(snapshot, route, () => {
          rememberListScroll()
          void navigateRoute({ kind: 'route', qualifiedId: route.qualifiedId })
        }))
      }
      content.append(section)
    }
    if (filteredPages.length > 0) {
      const { section, list } = createRoutePageSection(
        'catalog-pages',
        '页面',
        'Host 可挂载的结构化页面与其目标 outlet、chrome 范围。',
        '页面列表',
      )
      for (const page of filteredPages) {
        const routes = snapshot.navigation.routes.filter(route => (
          qualifiedNavigationId(route.owner, route.definition.page) === page.qualifiedId
        ))
        list.append(createPageProductRow(snapshot, page, routes))
      }
      content.append(section)
    }
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

  const renderPluginList = (snapshot: ManagerSnapshot): void => {
    setHeading('插件', snapshot, { icon: 'plugins' })
    const toolbar = create(document, 'div', 'cxm-toolbar')
    const search = createListSearch('plugins', '搜索 CordisX 插件', '搜索插件、扩展点或 contribution id…', pluginQuery, value => { pluginQuery = value })
    const install = create(document, 'button', 'cxm-action')
    install.type = 'button'
    install.dataset.installLocalPlugin = 'true'
    install.dataset.importLocalPlugin = 'true'
    install.append(
      createManagerIcon(document, 'import-plugin', 'cxm-action-icon'),
      create(document, 'span', undefined, lifecycleInstallBusy ? '检查本地包中…' : '导入'),
    )
    install.disabled = lifecycleInstallBusy
      || lifecycleBusy.size > 0
      || snapshot.pluginLifecycle?.operationsAvailable !== true
      || model.requestPluginLifecycle === undefined
    install.addEventListener('click', () => { void runLocalPackageInstall() })

    const favorites = favoritePlugins(snapshot)
    const filtered = snapshot.plugins.filter((plugin) => {
      const registrations = snapshot.registrations.filter(item => item.owner === plugin.id)
      return matchesManagerSearch(pluginQuery, [
        plugin.id,
        plugin.name,
        plugin.description ?? '',
        ...plugin.inject,
        ...registrations.flatMap(item => [item.surface, item.id]),
      ])
    }).sort((left, right) => Number(favorites.has(right.id)) - Number(favorites.has(left.id)))
    toolbar.append(search, install)
    content.append(toolbar)
    if (operationError !== undefined) content.append(create(document, 'div', 'cxm-error', operationError))

    const list = create(document, 'div', 'cxm-plugin-list')
    list.setAttribute('role', 'list')
    list.setAttribute('aria-label', '当前 bundle 插件')
    if (filtered.length === 0) list.append(create(document, 'div', 'cxm-empty', '没有匹配的插件'))
    for (const plugin of filtered) {
      const row = create(document, 'div', 'cxm-plugin-row')
      row.setAttribute('role', 'listitem')
      row.dataset.pluginCard = plugin.id
      const primary = create(document, 'button', 'cxm-plugin-primary')
      primary.type = 'button'
      primary.dataset.pluginId = plugin.id
      primary.dataset.pluginPrimary = plugin.id
      primary.setAttribute('aria-label', `打开 ${plugin.name} 详情`)
      const status = lifecycleBusy.get(plugin.id) ?? plugin.status
      primary.setAttribute('aria-description', pluginStatusDescription(plugin, status))
      primary.append(createPluginIcon(document, plugin.name, status))
      const body = create(document, 'span', 'cxm-plugin-body')
      body.append(create(document, 'span', 'cxm-plugin-name', plugin.name))
      body.append(create(document, 'span', 'cxm-plugin-description', plugin.description ?? '本地 CordisX 插件'))
      const meta = create(document, 'span', 'cxm-plugin-meta')
      meta.append(create(document, 'code', 'cxm-plugin-meta-source', plugin.id))
      body.append(meta)
      primary.append(body)
      tooltips.attach(primary, () => pluginStatusDescription(plugin, status), 'top')
      activateManagerListRow(primary, () => {
        rememberListScroll()
        operationError = undefined
        void navigateRoute({ kind: 'plugin', pluginId: plugin.id, facet: 'readme' })
      })
      const actions = create(document, 'div', 'cxm-plugin-actions')
      actions.setAttribute('role', 'group')
      actions.setAttribute('aria-label', `${plugin.name}的快速操作`)
      actions.dataset.cordisxNoDrag = 'true'
      actions.addEventListener('click', event => event.stopPropagation())
      actions.addEventListener('keydown', event => event.stopPropagation())
      const packageOperationReason = packageOperationUnavailableReason(snapshot, plugin)
      const managed = packageOperationReason === undefined
      const globallyBusy = lifecycleInstallBusy || lifecycleBusy.size > 0
      const attachActionTooltip = (button: HTMLElement, label: string): void => {
        tooltips.attach(button, () => label, 'top')
      }
      const iconAction = (
        action: string,
        icon: ManagerIconToken,
        label: string,
        priority: 1 | 2 | 3,
        disabled: boolean,
        invoke: () => void,
      ): HTMLButtonElement => {
        const button = create(document, 'button', 'cxm-plugin-icon-action')
        button.type = 'button'
        button.dataset.pluginAction = action
        button.dataset.actionPriority = String(priority)
        button.dataset.cordisxNoDrag = 'true'
        button.setAttribute('aria-label', label)
        button.disabled = disabled
        button.append(createManagerIcon(document, icon))
        button.addEventListener('click', event => {
          event.stopPropagation()
          invoke()
        })
        attachActionTooltip(button, label)
        return button
      }
      const enable = plugin.status === 'configured-disabled'
      const toggleLabel = enable ? '启用插件' : '禁用插件'
      const toggleDisabled = !managed || globallyBusy || (plugin.status !== 'active' && !enable)
      actions.append(iconAction(
        enable ? 'enable' : 'disable',
        enable ? 'enable-plugin' : 'disable-plugin',
        managed ? toggleLabel : '启动配置插件需由 launcher 配置管理',
        1,
        toggleDisabled,
        () => { void runPluginLifecycle(snapshot, plugin, enable ? 'enable' : 'disable') },
      ))
      actions.append(iconAction(
        'reload', 'reload-plugin', managed ? '重载插件' : '该插件不属于动态 package generation', 3,
        !managed || globallyBusy || plugin.status !== 'active',
        () => { void runPluginLifecycle(snapshot, plugin, 'reload') },
      ))
      const favorite = favorites.has(plugin.id)
      const favoriteAction = iconAction(
        'favorite', favorite ? 'favorite-active' : 'favorite', favorite ? '取消收藏' : '收藏插件', 2, false,
        () => {
          setFavorite(snapshot, plugin.id, !favorite)
          renderContent()
        },
      )
      favoriteAction.setAttribute('aria-pressed', String(favorite))
      actions.append(favoriteAction)

      const menu = create(document, 'div', 'cxm-plugin-menu')
      menu.dataset.pluginMenu = plugin.id
      const menuTrigger = create(document, 'button', 'cxm-plugin-menu-trigger')
      menuTrigger.type = 'button'
      menuTrigger.dataset.cordisxNoDrag = 'true'
      menuTrigger.setAttribute('aria-label', `更多 ${plugin.name} 操作`)
      menuTrigger.setAttribute('aria-haspopup', 'menu')
      menuTrigger.setAttribute('aria-expanded', 'false')
      menuTrigger.setAttribute('aria-controls', `cordisx-plugin-menu-${plugin.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`)
      menuTrigger.append(createManagerIcon(document, 'more'))
      attachActionTooltip(menuTrigger, '更多操作')
      const popup = create(document, 'div', 'cxm-plugin-menu-popup')
      popup.id = menuTrigger.getAttribute('aria-controls')!
      popup.setAttribute('role', 'menu')
      popup.setAttribute('aria-label', `${plugin.name} 的更多操作`)
      popup.hidden = true
      let unmountPopup = (): void => {}
      const closeMenu = (restoreFocus = false): void => {
        pluginActionMenuOpen = false
        pluginActionMenuContainsEvent = () => false
        repositionPluginActionMenu = () => {}
        popup.hidden = true
        delete row.dataset.actionMenuOpen
        unmountPopup()
        menuTrigger.setAttribute('aria-expanded', 'false')
        if (closePluginActionMenu === closeMenu) closePluginActionMenu = () => {}
        if (restoreFocus) queueMicrotask(() => {
          pendingPluginMenuFocus = plugin.id
          if (menuTrigger.isConnected) menuTrigger.focus()
        })
      }
      const visibleEnabledMenuItems = (): HTMLButtonElement[] => [...popup.querySelectorAll<HTMLButtonElement>('.cxm-plugin-menu-item')]
        .filter(item => !item.disabled && item.hidden === false && item.style.display !== 'none')
      const positionMenu = (): void => {
        if (!popup.isConnected || !menuTrigger.isConnected || !row.isConnected) {
          closeMenu(false)
          return
        }
        const cardWidth = row.getBoundingClientRect().width
        for (const item of popup.querySelectorAll<HTMLElement>('.cxm-plugin-menu-responsive')) {
          const priority = Number(item.dataset.actionPriority)
          item.style.display = (priority === 3 && cardWidth <= 470) || (priority === 2 && cardWidth <= 390)
            ? 'flex'
            : 'none'
        }
        const triggerRect = menuTrigger.getBoundingClientRect()
        const popupRect = popup.getBoundingClientRect()
        const viewportWidth = document.defaultView?.innerWidth ?? document.documentElement.clientWidth
        const viewportHeight = document.defaultView?.innerHeight ?? document.documentElement.clientHeight
        const edge = 8
        const left = Math.min(
          Math.max(edge, triggerRect.right - popupRect.width),
          Math.max(edge, viewportWidth - popupRect.width - edge),
        )
        const below = triggerRect.bottom + 6
        const top = below + popupRect.height <= viewportHeight - edge
          ? below
          : Math.max(edge, triggerRect.top - popupRect.height - 6)
        popup.style.left = `${Math.round(left)}px`
        popup.style.top = `${Math.round(top)}px`
      }
      const openMenu = (): void => {
        closePluginActionMenu(false)
        tooltips.hide()
        popup.hidden = false
        row.dataset.actionMenuOpen = 'true'
        unmountPopup = mountPortal(popup)
        positionMenu()
        menuTrigger.setAttribute('aria-expanded', 'true')
        closePluginActionMenu = closeMenu
        pluginActionMenuOpen = true
        pluginActionMenuContainsEvent = event => {
          const path = event.composedPath()
          if (path.some(item => item === popup || item === menuTrigger)) return true
          const Node = document.defaultView?.Node
          const target = event.target
          return Node !== undefined && target instanceof Node && (popup.contains(target) || menuTrigger.contains(target))
        }
        repositionPluginActionMenu = positionMenu
        visibleEnabledMenuItems()[0]?.focus()
      }
      menuTrigger.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()
        if (menuTrigger.getAttribute('aria-expanded') === 'true') closeMenu(true)
        else openMenu()
      })
      const menuItem = (
        action: string,
        icon: ManagerIconToken,
        label: string,
        disabled: boolean,
        invoke: () => void,
        options: { readonly danger?: boolean; readonly priority?: 2 | 3; readonly disabledReason?: string } = {},
      ): HTMLButtonElement => {
        const button = create(document, 'button', 'cxm-plugin-menu-item')
        button.type = 'button'
        button.dataset.pluginMenuAction = action
        button.dataset.cordisxNoDrag = 'true'
        button.setAttribute('role', 'menuitem')
        button.disabled = disabled
        if (disabled) {
          const disabledReason = options.disabledReason ?? '当前操作不可用'
          button.setAttribute('aria-disabled', 'true')
          button.setAttribute('aria-description', disabledReason)
          button.title = disabledReason
        }
        if (options.danger === true) button.dataset.tone = 'danger'
        if (options.priority !== undefined) {
          button.classList.add('cxm-plugin-menu-responsive')
          button.dataset.actionPriority = String(options.priority)
        }
        button.append(createManagerIcon(document, icon), create(document, 'span', undefined, label))
        button.addEventListener('click', event => {
          event.preventDefault()
          event.stopPropagation()
          if (button.disabled) return
          closeMenu(true)
          invoke()
        })
        return button
      }
      popup.addEventListener('keydown', event => {
        const items = visibleEnabledMenuItems()
        const target = event.target instanceof document.defaultView!.HTMLButtonElement
          ? event.target
          : undefined
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          closeMenu(true)
          return
        }
        if (items.length === 0) return
        const current = target === undefined ? -1 : items.indexOf(target)
        let next: HTMLButtonElement | undefined
        if (event.key === 'ArrowDown') next = items[(current + 1 + items.length) % items.length]
        if (event.key === 'ArrowUp') next = items[(current - 1 + items.length) % items.length]
        if (event.key === 'Home') next = items[0]
        if (event.key === 'End') next = items.at(-1)
        if (next !== undefined) {
          event.preventDefault()
          event.stopPropagation()
          next.focus()
          return
        }
        if ((event.key === 'Enter' || event.key === ' ') && target !== undefined && !target.disabled) {
          event.preventDefault()
          event.stopPropagation()
          target.click()
        }
      })
      const sourceReason = sourceUnavailableReason(plugin)
      const disabledReasonOption = (reason: string | undefined): { readonly disabledReason?: string } => (
        reason === undefined ? {} : { disabledReason: reason }
      )
      popup.append(
        menuItem('reload', 'reload-plugin', '重载', !managed || globallyBusy || plugin.status !== 'active', () => {
          void runPluginLifecycle(snapshot, plugin, 'reload', true)
        }, {
          priority: 3,
          ...disabledReasonOption(packageOperationReason ?? (globallyBusy ? '当前有插件操作正在执行' : '插件当前不能重载')),
        }),
        menuItem('favorite', favorite ? 'favorite-active' : 'favorite', favorite ? '取消收藏' : '收藏', false, () => {
          pendingPluginMenuFocus = plugin.id
          setFavorite(snapshot, plugin.id, !favorite)
          renderContent()
        }, { priority: 2 }),
        menuItem(
          'share', 'share-plugin', sourceReason === undefined ? '分享公开来源' : '分享公开来源（不可用）',
          sourceReason !== undefined,
          () => { void sharePlugin(plugin).catch(error => {
            operationError = error instanceof Error ? error.message : String(error)
            pendingPluginMenuFocus = plugin.id
            renderContent()
          }) },
          disabledReasonOption(sourceReason),
        ),
        menuItem(
          'source', 'authors-source', sourceReason === undefined ? '打开公开来源' : '打开公开来源（不可用）',
          sourceReason !== undefined,
          () => { openPluginSource(plugin) },
          disabledReasonOption(sourceReason),
        ),
        menuItem(
          'diagnostics', 'diagnostics', '查看运行诊断', false,
          () => {
            rememberListScroll()
            void navigateRoute({ kind: 'plugin', pluginId: plugin.id, facet: 'runtime' })
          },
        ),
        menuItem(
          'uninstall', 'uninstall-plugin', managed ? '卸载' : '卸载（不可用）', !managed || globallyBusy,
          () => { void runPluginLifecycle(snapshot, plugin, 'uninstall', true) }, {
            danger: true,
            ...disabledReasonOption(packageOperationReason ?? (globallyBusy ? '当前有插件操作正在执行' : undefined)),
          },
        ),
      )
      menu.append(menuTrigger)
      actions.append(menu)
      row.append(primary, actions)
      list.append(row)
    }
    content.append(list)
    if (pendingPluginMenuFocus !== undefined) {
      const pluginId = pendingPluginMenuFocus
      pendingPluginMenuFocus = undefined
      const menu = [...content.querySelectorAll<HTMLElement>('[data-plugin-menu]')]
        .find(item => item.dataset.pluginMenu === pluginId)
      const target = menu?.querySelector<HTMLButtonElement>('.cxm-plugin-menu-trigger') ?? install
      target.focus()
    }

  }

  const commitPermissionPolicy = async (
    pluginId: string,
    permission: ManagerPermissionSnapshot,
    policy: CordisXPermissionPolicy,
    control: HTMLSelectElement,
  ): Promise<void> => {
    operationError = undefined
    control.disabled = true
    try {
      await model.setPermissionPolicy(pluginId, permission.capability, policy)
    } catch (error) {
      operationError = error instanceof Error ? error.message : String(error)
    } finally {
      renderContent()
    }
  }

  const renderPermissionDetail = (
    snapshot: ManagerSnapshot,
    pluginId: string,
    capability: CordisXPlatformCapability,
  ): void => {
    const plugin = snapshot.plugins.find(item => item.id === pluginId)
    const permission = snapshot.permissions.find(item => (
      item.identity.id === pluginId
      && item.identity.source === plugin?.source
      && item.capability === capability
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

    const fields = create(document, 'div', 'cxm-detail-grid')
    for (const [label, value] of [
      ['申请类型', permission.required ? '必需权限' : '可选权限'],
      ['可用状态', capabilityAvailabilityLabel(permission.availability.status)],
      ['能力标识', permission.capability],
    ]) {
      const field = create(document, 'div', 'cxm-field')
      field.append(create(document, 'div', 'cxm-field-label', label), create(document, 'div', 'cxm-field-value', value))
      fields.append(field)
    }
    detail.append(fields)

    const policyRow = create(document, 'div', 'cxm-permission-detail-policy')
    policyRow.append(
      create(document, 'label', 'cxm-field-label', '权限策略'),
      createPermissionPolicySelect(document, permission, async (policy, control) => {
        await commitPermissionPolicy(plugin.id, permission, policy, control)
      }),
    )
    detail.append(policyRow)
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

  const renderPluginConfiguration = (plugin: ManagerPluginSnapshot, panel: HTMLElement): void => {
    const descriptor = plugin.configuration
    if (descriptor === undefined || descriptor.schemaKind !== 'schemastery') {
      panel.append(forms.empty('此插件未提供可编辑设置。'))
      return
    }
    const sensitiveRoles = ['secret', 'credential', 'credential-ref', 'permission', 'capability']
    const visibleFields = descriptor.fields.filter(field => !field.disabled || sensitiveRoles.includes(field.role ?? ''))
    const editableFields = visibleFields.filter(field => !field.disabled
      && !sensitiveRoles.includes(field.role ?? '') && selectHostFormPrimitive(field) !== 'unsupported')
    if (visibleFields.length === 0) {
      panel.append(forms.empty('此插件没有可编辑设置。'))
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
    const grid = forms.grid()
    form.append(grid)
    let submit: HTMLButtonElement | undefined
    for (const [index, field] of visibleFields.entries()) {
      const pathKey = JSON.stringify(field.path)
      const controlId = `cxm-config-${plugin.id}-${index}`
      const sensitive = field.role !== undefined && sensitiveRoles.includes(field.role)
      const primitive = selectHostFormPrimitive(field)
      const item = forms.item({
        id: controlId,
        label: fieldLabel(field),
        ...(field.description === undefined ? {} : { help: field.description }),
        required: field.required,
        fullWidth: sensitive || ['textarea', 'json-textarea', 'path-input', 'unsupported'].includes(primitive),
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
        const validationIssue = issue ?? validateHostFormValue(field, value)
        if (validationIssue === undefined) draft!.issues.delete(pathKey)
        else draft!.issues.set(pathKey, validationIssue)
        item.setError(validationIssue)
        draft!.state = 'dirty'
        delete draft!.message
        form.dataset.state = 'dirty'
        const status = form.querySelector<HTMLElement>('.cxf-status')
        if (status !== null) {
          status.dataset.state = 'dirty'
          status.textContent = '有未保存更改'
        }
        if (submit !== undefined) submit.disabled = !descriptor.writable || busyPluginId !== undefined
          || draft!.operations.size === 0 || draft!.issues.size > 0
      }
      const renderedField = draft.values.has(pathKey) ? { ...field, value: draft.values.get(pathKey) } : field
      const defaultHolder = create(document, 'div')
      const control = forms.control(renderedField, controlId, setDraft)
      forms.connect(item, control)
      defaultHolder.append(control.root)
      item.control.append(defaultHolder)
      item.setError(draft.issues.get(pathKey))
      if (model.mountConfigRenderer !== undefined && !field.disabled) {
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
      const reset = forms.button('恢复默认值')
      reset.disabled = !descriptor.writable || busyPluginId !== undefined
      reset.setAttribute('aria-label', `恢复${fieldLabel(field)}默认值`)
      reset.addEventListener('click', () => {
        draft!.values.delete(pathKey)
        draft!.issues.delete(pathKey)
        draft!.operations.set(pathKey, { op: 'unset', path: field.path })
        draft!.state = 'dirty'
        delete draft!.message
        renderContent()
      })
      const fieldActions = create(document, 'div', 'cxf-actions')
      fieldActions.append(reset)
      item.control.append(fieldActions)
      grid.append(item.root)
    }
    if (editableFields.length > 0) {
      const actions = create(document, 'div', 'cxf-actions')
      const status = create(document, 'span', 'cxf-status')
      status.dataset.state = draft.state
      status.setAttribute('role', 'status')
      status.textContent = draft.state === 'saving' ? '正在保存…'
        : draft.state === 'saved' ? '已保存'
          : draft.operations.size > 0 ? '有未保存更改' : '没有未保存更改'
      const resetDraft = forms.button('撤销更改')
      resetDraft.disabled = draft.operations.size === 0 || busyPluginId !== undefined
      resetDraft.addEventListener('click', () => {
        draft!.values.clear()
        draft!.operations.clear()
        draft!.issues.clear()
        draft!.state = 'pristine'
        delete draft!.message
        renderContent()
      })
      submit = forms.button(busyPluginId === plugin.id ? '保存中…' : '保存配置', { type: 'submit', variant: 'primary' })
      submit.disabled = !descriptor.writable || busyPluginId !== undefined || draft.operations.size === 0 || draft.issues.size > 0
      actions.append(status, resetDraft, submit)
      form.append(actions)
      form.addEventListener('submit', async (event) => {
        event.preventDefault()
        if (model.updatePluginConfig === undefined || draft!.operations.size === 0 || draft!.issues.size > 0) return
        busyPluginId = plugin.id
        draft!.state = 'saving'
        delete draft!.message
        submit!.disabled = true
        submit!.textContent = '保存中…'
        status.dataset.state = 'saving'
        status.textContent = '正在保存…'
        form.setAttribute('aria-busy', 'true')
        try {
          await model.updatePluginConfig(plugin.id, draft!.baseRevision, [...draft!.operations.values()])
          draft!.values.clear()
          draft!.operations.clear()
          draft!.issues.clear()
          draft!.state = 'saved'
          draft!.message = '配置已保存'
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          draft!.state = /conflict|revision/iu.test(message) ? 'conflict' : 'error'
          draft!.message = draft!.state === 'conflict'
            ? '配置已在其他窗口或进程中更新。你的草稿仍保留；刷新后请重新核对再保存。'
            : message
        } finally {
          busyPluginId = undefined
          renderContent()
        }
      })
    }
    panel.append(form)
    if (!descriptor.writable) panel.append(forms.alert('当前 launcher 模式没有可用的配置写入服务；设置保持只读。', 'warning'))
    if (draft.message !== undefined) panel.append(forms.alert(draft.message, draft.state === 'saved' ? 'info' : 'error'))
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
    const syncContentHeight = (): void => {
      const space = container.querySelector<HTMLElement>('.luna-console-logs-space')
      const measured = Number.parseFloat(space?.style.height ?? '') || space?.scrollHeight || container.scrollHeight
      const viewportLimit = Math.min(520, Math.max(80, (document.defaultView?.innerHeight ?? 800) * .52))
      container.style.setProperty('--cxm-console-content-height', `${Math.max(28, Math.min(viewportLimit, measured + 2))}px`)
    }
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
      const ResizeObserverConstructor = document.defaultView?.ResizeObserver
      if (ResizeObserverConstructor !== undefined) {
        resizeObserver = new ResizeObserverConstructor(() => {
          syncContentHeight()
          if (state.follow) scrollToLatest()
          else syncLatest()
        })
        const space = container.querySelector<HTMLElement>('.luna-console-logs-space')
        if (space !== null) resizeObserver.observe(space)
      }
      queueMicrotask(() => { syncContentHeight(); restoreScroll() })
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

  const renderPluginDetail = (snapshot: ManagerSnapshot, id: string): void => {
    const plugin = snapshot.plugins.find(item => item.id === id)
    setHeading('插件详情', snapshot)
    if (plugin === undefined) {
      content.append(create(document, 'div', 'cxm-empty', '插件已不在当前 bundle 中'))
      return
    }
    const activeFacet = routeState.kind === 'plugin' ? routeState.facet : 'readme'
    content.append(createLocalTabs(document, PLUGIN_DETAIL_TABS, activeFacet, 'data-plugin-detail-tab', (tab) => {
      void navigateRoute({ kind: 'plugin', pluginId: id, facet: tab as PluginDetailTab })
    }))

    if (activeFacet === 'readme') {
      const panel = createTabPanel(document, 'README')
      if (plugin.readme?.trim() === '') {
        panel.append(create(document, 'div', 'cxm-empty', '该插件没有随当前 bundle 提供 README.md'))
      } else if (plugin.readme === undefined) {
        panel.append(create(document, 'div', 'cxm-empty', '该插件没有随当前 bundle 提供 README.md'))
      } else {
        panel.append(renderSafeMarkdown(document, plugin.readme))
      }
      content.append(panel)
      return
    }

    if (activeFacet === 'config') {
      const panel = createTabPanel(document, '配置管理')
      renderPluginConfiguration(plugin, panel)
      content.append(panel)
      return
    }

    if (activeFacet === 'permissions') {
      const panel = createTabPanel(document, '权限')
      const permissions = snapshot.permissions.filter(item => item.identity.source === plugin.source && item.identity.id === plugin.id)
      if (permissions.length === 0) {
        panel.append(create(document, 'div', 'cxm-empty', '该插件没有申请任何权限。'))
      }
      const permissionList = create(document, 'div', 'cxm-flat-list')
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
          void navigateRoute({ kind: 'permission', pluginId: plugin.id, capability: permission.capability })
        })
        const control = create(document, 'div', 'cxm-permission-control')
        const availability = create(
          document,
          'span',
          'cxm-kind-badge cxm-permission-availability',
          capabilityAvailabilityLabel(permission.availability.status),
        )
        availability.dataset.permissionAvailability = permission.capability
        availability.dataset.availabilityState = permission.availability.status
        control.append(
          availability,
          createPermissionPolicySelect(document, permission, async (policy, select) => {
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
    if (activeFacet === 'runtime') {
      const panel = createTabPanel(document, '运行状态')
      const livePage = model.pluginConsole?.(plugin.id) ?? {
        contract: 'cordisx.plugin-console-page/v1', schemaVersion: 1,
        plugin: { source: plugin.source, pluginId: plugin.id }, generation: 'manager-unavailable',
        generatedAt: Date.now(), partialObservability: true, entries: [],
      }
      if (consolePaused && (consolePausedPage === undefined || consolePausedPage.plugin.pluginId !== plugin.id)) consolePausedPage = livePage
      const page = consolePaused ? consolePausedPage ?? livePage : livePage
      const requested = page.entries.filter(entry => entry.kind === 'invocation' && entry.phase === 'requested')
      const successes = page.entries.filter(entry => entry.kind === 'invocation' && entry.phase === 'success')
      const failures = page.entries.filter(entry => entry.kind === 'invocation' && entry.phase === 'failure')
      const denials = page.entries.filter(entry => entry.kind === 'permission' && entry.phase === 'deny')
      const durations = page.entries.filter(entry => entry.kind === 'invocation' && entry.durationMs !== undefined).map(entry => entry.durationMs!)
      const summary = create(document, 'div', 'cxm-console-summary')
      for (const [label, value] of [
        ['调用', requested.length], ['成功', successes.length], ['失败', failures.length], ['拒绝', denials.length],
      ]) {
        const metric = create(document, 'div', 'cxm-console-metric')
        metric.append(create(document, 'strong', undefined, String(value)), create(document, 'span', undefined, String(label)))
        summary.append(metric)
      }
      const callSources = new Map<string, { calls: number; items: number; bytes: number }>()
      for (const entry of page.entries) {
        if (entry.kind === 'invocation' && entry.phase === 'requested') {
          const current = callSources.get(entry.source) ?? { calls: 0, items: 0, bytes: 0 }
          current.calls += 1
          callSources.set(entry.source, current)
        }
        if (entry.kind === 'invocation' && ['success', 'failure', 'cancel'].includes(entry.phase ?? '')) {
          const current = callSources.get(entry.source) ?? { calls: 0, items: 0, bytes: 0 }
          current.items += entry.result?.itemCount ?? 0
          current.bytes += entry.result?.byteCount ?? 0
          callSources.set(entry.source, current)
        }
      }
      const performance = create(document, 'details', 'cxm-console-performance')
      performance.append(create(document, 'summary', undefined, `性能与消费 · 平均耗时 ${durations.length === 0 ? '—' : `${(durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(1)}ms`}`))
      performance.append(create(document, 'div', 'cxm-console-performance-body', callSources.size === 0
        ? '当前没有 Host API 调用计量。'
        : [...callSources].map(([source, value]) => `${source}: ${value.calls} calls${value.items === 0 ? '' : ` · ${value.items} items`}${value.bytes === 0 ? '' : ` · ${value.bytes} B`}`).join('   ')))
      summary.append(performance)
      panel.append(summary)

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
      search.placeholder = '搜索消息、来源或 correlation id'
      search.value = consoleQuery
      search.dataset.consoleSearch = plugin.id
      search.addEventListener('input', () => { consoleQuery = search.value; renderContent() })
      const select = (label: string, value: string, values: readonly string[], change: (value: string) => void): HTMLSelectElement => {
        const element = create(document, 'select')
        element.setAttribute('aria-label', label)
        for (const item of values) {
          const option = create(document, 'option', undefined, item === 'all' ? '全部' : item)
          option.value = item
          option.selected = item === value
          element.append(option)
        }
        element.addEventListener('change', () => { change(element.value); renderContent() })
        return element
      }
      controls.append(
        search,
        select('日志级别', consoleMethod, ['all', 'debug', 'log', 'info', 'warn', 'error'], value => { consoleMethod = value }),
        select('API / 类型', consoleKind, ['all', 'host-api', 'console', 'lifecycle', 'diagnostic'], value => { consoleKind = value }),
        select('日志来源', consoleSource, ['all', ...sources], value => { consoleSource = value }),
      )
      const scrollState = consoleScrollStates.get(plugin.id) ?? { follow: true, scrollTop: 0 }
      consoleScrollStates.set(plugin.id, scrollState)
      const actionToolbar = create(document, 'div', 'cxm-console-action-toolbar')
      actionToolbar.setAttribute('role', 'toolbar')
      actionToolbar.setAttribute('aria-label', 'Console 显示控制')
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
      const pauseLabel = consolePaused ? '继续采集' : '暂停采集'
      const pause = iconAction('pause', consolePaused ? 'console-resume' : 'console-pause', pauseLabel, { pressed: consolePaused }, () => {
        consolePaused = !consolePaused
        consolePausedPage = consolePaused ? model.pluginConsole?.(plugin.id) ?? livePage : undefined
        renderContent()
      })
      const followLabel = scrollState.follow ? '停止跟随' : '跟随最新'
      const autoScroll = iconAction('follow', 'console-follow', followLabel, { pressed: scrollState.follow }, () => {
        scrollState.follow = !scrollState.follow
        renderContent()
      })
      const clear = iconAction('clear', 'console-clear', '清空日志', {
        disabled: page.entries.length === 0,
        description: '不可撤销',
      }, () => {
        model.clearPluginConsole?.(plugin.id)
        selectedConsoleEntry = undefined
        consolePausedPage = undefined
        renderContent()
      })
      const selected = page.entries.find(entry => entry.entryId === selectedConsoleEntry)
      const copy = iconAction('copy', 'console-copy', '复制所选', { disabled: selected === undefined }, () => {
        if (selected !== undefined) void copyConsoleText(pluginConsoleEntryCopyText(selected)).catch(() => undefined)
      })
      actionToolbar.append(pause, autoScroll, clear, copy)
      controls.append(actionToolbar)
      panel.append(controls)
      const unattributed = page.unattributedEntries ?? 0
      if (unattributed > 0 && dismissedConsoleWarnings.get(plugin.id) !== unattributed) {
        const unknown = create(document, 'div', 'cxm-notice cxm-console-warning')
        unknown.dataset.tone = 'warning'
        unknown.append(create(document, 'span', undefined, `检测到 ${unattributed} 条来源冲突的运行时错误，未计入当前插件日志。请重载插件后复现并检查 bundle source map。`))
        const dismissWarning = create(document, 'button', undefined, '关闭')
        dismissWarning.type = 'button'
        dismissWarning.setAttribute('aria-label', '关闭归属异常提示')
        dismissWarning.addEventListener('click', () => { dismissedConsoleWarnings.set(plugin.id, unattributed); renderContent() })
        unknown.append(dismissWarning)
        panel.append(unknown)
      }

      const workspace = create(document, 'div', 'cxm-console-workspace')
      const body = create(document, 'div', 'cxm-console-body')
      const frame = create(document, 'div', 'cxm-console-frame')
      frame.dataset.pluginConsole = plugin.id
      if (projections.length === 0) {
        frame.append(create(document, 'div', 'cxm-console-empty', page.entries.length === 0 ? '等待插件日志或 CordisX API 调用…' : '没有匹配当前筛选的日志'))
      } else {
        frame.classList.add('cxm-console-luna')
      }
      const latest = create(document, 'button', 'cxm-console-latest', '回到最新')
      latest.type = 'button'
      latest.hidden = true
      body.append(frame, latest)
      if (selected !== undefined) {
        workspace.dataset.inspector = 'true'
        const inspector = create(document, 'aside', 'cxm-console-inspector')
        inspector.dataset.consoleDetail = selected.entryId
        const inspectorHead = create(document, 'div', 'cxm-console-inspector-head')
        inspectorHead.append(create(document, 'span', undefined, 'Host metadata'))
        const closeInspector = create(document, 'button', undefined, '关闭')
        closeInspector.type = 'button'
        closeInspector.addEventListener('click', () => { selectedConsoleEntry = undefined; renderContent() })
        inspectorHead.append(closeInspector)
        const grid = create(document, 'dl', 'cxm-console-inspector-grid')
        const metadata: readonly (readonly [string, string | number | undefined])[] = [
          ['插件', `${selected.plugin.pluginId} · ${selected.plugin.source}`],
          ['Generation', selected.generation],
          ['能力 / 来源', selected.source],
          ['类型', selected.kind],
          ['采集', selected.coverage],
          ['Correlation', selected.correlationId],
          ['阶段', selected.phase],
          ['状态', selected.status],
          ['耗时', selected.durationMs === undefined ? undefined : `${selected.durationMs.toFixed(1)}ms`],
          ['会话', selected.sessionId],
          ['触发', selected.trigger === undefined ? undefined : `${selected.trigger.kind}${selected.trigger.registrationId === undefined ? '' : ` · ${selected.trigger.registrationId}`}`],
          ['有效 owner', selected.effectiveOwner === undefined ? undefined : `${selected.effectiveOwner.pluginId} · ${selected.effectiveOwner.source}`],
          ['请求计量', selected.request === undefined ? undefined : JSON.stringify(selected.request)],
          ['结果计量', selected.result === undefined ? undefined : JSON.stringify(selected.result)],
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
      const lifecycle = create(document, 'details', 'cxm-diagnostics')
      lifecycle.append(create(document, 'summary', undefined, `生命周期 / 诊断 · ${statusLabel(plugin.status)}`))
      const lifecycleBody = create(document, 'div', 'cxm-diagnostics-body')
      lifecycleBody.append(create(document, 'div', 'cxm-copy', `注入服务：${plugin.inject.join(', ') || '无'} · 活跃贡献：${pluginRegistrations.filter(item => item.visible && item.valid).length} · Commands：${pluginCommands.length}`))
      const action = create(document, 'button', 'cxm-action cxm-plugin-runtime-action')
      action.type = 'button'
      const blocked = plugin.status === 'blocked' || plugin.status === 'failed'
      const permissionBlocked = plugin.status === 'permission-blocked'
      const restorable = blocked || permissionBlocked
      action.textContent = busyPluginId === plugin.id ? '处理中…' : plugin.status === 'configured-disabled' ? '配置中已禁用' : permissionBlocked ? '重新授权' : blocked ? '恢复插件' : '屏蔽插件'
      action.disabled = busyPluginId !== undefined || plugin.status === 'configured-disabled'
      action.addEventListener('click', async () => {
        busyPluginId = plugin.id
        renderContent()
        try { if (restorable) await authorizeAndRestore(plugin); else await model.setPluginBlocked(plugin.id, true) }
        catch (error) { operationError = error instanceof Error ? error.message : String(error) }
        finally { busyPluginId = undefined; renderContent() }
      })
      lifecycleBody.append(action)
      if (plugin.error !== undefined) lifecycleBody.append(create(document, 'div', 'cxm-error', plugin.error))
      if (plugin.blockedReason !== undefined) lifecycleBody.append(create(document, 'div', 'cxm-error', plugin.blockedReason))
      if (operationError !== undefined) lifecycleBody.append(create(document, 'div', 'cxm-error', operationError))
      lifecycleBody.append(create(document, 'code', 'cxm-detail-id', plugin.id))
      const localeCatalogs = snapshot.localeCatalogs.filter(item => item.owner === plugin.id)
      const localizationDiagnostics = create(document, 'div', 'cxm-copy', localeCatalogs.length === 0
        ? '当前插件没有活跃 locale dictionary'
        : localeCatalogs.map(item => `${item.namespace} · ${item.locale} · ${item.messageCount} keys`).join('\n'))
      const runtimeDiagnostics = create(document, 'div', 'cxm-copy', pluginCommands.length === 0
        ? '当前插件没有 command 注册'
        : pluginCommands.map(command => `${command.qualifiedId} · running ${command.running}`).join('\n'))
      const adapter = snapshot.platform
      const diagnostics = create(document, 'details', 'cxm-diagnostics')
      diagnostics.dataset.runtimeDiagnostics = 'platform'
      diagnostics.append(create(document, 'summary', undefined, '诊断'))
      const diagnosticsBody = create(document, 'div', 'cxm-diagnostics-body')
      diagnosticsBody.append(createSectionTitle(document, '本地化'), localizationDiagnostics)
      diagnosticsBody.append(createSectionTitle(document, '运行时详情'), runtimeDiagnostics)
      if (plugin.configuration !== undefined) {
        const configSchema = plugin.configuration.schemaKind === 'schemastery'
          ? 'Schemastery'
          : plugin.configuration.schemaKind === 'standard' ? 'Standard Schema' : '未声明'
        const configApplies = plugin.configuration.applies === 'live' ? 'live' : 'restart'
        const configDiagnostics = create(document, 'div', 'cxm-copy', `配置：${configSchema} · ${configApplies} · revision ${plugin.configuration.revision} · last-good ${plugin.configuration.lastGoodRevision} · writer ${plugin.configuration.writable ? 'available' : 'unavailable'}`)
        configDiagnostics.dataset.configDiagnostics = plugin.id
        diagnosticsBody.append(configDiagnostics)
      }
      for (const provider of (snapshot.capabilityProviders ?? []).filter(item => item.kind !== 'current-connection')) {
        const providerDiagnostic = create(
          document,
          'div',
          'cxm-copy',
          `${provider.providerNameText} · ${capabilityAvailabilityLabel(provider.status)} · ${provider.reasonText}`,
        )
        providerDiagnostic.dataset.capabilityProvider = provider.providerId
        diagnosticsBody.append(providerDiagnostic)
      }
      diagnosticsBody.append(create(
        document,
        'div',
        'cxm-copy',
        `宿主：${adapter.hostName} · adapter ${adapter.mode} · 二次连接 ${adapter.secondConnectionCreated ? '是' : '否'} · 原始 bridge 暴露 ${adapter.rawBridgeExposed ? '是' : '否'}`,
      ))
      for (const diagnostic of adapter.diagnostics) diagnosticsBody.append(create(document, 'div', 'cxm-error', `${diagnostic.code} · ${diagnostic.message}`))
      const securityBoundary = create(document, 'div', 'cxm-notice', '当前权限仅适用于 Host API 调用。')
      securityBoundary.dataset.tone = 'warning'
      diagnosticsBody.append(securityBoundary, documentationLink('查看权限说明', PRODUCT_DOCUMENTATION.permissions))
      diagnostics.append(diagnosticsBody)
      lifecycleBody.append(diagnostics)
      lifecycle.append(lifecycleBody)
      panel.append(lifecycle)
      content.append(panel)
      return
    }

    if (activeFacet === 'extension-points') {
      const panel = createTabPanel(document, '扩展点位')
      const points = (snapshot.extensionPoints?.points ?? []).filter(point => point.plugins.some(usage => (
        usage.identity.source === plugin.source && usage.identity.id === plugin.id
      )))
      const query = pluginExtensionPointQueries.get(plugin.id) ?? ''
      panel.append(createListSearch(
        `plugin-extension-points-${plugin.id}`,
        `搜索${plugin.name}的扩展点与贡献`,
        '搜索扩展点、介绍、贡献名称或 id…',
        query,
        value => { pluginExtensionPointQueries.set(plugin.id, value) },
      ))
      const filteredPoints = points.filter(point => {
        const usage = point.plugins.find(item => item.identity.source === plugin.source && item.identity.id === plugin.id)
        return matchesManagerSearch(query, [
          point.titleProjection.text,
          point.descriptionProjection.text,
          point.id,
          ...(usage?.registrations.flatMap(item => [item.titleText, item.descriptionText ?? '', item.id, item.qualifiedId]) ?? []),
          ...(usage?.routes.flatMap(item => [item.qualifiedId, item.definition.path, item.definition.outlet]) ?? []),
        ])
      })
      if (points.length === 0) panel.append(create(document, 'div', 'cxm-empty', '当前插件没有使用任何扩展点'))
      else if (filteredPoints.length === 0) panel.append(create(document, 'div', 'cxm-empty', '没有匹配的扩展点或贡献'))
      const list = create(document, 'div', 'cxm-catalog-list')
      list.setAttribute('role', 'list')
      list.setAttribute('aria-label', `${plugin.name}扩展点列表`)
      for (const point of filteredPoints) {
        const usage = point.plugins.find(item => item.identity.source === plugin.source && item.identity.id === plugin.id)
        list.append(createExtensionPointCatalogItem(snapshot, point, facet => {
          operationError = undefined
          void navigateRoute({ kind: 'extension-point', pointId: point.id, facet })
        }, usage))
      }
      if (filteredPoints.length > 0) panel.append(list)
      content.append(panel)
      return
    }

    const panel = createTabPanel(document, '路由')
    const query = pluginRouteQueries.get(plugin.id) ?? ''
    panel.append(createListSearch(
      `plugin-routes-${plugin.id}`,
      `搜索${plugin.name}的路由与页面`,
      '搜索路径、outlet、页面或 id…',
      query,
      value => { pluginRouteQueries.set(plugin.id, value) },
    ))
    const routesForPage = (page: NavigationPageSnapshot): readonly RouteSnapshot[] => pluginRoutes.filter(route => (
      qualifiedNavigationId(route.owner, route.definition.page) === page.qualifiedId
    ))
    const filteredRoutes = pluginRoutes.filter(route => matchesManagerSearch(query, routeSearchValues(route)))
    const filteredPages = pluginPages.filter(page => matchesManagerSearch(query, pageSearchValues(page, routesForPage(page))))
    if (pluginRoutes.length === 0 && pluginPages.length === 0) {
      panel.append(create(document, 'div', 'cxm-empty', '当前插件没有注册路由或页面'))
    } else if (filteredRoutes.length === 0 && filteredPages.length === 0) {
      panel.append(create(document, 'div', 'cxm-empty', '没有匹配的路由或页面'))
    }
    if (filteredRoutes.length > 0) {
      const routeSection = createRoutePageSection(
        `plugin-${plugin.id}-routes`,
        '路由',
        '从用户入口导航到页面与 Host outlet。',
        `${plugin.name}路由列表`,
      )
      for (const route of filteredRoutes) {
        routeSection.list.append(createRouteProductRow(snapshot, route, () => {
          void navigateRoute({ kind: 'route', qualifiedId: route.qualifiedId })
        }))
      }
      panel.append(routeSection.section)
    }
    if (filteredPages.length > 0) {
      const pageSection = createRoutePageSection(
        `plugin-${plugin.id}-pages`,
        '页面',
        '受控页面内容、适用上下文与 Host chrome 范围。',
        `${plugin.name}页面列表`,
      )
      for (const page of filteredPages) pageSection.list.append(createPageProductRow(snapshot, page, routesForPage(page)))
      panel.append(pageSection.section)
    }
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

  const renderMarketplaceList = (managerSnapshot: ManagerSnapshot): void => {
    const snapshot = marketplace.snapshot()
    setHeading('浏览插件商店', managerSnapshot, { icon: 'marketplace' })
    content.append(documentationLink('查看插件商店文档', PRODUCT_DOCUMENTATION.marketplace))
    const toolbar = create(document, 'div', 'cxm-toolbar')
    const search = createListSearch('marketplace', '搜索 CordisX 插件商店', '搜索商店插件、作者、关键词或来源…', marketplaceQuery, value => { marketplaceQuery = value })
    const certifiedFilter = create(document, 'button', 'cxm-marketplace-filter')
    certifiedFilter.type = 'button'
    certifiedFilter.dataset.marketplaceCertifiedOnly = 'true'
    certifiedFilter.setAttribute('aria-pressed', String(marketplaceCertifiedOnly))
    certifiedFilter.setAttribute('aria-label', marketplaceCertifiedOnly ? '显示全部插件' : '仅显示 CordisX 已认证插件')
    certifiedFilter.append(
      createManagerIcon(document, 'marketplace-certified'),
      create(document, 'span', undefined, '仅看已认证'),
    )
    certifiedFilter.addEventListener('click', () => {
      marketplaceCertifiedOnly = !marketplaceCertifiedOnly
      renderContent()
      content.querySelector<HTMLButtonElement>('[data-marketplace-certified-only]')?.focus()
    })
    const ranked = searchMarketplaceCatalog(snapshot.plugins, {
      query: marketplaceQuery,
      currentLocale: managerSnapshot.localization.locale,
      certifiedOnly: marketplaceCertifiedOnly,
      ...(model.marketplaceEligibility === undefined ? {} : { eligibility: plugin => model.marketplaceEligibility!(plugin) }),
    })
    toolbar.append(search, certifiedFilter)
    content.append(toolbar)

    const list = create(document, 'div', 'cxm-plugin-list')
    list.setAttribute('role', 'list')
    list.setAttribute('aria-label', '插件商店列表')
    if (!snapshot.loading && ranked.length === 0) {
      list.append(create(document, 'div', 'cxm-empty', snapshot.sources.length === 0 ? '尚未配置插件商店地址' : '没有可展示的匹配插件'))
    }
    for (const { plugin, projection: metadata, ranking } of ranked) {
      const row = create(document, 'div', 'cxm-plugin-row')
      row.setAttribute('role', 'listitem')
      row.dataset.marketplacePlugin = plugin.id
      row.dataset.marketplaceOfficial = String(plugin.official !== undefined)
      row.dataset.marketplaceCertified = String(plugin.certification !== undefined)
      row.dataset.marketplaceRankingTier = ranking.textTier
      row.dataset.marketplaceRankingTrustBoost = String(ranking.boundedTrustBoost)
      row.dataset.marketplaceRankingExplanation = marketplaceRankingDescription(ranking)
      const primary = create(document, 'button', 'cxm-plugin-primary')
      primary.type = 'button'
      const trustLabels = [
        ...(plugin.official === undefined ? [] : ['官方']),
        ...(plugin.certification === undefined ? [] : ['已认证']),
      ]
      primary.setAttribute('aria-label', `${metadata.name} · v${plugin.version} · ${metadata.feedName}${trustLabels.length === 0 ? '' : ` · ${trustLabels.join(' · ')}`}`)
      primary.append(createPluginIcon(document, metadata.name))
      const body = create(document, 'span', 'cxm-plugin-body')
      const nameRow = create(document, 'span', 'cxm-plugin-name-row')
      nameRow.append(create(document, 'span', 'cxm-plugin-name', metadata.name))
      const trustBadges = create(document, 'span', 'cxm-marketplace-trust-badges')
      if (plugin.official !== undefined) trustBadges.append(createMarketplaceTrustBadge(
        'official',
        '官方',
        `官方：${plugin.official.description.fallback} 按 ${plugin.official.verificationPolicy.id} ${plugin.official.verificationPolicy.version} 验证发布身份；不等于该版本已认证。`,
      ))
      if (plugin.certification !== undefined) trustBadges.append(createMarketplaceTrustBadge(
        'certified',
        '已认证',
        `已认证：${plugin.certification.description.fallback} 按 ${plugin.certification.reviewPolicy.id} ${plugin.certification.reviewPolicy.version} 审核明确版本；不是绝对安全保证。`,
      ))
      if (trustBadges.childElementCount > 0) nameRow.append(trustBadges)
      body.append(nameRow, create(document, 'span', 'cxm-plugin-description', metadata.description))
      const meta = create(document, 'span', 'cxm-plugin-meta')
      const version = create(document, 'span', 'cxm-plugin-meta-version', `v${plugin.version}`)
      const source = create(document, 'span', 'cxm-plugin-meta-source', metadata.feedName)
      source.title = metadata.feedName
      meta.append(version, source)
      body.append(meta)
      primary.append(body)
      if (trustLabels.length > 0) tooltips.attach(primary, () => `${trustLabels.join('、')}。${marketplaceRankingDescription(ranking)}`, 'top')
      activateManagerListRow(primary, () => {
        rememberListScroll()
        void navigateRoute({ kind: 'marketplace', identity: plugin.identity, facet: 'overview' })
      })
      row.append(primary)
      list.append(row)
    }
    content.append(list)
  }

  const renderMarketplaceDetail = (managerSnapshot: ManagerSnapshot, identityValue: string): void => {
    const plugin = marketplace.snapshot().plugins.find(item => item.identity === identityValue)
    setHeading('插件详情', managerSnapshot)
    if (plugin === undefined) {
      content.append(create(document, 'div', 'cxm-empty', '该插件已不在当前聚合结果中'))
      return
    }
    const metadata = projectMarketplacePlugin(plugin, managerSnapshot.localization.locale)
    const activeFacet = routeState.kind === 'marketplace' ? routeState.facet : 'overview'
    content.append(createLocalTabs(document, MARKETPLACE_DETAIL_TABS, activeFacet, 'data-marketplace-detail-tab', (tab) => {
      void navigateRoute({ kind: 'marketplace', identity: identityValue, facet: tab as MarketplaceDetailTab })
    }))

    if (activeFacet === 'overview') {
      const panel = createTabPanel(document, '概览')
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
        panel.append(createSectionTitle(document, 'Marketplace 信任信息'))
        const trustList = create(document, 'div', 'cxm-marketplace-trust-list')
        const appendEvidence = (target: HTMLElement, href: string): void => {
          const evidence = configureExternalLink(create(document, 'a', 'cxm-action cxm-marketplace-trust-evidence'), href)
          evidence.append(create(document, 'span', undefined, '查看审核证据'), createManagerIcon(document, 'external-link', 'cxm-action-icon'))
          target.append(evidence)
        }
        if (plugin.official !== undefined) {
          const official = plugin.official
          const item = create(document, 'section', 'cxm-marketplace-trust-item')
          item.dataset.marketplaceTrustDimension = 'official'
          const title = create(document, 'div', 'cxm-marketplace-trust-title')
          title.append(createManagerIcon(document, 'marketplace-official'), create(document, 'span', undefined, '官方'))
          item.append(
            title,
            create(document, 'p', 'cxm-marketplace-trust-copy', `${official.label.fallback}。${official.description.fallback}`),
            create(document, 'div', 'cxm-marketplace-trust-meta', `验证 policy ${official.verificationPolicy.id}@${official.verificationPolicy.version} · verifiedAt ${official.verifiedAt}\n发布者 ${official.identity.publisherIdentity} · 包 ${official.identity.packageName}\ncanonical source ${official.identity.canonicalSource}`),
            create(document, 'p', 'cxm-marketplace-trust-copy', '“官方”表示由 CordisX 团队创建并持续维护的发布者身份；它不等于该发布物已经通过版本认证。'),
          )
          appendEvidence(item, official.reviewer.evidenceRef)
          trustList.append(item)
        }
        if (plugin.certification !== undefined) {
          const certification = plugin.certification
          const item = create(document, 'section', 'cxm-marketplace-trust-item')
          item.dataset.marketplaceTrustDimension = 'certified'
          const title = create(document, 'div', 'cxm-marketplace-trust-title')
          title.append(createManagerIcon(document, 'marketplace-certified'), create(document, 'span', undefined, '已认证'))
          item.append(
            title,
            create(document, 'p', 'cxm-marketplace-trust-copy', `${certification.label.fallback}。${certification.description.fallback}`),
            create(document, 'div', 'cxm-marketplace-trust-meta', `由 CordisX 按 policy ${certification.reviewPolicy.id}@${certification.reviewPolicy.version} 审核该版本 v${certification.identity.version} · reviewedAt ${certification.reviewedAt} · expiresAt ${certification.expiresAt}\n发布物 ${certification.identity.integrity}`),
            create(document, 'p', 'cxm-marketplace-trust-copy', '认证绑定此明确版本和 sha256 发布物；新版本或 digest 变化默认不继承。认证不是绝对安全保证。'),
          )
          appendEvidence(item, certification.reviewer.evidenceRef)
          trustList.append(item)
        }
        panel.append(trustList)
        const boundary = create(document, 'div', 'cxm-notice', '认证不等于安全保障。')
        boundary.dataset.marketplaceTrustBoundary = 'true'
        panel.append(boundary, documentationLink('查看信任说明', PRODUCT_DOCUMENTATION.marketplace))
      }
      if (metadata.keywords.length > 0) {
        panel.append(createSectionTitle(document, '关键词'))
        panel.append(create(document, 'p', 'cxm-copy', metadata.keywords.join(' · ')))
      }
      content.append(panel)
      return
    }

    const panel = createTabPanel(document, '作者与来源')
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

  const commitSources = async (sources: readonly string[]): Promise<void> => {
    sourcesBusy = true
    sourceOperationError = undefined
    renderContent()
    try {
      await marketplace.setSources(sources)
    } catch (error) {
      sourceOperationError = error instanceof Error ? error.message : String(error)
    } finally {
      sourcesBusy = false
      renderContent()
    }
  }

  const renderMarketplaceSettings = (target: HTMLElement): void => {
    const snapshot = marketplace.snapshot()
    const panel = create(document, 'div', 'cxm-settings-builtin cxf-scope')
    const intro = create(document, 'div', 'cxm-toolbar')
    intro.append(create(document, 'p', 'cxm-copy', '管理插件商店来源。'), documentationLink('查看配置文档', PRODUCT_DOCUMENTATION.marketplace))
    panel.append(intro)

    const form = forms.form('marketplace-source')
    const item = forms.item({ id: 'cxm-marketplace-source', label: '插件商店 JSON 地址', required: true, fullWidth: true })
    let sourceValue = ''
    const sourceField: CordisXConfigFieldSnapshot = {
      namespace: 'cordisx.host', path: ['marketplaceSource'], type: 'string', role: 'url', value: '', disabled: sourcesBusy, required: true,
    }
    const sourceControl = forms.control(sourceField, 'cxm-marketplace-source', value => {
      sourceValue = typeof value === 'string' ? value.trim() : ''
      item.setError(sourceValue === '' ? undefined : /^https:\/\//iu.test(sourceValue) ? undefined : '请输入 HTTPS 地址')
    })
    if (sourceControl.focusTarget instanceof document.defaultView!.HTMLInputElement) {
      sourceControl.focusTarget.placeholder = 'https://example.com/cordisx-marketplace.json'
    }
    forms.connect(item, sourceControl)
    item.control.append(sourceControl.root)
    form.append(item.root)
    const add = forms.button('添加商店', { type: 'submit', variant: 'primary' })
    add.disabled = sourcesBusy
    const sourceActions = create(document, 'div', 'cxf-actions')
    sourceActions.append(add)
    form.append(sourceActions)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      try {
        const normalized = normalizeMarketplaceSource(sourceValue)
        if (snapshot.sources.includes(normalized)) throw new Error('这个商店地址已经配置')
        void commitSources([...snapshot.sources, normalized])
      } catch (error) {
        sourceOperationError = error instanceof Error ? error.message : String(error)
        item.setError(sourceOperationError)
      }
    })
    panel.append(form)
    if (sourceOperationError !== undefined) panel.append(forms.alert(sourceOperationError, 'error'))

    const sourceList = create(document, 'div', 'cxm-source-list')
    if (snapshot.sources.length === 0) sourceList.append(forms.empty('暂无插件商店。'))
    snapshot.sources.forEach((url, index) => {
      const state = snapshot.sourceStates[index]
      const row = create(document, 'div', 'cxm-source-row')
      row.append(create(document, 'span', 'cxm-source-index', String(index + 1)))
      const body = create(document, 'div', 'cxm-source-body')
      body.append(configureExternalLink(create(document, 'a', 'cxm-source-url', url), url))
      const status = create(document, 'div', 'cxm-source-state')
      const dot = create(document, 'span', 'cxm-status-dot')
      markDecorative(dot)
      dot.dataset.status = state?.status ?? 'loading'
      const stateText = state?.status === 'loaded'
        ? `${projectMarketplaceSourceName(state, model.snapshot().localization.locale) ?? '已验证 feed'} · 已加载`
        : state?.status === 'failed' ? '加载失败' : '加载中…'
      status.append(dot, create(document, 'span', undefined, stateText))
      body.append(status)
      if (state?.status === 'failed' && state.error !== undefined) {
        const error = create(document, 'details', 'cxm-diagnostics')
        error.append(create(document, 'summary', undefined, '查看错误详情'), create(document, 'div', 'cxm-diagnostics-body', state.error))
        body.append(error)
      }
      row.append(body)
      const actions = create(document, 'div', 'cxm-source-actions')
      const up = forms.button('上移')
      up.disabled = index === 0 || sourcesBusy
      up.addEventListener('click', () => {
        const next = [...snapshot.sources]
        const previous = next[index - 1]
        if (previous === undefined) return
        next[index - 1] = url
        next[index] = previous
        void commitSources(next)
      })
      const down = forms.button('下移')
      down.disabled = index === snapshot.sources.length - 1 || sourcesBusy
      down.addEventListener('click', () => {
        const next = [...snapshot.sources]
        const following = next[index + 1]
        if (following === undefined) return
        next[index + 1] = url
        next[index] = following
        void commitSources(next)
      })
      const remove = forms.button('移除', { tone: 'danger' })
      remove.disabled = sourcesBusy
      remove.addEventListener('click', () => void commitSources(snapshot.sources.filter(item => item !== url)))
      actions.append(up, down, remove)
      row.append(actions)
      sourceList.append(row)
    })
    panel.append(sourceList)

    const footerActions = create(document, 'div', 'cxm-toolbar')
    footerActions.style.marginTop = '14px'
    const reset = forms.button('恢复官方商店')
    reset.disabled = sourcesBusy || (snapshot.sources.length === 1 && snapshot.sources[0] === OFFICIAL_MARKETPLACE_SOURCE)
    reset.addEventListener('click', () => void commitSources([OFFICIAL_MARKETPLACE_SOURCE]))
    const reload = forms.button(snapshot.loading ? '加载中…' : '重新加载')
    reload.disabled = snapshot.loading || sourcesBusy
    reload.addEventListener('click', () => void marketplace.reload())
    footerActions.append(reset, reload)
    panel.append(footerActions)
    target.append(panel)
  }

  const renderRuntimeSettings = (target: HTMLElement): void => {
    const panel = create(document, 'div', 'cxm-settings-builtin')
    const runtime = model.snapshot()
    const blocked = runtime.plugins.filter(plugin => (
      plugin.status === 'blocked' || plugin.status === 'permission-blocked' || plugin.status === 'failed'
    ))
    if (blocked.length === 0) {
      panel.append(create(document, 'p', 'cxm-copy', '暂无被屏蔽的插件。'))
    } else {
      const list = create(document, 'div', 'cxm-source-list')
      for (const plugin of blocked) {
        const row = create(document, 'div', 'cxm-source-row')
        row.append(createPluginIcon(document, plugin.name))
        const body = create(document, 'div', 'cxm-source-body')
        body.append(create(document, 'div', 'cxm-source-url', plugin.name), create(document, 'div', 'cxm-source-state', statusLabel(plugin.status)))
        const restore = create(document, 'button', 'cxm-mini-action', '恢复')
        restore.type = 'button'
        restore.disabled = busyPluginId !== undefined
        restore.addEventListener('click', async () => {
          busyPluginId = plugin.id
          renderContent()
          try {
            await authorizeAndRestore(plugin)
          } catch (error) {
            sourceOperationError = error instanceof Error ? error.message : String(error)
          } finally {
            busyPluginId = undefined
            renderContent()
          }
        })
        row.append(body, restore)
        list.append(row)
      }
      panel.append(list)
    }
    panel.append(documentationLink('查看运行状态说明', PRODUCT_DOCUMENTATION.runtime))
    target.append(panel)
  }

  const renderLauncherSettings = (target: HTMLElement): void => {
    const panel = create(document, 'div', 'cxm-settings-builtin')
    panel.append(create(document, 'p', 'cxm-copy', '启动器配置由 cordisx.config.json 管理。'))
    panel.append(documentationLink('查看配置文档', PRODUCT_DOCUMENTATION.launcher))
    target.append(panel)
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
    if (settingsTab === 'host:marketplace') renderMarketplaceSettings(settingsPanelBody)
    if (settingsTab === 'host:runtime') renderRuntimeSettings(settingsPanelBody)
    if (settingsTab === 'host:launcher') renderLauncherSettings(settingsPanelBody)
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
    const previous = routeState
    if (recordHistory) navigationHistory.push(previous)
    if (activePrimary(previous) === 'settings') await disposeSettingsForRouteChange()
    routeState = next
    renderContent()
    if (next.kind === 'primary') restoreListScroll()
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
  }

  function renderContent(): void {
    closePluginActionMenu(false)
    tooltips.hide()
    disposeLunaConsoles()
    const snapshot = model.snapshot()
    const normalized = routeState.kind === 'settings' ? routeState : normalizeRoute(snapshot)
    const normalizedRouteChanged = routeKey(normalized) !== routeKey(routeState)
    if (normalizedRouteChanged) {
      if (routeState.kind === 'settings') {
        void navigateRoute(normalized, { recordHistory: false })
        return
      }
      routeState = normalized
    }
    const primary = activePrimary()
    const preserveSettings = primary === 'settings' && settingsRoot?.isConnected === true
    if (!preserveSettings) {
      disposeConfigRenderers()
      content.replaceChildren()
    }
    for (const [id, button] of navButtons) button.setAttribute('aria-selected', String(id === primary))
    if (routeState.kind === 'permission') return renderPermissionDetail(snapshot, routeState.pluginId, routeState.capability)
    if (routeState.kind === 'plugin') return renderPluginDetail(snapshot, routeState.pluginId)
    if (routeState.kind === 'marketplace') return renderMarketplaceDetail(snapshot, routeState.identity)
    if (routeState.kind === 'extension-point') return renderExtensionPointDetail(snapshot, routeState.pointId)
    if (routeState.kind === 'route') return renderRouteDetail(snapshot, routeState.qualifiedId)
    if (routeState.kind === 'settings') return renderSettings(snapshot)
    if (routeState.primary === 'about') renderAbout(snapshot)
    if (routeState.primary === 'extension-points') renderExtensionPointList(snapshot)
    if (routeState.primary === 'routes') renderRouteList(snapshot)
    if (routeState.primary === 'plugins') renderPluginList(snapshot)
    if (routeState.primary === 'marketplace') renderMarketplaceList(snapshot)
    if (routeState.primary === 'settings') renderSettings(snapshot)
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
    closePluginActionMenu(false)
    disposeConfigRenderers()
    disposeLunaConsoles()
    settingsMount?.abort()
    if (settingsMount !== undefined || settingsMountId !== undefined) void resetSettings().catch(() => {})
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
      void navigateRoute({ kind: 'primary', primary: id })
    })
  }

  let currentTarget: HTMLElement | undefined
  let scheduled = false
  const reconcile = (): void => {
    scheduled = false
    syncHostUiTheme()
    const target = resolveManagerTriggerTarget(document)
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
    if (pluginActionMenuOpen) repositionPluginActionMenu()
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
    if (!consolePaused && routeState.kind === 'plugin' && routeState.pluginId === pluginId && routeState.facet === 'runtime') renderContent()
  }) ?? (() => {})
  const unsubscribeMarketplace = marketplace.subscribe(renderContent)
  void marketplace.reload()

  return () => {
    breadcrumbCleanup()
    disposeConfigRenderers()
    disposeLunaConsoles()
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
