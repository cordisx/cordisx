import {
  type CordisXCapabilityScope,
  type CordisXLocalizationDiagnostic,
  type CordisXLocalizationSnapshot,
  type CordisXPermissionPolicy,
  type CordisXPlatformAdapterStatus,
  type CordisXPlatformCapability,
  type CordisXPluginIdentity,
  type CordisXLocalizedText,
} from '../contracts.js'
import type { LocaleCatalogSnapshot } from './i18n.js'
import {
  BrowserMarketplaceModel,
  OFFICIAL_MARKETPLACE_SOURCE,
  normalizeMarketplaceSource,
  type MarketplaceCatalogPlugin,
  type MarketplaceFetcher,
  type MarketplaceModel,
  type MarketplaceStorage,
} from './marketplace.js'
import { renderSafeMarkdown } from './markdown.js'
import type { CommandSnapshot } from './commands.js'
import { resolveManagerTriggerTarget } from './host-probes.js'
import { createManagerIcon, type ManagerIconToken } from './icons.js'
import type { NavigationSnapshot } from './navigation.js'
import type { SurfaceContributionSnapshot } from './surfaces.js'
import type { ExtensionPointRuntimeSnapshot, ExtensionPointSnapshot } from './extension-points.js'
import cordisxMarkDark from '../../assets/brand/cordisx-mark-dark.svg'
import cordisxMarkLight from '../../assets/brand/cordisx-mark-light.svg'

export type ManagerPluginStatus = 'active' | 'blocked' | 'permission-blocked' | 'configured-disabled' | 'failed'

export interface ManagerPluginSnapshot {
  readonly id: string
  readonly source: string
  readonly name: string
  readonly inject: readonly string[]
  readonly config: unknown
  readonly readme?: string
  readonly status: ManagerPluginStatus
  readonly error?: string
  readonly blockedReason?: string
}

export interface ManagerPermissionSnapshot {
  readonly identity: CordisXPluginIdentity
  readonly capability: CordisXPlatformCapability
  readonly required: boolean
  readonly reason: CordisXLocalizedText
  readonly reasonText: string
  readonly scope: CordisXCapabilityScope
  readonly policy: CordisXPermissionPolicy
  readonly lastUsedAt?: string
  readonly lastDeniedAt?: string
  readonly denialCount: number
  readonly blockedReason?: string
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
  /** Runtime-owned point catalog/policy projection; manager UX consumes it in the following slice. */
  readonly extensionPoints?: ExtensionPointRuntimeSnapshot
}

export interface ManagerModel {
  snapshot(): ManagerSnapshot
  setPluginBlocked(id: string, blocked: boolean): Promise<void>
  setPermissionPolicy(id: string, capability: CordisXPlatformCapability, policy: CordisXPermissionPolicy): Promise<void>
  setExtensionPointPolicy?(source: string, pluginId: string, pointId: string, policy: 'inherit' | 'allow' | 'deny'): Promise<void>
  subscribe(listener: () => void): () => void
}

type ManagerTab = 'about' | 'extension-points' | 'routes' | 'plugins' | 'marketplace' | 'settings'
type PluginDetailTab = 'readme' | 'config' | 'permissions' | 'runtime' | 'extension-points' | 'routes'
type SettingsTab = 'marketplace' | 'runtime' | 'launcher'
type ExtensionPointDetailTab = 'usage' | 'information' | 'diagnostics'
type MarketplaceDetailTab = 'overview' | 'authors-source'
type LocalTabIcon = ManagerIconToken
type SecondaryView =
  | { readonly kind: 'plugin'; readonly id: string }
  | { readonly kind: 'marketplace'; readonly identity: string }
  | { readonly kind: 'extension-point'; readonly id: string }
  | { readonly kind: 'route'; readonly qualifiedId: string }
type PermissionDetailView = {
  readonly pluginId: string
  readonly capability: CordisXPlatformCapability
}

const MANAGER_STYLE_ID = 'cordisx-manager-style'
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
}

const POLICY_LABELS: Readonly<Record<CordisXPermissionPolicy, string>> = {
  ask: '每次询问',
  allow: '始终允许',
  deny: '始终拒绝',
}

const MANAGER_STYLES = `
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
  .cxm-brand-mark[data-brand-rendering="direct-dark"] { object-fit: contain; }
  .cxm-brand-mark[data-color-scheme="current-color"] {
    background: currentColor;
    -webkit-mask-image: var(--cordisx-brand-mask);
    mask-image: var(--cordisx-brand-mask);
    -webkit-mask-position: center;
    mask-position: center;
    -webkit-mask-repeat: no-repeat;
    mask-repeat: no-repeat;
    -webkit-mask-size: contain;
    mask-size: contain;
  }
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
    min-height: 72px;
    flex: 0 0 auto;
    padding: 0 22px;
    border-bottom: 1px solid rgba(255, 255, 255, .08);
  }
  .cxm-heading { display: grid; grid-template-columns: 26px minmax(0, 1fr); align-items: start; column-gap: 9px; min-width: 0; }
  .cxm-heading-row { display: contents; }
  .cxm-heading h2 { display: flex; grid-column: 2; align-items: center; min-width: 0; min-height: 26px; margin: 0; overflow: hidden; color: #fff; font-size: 16px; line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
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
  .cxm-breadcrumb-root { color: #a9b1c0; font-weight: 500; }
  .cxm-breadcrumb-separator { padding: 0 5px; color: #656e7e; }
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
    gap: 4px;
    margin: -5px 0 16px;
    padding: 0;
    overflow-x: auto;
    border-bottom: 1px solid rgba(255, 255, 255, .08);
  }
  .cxm-tab {
    position: relative;
    flex: none;
    padding: 9px 11px 10px;
    border: 0;
    background: transparent;
    color: #858fa1;
    cursor: pointer;
    font: 11px/1.2 system-ui, sans-serif;
  }
  .cxm-tab:first-child { padding-left: 0; }
  .cxm-tab-content { display: inline-grid; grid-template-columns: 26px max-content; align-items: center; gap: 9px; }
  .cxm-tab-icon { width: 26px; height: 26px; color: currentColor; }
  .cxm-tab-icon svg { width: 18px; height: 18px; transform: translateY(-.5px); }
  .cxm-tab:hover { color: #eef0f3; }
  .cxm-tab[aria-selected="true"] { color: #eef0f3; }
  .cxm-tab[aria-selected="true"]::after {
    position: absolute;
    right: 8px;
    bottom: -1px;
    left: 8px;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: #c7ccd4;
    content: '';
  }
  .cxm-tab:first-child[aria-selected="true"]::after { left: 0; }
  .cxm-about-identity { display: flex; align-items: center; gap: 18px; padding: 4px 2px 22px; }
  .cxm-about-identity-copy { min-width: 0; white-space: nowrap; }
  .cxm-about-mark.cxm-brand-mark { width: 54px; height: 54px; }
  .cxm-about-name { color: #f5f6f8; font-size: 22px; font-weight: 720; letter-spacing: -.02em; }
  .cxm-about-version { margin-top: 3px; color: #8d96a8; font: 11px/1.4 ui-monospace, monospace; }
  .cxm-about-actions { border-top: 1px solid rgba(255, 255, 255, .08); border-bottom: 1px solid rgba(255, 255, 255, .08); }
  .cxm-about-action { display: flex; align-items: center; gap: 16px; padding: 15px 2px; color: inherit; text-decoration: none; }
  .cxm-about-action-item + .cxm-about-action-item { border-top: 1px solid rgba(255, 255, 255, .08); }
  .cxm-about-action:hover .cxm-about-action-title { color: #fff; }
  .cxm-about-action:focus-visible { outline: 2px solid #c7ccd4; outline-offset: 3px; }
  .cxm-about-action-body { min-width: 0; flex: 1; }
  .cxm-about-action-title { display: block; color: #d8dce3; font-size: 12px; font-weight: 650; }
  .cxm-about-action-copy { display: block; margin-top: 3px; color: #838d9f; font-size: 11px; }
  .cxm-about-action-arrow { width: 16px; height: 16px; color: #747e8e; }
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
    grid-template-columns: 24px minmax(0, 1fr) 14px;
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
  .cxm-permission-control { display: flex; align-items: center; justify-content: flex-end; min-width: 118px; }
  .cxm-permission-control .cxm-source-input { width: 118px; padding-block: 7px; }
  .cxm-permission-unavailable { color: #8d96a8; font-size: 11px; }
  .cxm-permission-detail-intro { display: grid; grid-template-columns: 34px minmax(0, 1fr); align-items: center; gap: 12px; }
  .cxm-permission-detail-intro .cxm-capability-icon { width: 34px; height: 34px; }
  .cxm-permission-detail-intro .cxm-capability-icon svg { width: 26px; height: 26px; }
  .cxm-permission-detail-policy { display: grid; grid-template-columns: max-content minmax(160px, 260px); align-items: center; gap: 12px; margin-top: 18px; }
  .cxm-permission-detail-policy .cxm-field-label { white-space: nowrap; }
  .cxm-permission-audit { margin-top: 16px; }
  .cxm-diagnostics { margin-top: 22px; border-top: 1px solid rgba(255, 255, 255, .08); }
  .cxm-diagnostics summary { padding: 14px 2px; color: #98a1b2; cursor: pointer; font-size: 11px; }
  .cxm-diagnostics[open] summary { color: #d8dce3; }
  .cxm-diagnostics-body { padding: 0 2px 4px; }
  .cxm-runtime-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
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
    display: flex;
    align-items: center;
    gap: 11px;
    width: 100%;
    min-width: 0;
    padding: 12px;
    border: 1px solid rgba(255, 255, 255, .075);
    border-radius: 11px;
    background: rgba(255, 255, 255, .025);
    color: inherit;
    cursor: pointer;
    text-align: left;
  }
  .cxm-plugin-row:hover { border-color: rgba(199, 204, 212, .3); background: rgba(199, 204, 212, .07); }
  .cxm-plugin-icon {
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
  .cxm-plugin-body { min-width: 0; flex: 1; }
  .cxm-plugin-name { overflow: hidden; color: #f0f2f6; font-size: 12px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-plugin-description { display: -webkit-box; margin-top: 4px; overflow: hidden; color: #818b9d; font-size: 10px; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .cxm-plugin-meta { display: flex; align-items: center; gap: 6px; margin-top: 4px; color: #7d8798; font-size: 10px; }
  .cxm-status-dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: #6b7280; }
  .cxm-status-dot[data-status="active"], .cxm-status-dot[data-status="loaded"] { background: #4ade80; }
  .cxm-status-dot[data-status="failed"] { background: #fb7185; }
  .cxm-status-dot[data-status="blocked"], .cxm-status-dot[data-status="loading"] { background: #fbbf24; }
  .cxm-chevron { width: 18px; height: 18px; color: #626c7d; }
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
  .cxm-code { max-height: 140px; margin: 6px 0 0; overflow: auto; color: #bac2d2; font: 10px/1.45 ui-monospace, monospace; white-space: pre-wrap; }
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
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr) max-content 18px;
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
  .cxm-catalog-icon { width: 32px; height: 32px; color: #bfc5ce; }
  .cxm-catalog-icon svg { width: 21px; height: 21px; }
  .cxm-catalog-copy { min-width: 0; }
  .cxm-catalog-title { color: #e7e9ee; font-size: 12px; font-weight: 650; }
  .cxm-catalog-description { display: block; margin-top: 3px; color: #858fa1; font-size: 11px; }
  .cxm-catalog-id { display: block; margin-top: 4px; color: #697386; font: 10px/1.35 ui-monospace, monospace; }
  .cxm-kind-badge { padding: 3px 7px; border-radius: 6px; background: rgba(199, 204, 212, .09); color: #aeb6c5; font-size: 9px; }
  .cxm-usage-list { border-top: 1px solid rgba(255, 255, 255, .08); border-bottom: 1px solid rgba(255, 255, 255, .08); }
  .cxm-usage-item { padding: 15px 2px; }
  .cxm-usage-item + .cxm-usage-item { border-top: 1px solid rgba(255, 255, 255, .08); }
  .cxm-usage-header { display: grid; grid-template-columns: 36px minmax(0, 1fr) minmax(150px, 190px); align-items: center; gap: 12px; }
  .cxm-usage-resources { display: grid; gap: 6px; margin: 10px 0 0 48px; }
  .cxm-resource-row { color: #8f98a9; font: 10px/1.45 ui-monospace, monospace; overflow-wrap: anywhere; }
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
    .cxm-usage-header { grid-template-columns: 36px minmax(0, 1fr); }
    .cxm-usage-header .cxm-source-input { grid-column: 2; }
  }
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

function createAdaptiveBrandMark(document: Document): HTMLSpanElement {
  const mark = create(document, 'span', 'cxm-brand-mark')
  mark.dataset.cordisxBrandMark = 'true'
  mark.dataset.colorScheme = 'current-color'
  markDecorative(mark)
  mark.style.setProperty('--cordisx-brand-mask', `url("${CORDISX_MARK_LIGHT_URI}")`)
  return mark
}

function createDarkBackgroundBrandMark(document: Document): HTMLImageElement {
  const mark = create(document, 'img', 'cxm-brand-mark')
  mark.dataset.cordisxBrandMark = 'true'
  mark.dataset.brandRendering = 'direct-dark'
  mark.src = CORDISX_MARK_DARK_URI
  mark.alt = ''
  return markDecorative(mark)
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

function createPermissionPolicySelect(
  document: Document,
  permission: ManagerPermissionSnapshot,
  onChange: (policy: CordisXPermissionPolicy, control: HTMLSelectElement) => Promise<void>,
): HTMLSelectElement {
  const policy = create(document, 'select', 'cxm-source-input')
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

function createPluginIcon(document: Document, name: string): HTMLSpanElement {
  return markDecorative(create(document, 'span', 'cxm-plugin-icon', initials(name)))
}

function safeStorage(view: Window | null): MarketplaceStorage | undefined {
  try {
    return view?.localStorage
  } catch {
    return undefined
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
  document.getElementById(MANAGER_STYLE_ID)?.remove()
  const style = create(document, 'style')
  style.id = MANAGER_STYLE_ID
  style.textContent = MANAGER_STYLES
  ;(document.head ?? document.documentElement).append(style)

  const trigger = create(document, 'button')
  trigger.type = 'button'
  trigger.dataset.cordisxManagerTrigger = 'true'
  trigger.setAttribute('aria-label', '管理 CordisX 插件')
  trigger.setAttribute('aria-haspopup', 'dialog')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.title = 'CordisX 插件与扩展点'
  trigger.append(createAdaptiveBrandMark(document))

  const modal = create(document, 'div')
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
  let activeTab: ManagerTab = 'plugins'
  const navButtons = new Map<ManagerTab, HTMLButtonElement>()
  for (const tab of tabs) {
    const button = create(document, 'button', 'cxm-nav-button')
    button.type = 'button'
    button.dataset.tab = tab.id
    button.setAttribute('role', 'tab')
    const icon = tab.brand === true
      ? createDarkBackgroundBrandMark(document)
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
  let pluginQuery = ''
  let marketplaceQuery = ''
  let extensionPointQuery = ''
  let routeQuery = ''
  let secondaryView: SecondaryView | undefined
  let permissionDetail: PermissionDetailView | undefined
  let pluginDetailTab: PluginDetailTab = 'readme'
  let extensionPointDetailTab: ExtensionPointDetailTab = 'usage'
  let marketplaceDetailTab: MarketplaceDetailTab = 'overview'
  let settingsTab: SettingsTab = 'marketplace'
  const listScrollPositions = new Map<ManagerTab, number>()
  let busyPluginId: string | undefined
  let operationError: string | undefined
  let sourceOperationError: string | undefined
  let sourcesBusy = false

  const hideForExternalNavigation = (): void => {
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

  const rememberListScroll = (): void => {
    listScrollPositions.set(activeTab, content.scrollTop)
  }

  const restoreListScroll = (): void => {
    content.scrollTop = listScrollPositions.get(activeTab) ?? 0
  }

  const setHeading = (
    title: string,
    copy: string,
    options: { readonly icon?: ManagerIconToken; readonly brand?: boolean; readonly root?: string; readonly onBack?: () => void } = {},
  ): void => {
    heading.replaceChildren()
    const row = create(document, 'div', 'cxm-heading-row')
    if (options.onBack !== undefined) {
      const back = create(document, 'button', 'cxm-heading-leading cxm-back')
      back.type = 'button'
      back.setAttribute('aria-label', '返回')
      back.append(createManagerIcon(document, 'back', 'cxm-back-icon'))
      back.addEventListener('click', options.onBack)
      row.append(back)
    } else {
      const icon = options.brand === true
        ? createDarkBackgroundBrandMark(document)
        : createManagerIcon(document, options.icon ?? 'plugins')
      icon.classList.add('cxm-heading-leading', 'cxm-heading-icon')
      icon.setAttribute('aria-hidden', 'true')
      row.append(icon)
    }
    const headingTitle = create(document, 'h2')
    if (options.root === undefined) {
      headingTitle.textContent = title
    } else {
      headingTitle.append(
        create(document, 'span', 'cxm-breadcrumb-root', options.root),
        create(document, 'span', 'cxm-breadcrumb-separator', '/'),
        create(document, 'span', undefined, title),
      )
    }
    row.append(headingTitle)
    heading.append(row, create(document, 'p', undefined, copy))
  }

  const renderAbout = (snapshot: ManagerSnapshot): void => {
    setHeading('关于 CordisX', '项目、社区与支持入口', { brand: true })
    const identity = create(document, 'div', 'cxm-about-identity')
    const mark = createDarkBackgroundBrandMark(document)
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

  const extensionPointIcon = (point: ExtensionPointSnapshot): ManagerIconToken => (
    point.kind === 'outlet' ? 'outlets' : point.icon === 'host:info' ? 'point-info' : 'contributions'
  )

  const renderExtensionPointList = (snapshot: ManagerSnapshot): void => {
    setHeading('扩展点', '浏览宿主声明的界面点位，并管理每个插件对点位的使用权限', { icon: 'contributions' })
    const search = create(document, 'input', 'cxm-search')
    search.type = 'search'
    search.placeholder = '搜索名称、介绍、点位 id 或插件…'
    search.value = extensionPointQuery
    search.setAttribute('aria-label', '搜索 CordisX 扩展点')
    content.append(search)

    const points = snapshot.extensionPoints?.points ?? []
    const normalized = extensionPointQuery.trim().toLowerCase()
    const filtered = points.filter(point => [
      point.titleProjection.text,
      point.descriptionProjection.text,
      point.id,
      point.kind,
      ...point.plugins.flatMap(plugin => [plugin.name, plugin.identity.id, plugin.identity.source]),
      ...point.plugins.flatMap(plugin => plugin.registrations.map(item => item.id)),
      ...point.plugins.flatMap(plugin => plugin.routes.map(item => item.qualifiedId)),
    ].join('\n').toLowerCase().includes(normalized))
    const list = create(document, 'div', 'cxm-catalog-list')
    list.setAttribute('role', 'list')
    list.setAttribute('aria-label', '扩展点列表')
    if (points.length === 0) list.append(create(document, 'div', 'cxm-empty', '当前宿主没有声明扩展点；请查看运行诊断。'))
    else if (filtered.length === 0) list.append(create(document, 'div', 'cxm-empty', '没有匹配的扩展点'))
    for (const point of filtered) {
      const listItem = create(document, 'div', 'cxm-catalog-item')
      listItem.setAttribute('role', 'listitem')
      const row = create(document, 'button', 'cxm-catalog-row')
      row.type = 'button'
      row.dataset.extensionPointId = point.id
      const copy = create(document, 'span', 'cxm-catalog-copy')
      copy.append(
        create(document, 'span', 'cxm-catalog-title', point.titleProjection.text),
        create(document, 'span', 'cxm-catalog-description', point.descriptionProjection.text),
        create(document, 'code', 'cxm-catalog-id', point.id),
      )
      row.append(
        createManagerIcon(document, extensionPointIcon(point), 'cxm-catalog-icon'),
        copy,
        create(document, 'span', 'cxm-kind-badge', point.kind === 'surface' ? '界面点位' : '页面出口'),
        createManagerIcon(document, 'view-detail', 'cxm-chevron'),
      )
      row.addEventListener('click', () => {
        rememberListScroll()
        secondaryView = { kind: 'extension-point', id: point.id }
        extensionPointDetailTab = 'usage'
        operationError = undefined
        renderContent()
      })
      listItem.append(row)
      list.append(listItem)
    }
    content.append(list)
    search.addEventListener('input', () => {
      extensionPointQuery = search.value
      renderContent()
      const next = content.querySelector<HTMLInputElement>('.cxm-search')
      next?.focus()
      next?.setSelectionRange(extensionPointQuery.length, extensionPointQuery.length)
    })
  }

  const renderExtensionPointDetail = (snapshot: ManagerSnapshot, id: string): void => {
    const point = snapshot.extensionPoints?.points.find(item => item.id === id)
    setHeading(point?.titleProjection.text ?? id, point?.descriptionProjection.text ?? '扩展点已不在当前宿主目录中', {
      root: '扩展点',
      onBack: () => {
        secondaryView = undefined
        renderContent()
        restoreListScroll()
      },
    })
    if (point === undefined) {
      content.append(create(document, 'div', 'cxm-empty', '该扩展点已不在当前宿主目录中'))
      return
    }
    content.append(createLocalTabs(document, [
      { id: 'usage', label: '使用情况', icon: 'plugins' },
      { id: 'information', label: '点位信息', icon: 'point-info' },
      { id: 'diagnostics', label: '诊断', icon: 'diagnostics' },
    ], extensionPointDetailTab, 'data-extension-point-detail-tab', (tab) => {
      extensionPointDetailTab = tab as ExtensionPointDetailTab
      renderContent()
    }))

    if (extensionPointDetailTab === 'usage') {
      const panel = createTabPanel(document, '使用情况')
      if (point.plugins.length === 0) panel.append(create(document, 'div', 'cxm-empty', '当前没有插件使用这个扩展点'))
      const list = create(document, 'div', 'cxm-usage-list')
      list.setAttribute('role', 'list')
      for (const usage of point.plugins) {
        const item = create(document, 'div', 'cxm-usage-item')
        item.setAttribute('role', 'listitem')
        const headerRow = create(document, 'div', 'cxm-usage-header')
        const pluginCopy = create(document, 'div', 'cxm-plugin-body')
        pluginCopy.append(
          create(document, 'div', 'cxm-plugin-name', usage.name),
          create(document, 'div', 'cxm-plugin-meta', `${usage.identity.id} · ${usage.status}`),
          create(document, 'div', 'cxm-detail-id', usage.identity.source),
        )
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
        headerRow.append(createPluginIcon(document, usage.name), pluginCopy, policy)
        item.append(headerRow)
        const resources = create(document, 'div', 'cxm-usage-resources')
        if (point.kind === 'surface') {
          for (const registration of usage.registrations) {
            const state = !registration.valid ? '无效' : !registration.authorized ? '已拒绝' : registration.rendered ? '已渲染' : registration.pending ? '等待宿主锚点' : '已登记'
            resources.append(create(document, 'div', 'cxm-resource-row', `${registration.id} · ${state}`))
          }
        } else {
          for (const route of usage.routes) {
            const pageId = `${route.owner}:${route.definition.page}`
            resources.append(create(document, 'div', 'cxm-resource-row', `${route.qualifiedId} → ${pageId} · ${route.authorized ? '已授权' : '已拒绝'}`))
          }
        }
        item.append(resources)
        list.append(item)
      }
      if (point.plugins.length > 0) panel.append(list)
      if (operationError !== undefined) panel.append(create(document, 'div', 'cxm-error', operationError))
      content.append(panel)
      return
    }

    if (extensionPointDetailTab === 'information') {
      const panel = createTabPanel(document, '点位信息')
      const fields = create(document, 'div', 'cxm-detail-grid')
      const outlet = point.kind === 'outlet' ? snapshot.navigation.outlets.find(item => item.id === point.id) : undefined
      const rows: readonly (readonly [string, string])[] = [
        ['稳定标识', point.id],
        ['类型', point.kind === 'surface' ? '结构化界面点位' : '覆盖页面出口'],
        ['宿主图标', point.icon],
        ['可用状态', point.available ? '当前可用' : '当前不可用'],
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
      ...(point.availabilityError === undefined ? [] : [point.availabilityError]),
      ...(snapshot.extensionPoints?.descriptorDiagnostics.filter(item => item.pointId === point.id).map(item => `${item.code} · ${item.message}`) ?? []),
      ...(snapshot.extensionPoints?.policyDiagnostics.filter(item => item.identity.pointId === point.id).map(item => `${item.code} · ${item.message}`) ?? []),
      ...(snapshot.extensionPoints?.accessDiagnostics.filter(item => item.request.identity.pointId === point.id).map(item => `${item.request.operation} · ${item.authorized ? '允许' : '拒绝'}${item.reason === undefined ? '' : ` · ${item.reason}`}`) ?? []),
    ]
    if (diagnostics.length === 0) panel.append(create(document, 'div', 'cxm-empty', '当前没有与这个扩展点相关的诊断'))
    for (const diagnostic of diagnostics) panel.append(create(document, 'div', 'cxm-error', diagnostic))
    content.append(panel)
  }

  const renderRouteList = (snapshot: ManagerSnapshot): void => {
    setHeading('路由', '查看插件页面如何匹配路径并覆盖到宿主 outlet', { icon: 'routes' })
    const search = create(document, 'input', 'cxm-search')
    search.type = 'search'
    search.placeholder = '搜索路由、路径、页面、outlet 或插件…'
    search.value = routeQuery
    search.setAttribute('aria-label', '搜索 CordisX 路由')
    content.append(search)
    const normalized = routeQuery.trim().toLowerCase()
    const filtered = snapshot.navigation.routes.filter(route => [
      route.qualifiedId,
      route.owner,
      route.definition.path,
      route.definition.outlet,
      route.definition.page,
      route.error ?? '',
    ].join('\n').toLowerCase().includes(normalized))
    const list = create(document, 'div', 'cxm-catalog-list')
    list.setAttribute('role', 'list')
    list.setAttribute('aria-label', '路由列表')
    if (filtered.length === 0) list.append(create(document, 'div', 'cxm-empty', '没有匹配的路由'))
    for (const route of filtered) {
      const listItem = create(document, 'div', 'cxm-catalog-item')
      listItem.setAttribute('role', 'listitem')
      const row = create(document, 'button', 'cxm-catalog-row')
      row.type = 'button'
      row.dataset.routeId = route.qualifiedId
      const copy = create(document, 'span', 'cxm-catalog-copy')
      copy.append(
        create(document, 'span', 'cxm-catalog-title', route.qualifiedId),
        create(document, 'span', 'cxm-catalog-description', `${route.definition.path} → ${route.definition.outlet}`),
        create(document, 'code', 'cxm-catalog-id', `${route.owner}:${route.definition.page}`),
      )
      row.append(
        createManagerIcon(document, 'routes', 'cxm-catalog-icon'),
        copy,
        create(document, 'span', 'cxm-kind-badge', route.valid && route.authorized ? '可用' : '受限'),
        createManagerIcon(document, 'view-detail', 'cxm-chevron'),
      )
      row.addEventListener('click', () => {
        rememberListScroll()
        secondaryView = { kind: 'route', qualifiedId: route.qualifiedId }
        renderContent()
      })
      listItem.append(row)
      list.append(listItem)
    }
    content.append(list)
    search.addEventListener('input', () => {
      routeQuery = search.value
      renderContent()
      const next = content.querySelector<HTMLInputElement>('.cxm-search')
      next?.focus()
      next?.setSelectionRange(routeQuery.length, routeQuery.length)
    })
  }

  const renderRouteDetail = (snapshot: ManagerSnapshot, qualifiedId: string): void => {
    const route = snapshot.navigation.routes.find(item => item.qualifiedId === qualifiedId)
    setHeading(route?.qualifiedId ?? qualifiedId, '插件页面路由与宿主出口关联', {
      root: '路由',
      onBack: () => {
        secondaryView = undefined
        renderContent()
        restoreListScroll()
      },
    })
    if (route === undefined) {
      content.append(create(document, 'div', 'cxm-empty', '该路由已不在当前 bundle 中'))
      return
    }
    const pageId = `${route.owner}:${route.definition.page}`
    const page = snapshot.navigation.pages.find(item => item.qualifiedId === pageId)
    const outlet = snapshot.navigation.outlets.find(item => item.id === route.definition.outlet)
    const presentation = outlet?.activeRoute !== route.qualifiedId
      ? '未打开'
      : outlet.presentation === 'presented'
        ? '展示中'
        : outlet.presentation === 'suspended'
          ? `已暂停${outlet.suspendedBy === undefined ? '' : ` · 由 ${outlet.suspendedBy} 覆盖`}`
          : '未打开'
    const fields = create(document, 'div', 'cxm-detail-grid')
    for (const [label, value] of [
      ['路径', route.definition.path],
      ['宿主出口', route.definition.outlet],
      ['页面', pageId],
      ['拥有插件', route.owner],
      ['路由状态', !route.valid ? '无效' : route.authorized ? '已授权' : '已拒绝'],
      ['页面注册', page === undefined ? '缺失' : '已注册'],
      ['出口状态', outlet === undefined ? '未声明' : outlet.available ? '可用' : '不可用'],
      ['展示状态', presentation],
    ]) {
      const field = create(document, 'div', 'cxm-field')
      field.append(create(document, 'div', 'cxm-field-label', label), create(document, 'div', 'cxm-field-value', value))
      fields.append(field)
    }
    content.append(fields)
    if (route.error !== undefined) content.append(create(document, 'div', 'cxm-error', route.error))
    if (outlet?.error !== undefined) content.append(create(document, 'div', 'cxm-error', outlet.error))
  }

  const renderPluginList = (snapshot: ManagerSnapshot): void => {
    setHeading('插件', '搜索当前 bundle 中的插件；选择一项进入二级详情', { icon: 'plugins' })
    const toolbar = create(document, 'div', 'cxm-toolbar')
    const search = create(document, 'input', 'cxm-search')
    search.type = 'search'
    search.placeholder = '搜索插件、扩展点或 contribution id…'
    search.value = pluginQuery
    search.setAttribute('aria-label', '搜索 CordisX 插件')

    const normalized = pluginQuery.trim().toLowerCase()
    const filtered = snapshot.plugins.filter((plugin) => {
      const registrations = snapshot.registrations.filter(item => item.owner === plugin.id)
      const haystack = [plugin.id, plugin.name, ...plugin.inject, ...registrations.flatMap(item => [item.surface, item.id])]
        .join('\n').toLowerCase()
      return haystack.includes(normalized)
    })
    toolbar.append(search)
    content.append(toolbar)

    const list = create(document, 'div', 'cxm-plugin-list')
    if (filtered.length === 0) list.append(create(document, 'div', 'cxm-empty', '没有匹配的插件'))
    for (const plugin of filtered) {
      const row = create(document, 'button', 'cxm-plugin-row')
      row.type = 'button'
      row.dataset.pluginId = plugin.id
      row.append(createPluginIcon(document, plugin.name))
      const body = create(document, 'span', 'cxm-plugin-body')
      body.append(create(document, 'span', 'cxm-plugin-name', plugin.name))
      const meta = create(document, 'span', 'cxm-plugin-meta')
      const dot = create(document, 'span', 'cxm-status-dot')
      markDecorative(dot)
      dot.dataset.status = plugin.status
      meta.append(dot, create(document, 'span', undefined, statusLabel(plugin.status)), create(document, 'span', undefined, plugin.id))
      body.append(meta)
      row.append(body, createManagerIcon(document, 'view-detail', 'cxm-chevron'))
      row.addEventListener('click', () => {
        rememberListScroll()
        secondaryView = { kind: 'plugin', id: plugin.id }
        permissionDetail = undefined
        pluginDetailTab = 'readme'
        operationError = undefined
        renderContent()
      })
      list.append(row)
    }
    content.append(list)

    search.addEventListener('input', () => {
      pluginQuery = search.value
      renderContent()
      const next = content.querySelector<HTMLInputElement>('.cxm-search')
      next?.focus()
      next?.setSelectionRange(pluginQuery.length, pluginQuery.length)
    })
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

  const renderPermissionDetail = (snapshot: ManagerSnapshot, view: PermissionDetailView): void => {
    const plugin = snapshot.plugins.find(item => item.id === view.pluginId)
    const permission = snapshot.permissions.find(item => (
      item.identity.id === view.pluginId
      && item.identity.source === plugin?.source
      && item.capability === view.capability
    ))
    const presentation = capabilityPresentation(view.capability)
    setHeading(presentation.name, plugin === undefined ? '插件权限详情' : `${plugin.name} 申请的权限`, {
      root: '权限',
      onBack: () => {
        permissionDetail = undefined
        pluginDetailTab = 'permissions'
        renderContent()
      },
    })
    if (plugin === undefined || permission === undefined) {
      content.append(create(document, 'div', 'cxm-empty', '该权限声明已不在当前 bundle 中'))
      return
    }

    const supported = snapshot.platform.supportedCapabilities.includes(permission.capability)
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
      ['宿主支持', supported ? '当前宿主支持' : '当前宿主暂不支持'],
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

    detail.append(createSectionTitle(document, '本次运行审计'))
    const audit = permission.lastUsedAt === undefined && permission.lastDeniedAt === undefined && permission.denialCount === 0
      ? '本次运行尚无调用记录'
      : `最近允许：${permission.lastUsedAt ?? '无'} · 最近拒绝：${permission.lastDeniedAt ?? '无'} · 拒绝次数：${permission.denialCount}`
    detail.append(create(document, 'p', 'cxm-copy cxm-permission-audit', audit))
    if (operationError !== undefined) detail.append(create(document, 'div', 'cxm-error', operationError))
    content.append(detail)
  }

  const renderPluginDetail = (snapshot: ManagerSnapshot, id: string): void => {
    const plugin = snapshot.plugins.find(item => item.id === id)
    setHeading(plugin?.name ?? id, '当前 bundle 中的本地插件详情', {
      root: '插件',
      onBack: () => {
        secondaryView = undefined
        renderContent()
        restoreListScroll()
      },
    })
    if (plugin === undefined) {
      content.append(create(document, 'div', 'cxm-empty', '插件已不在当前 bundle 中'))
      return
    }

    content.append(createLocalTabs(document, [
      { id: 'readme', label: 'README', icon: 'document' },
      { id: 'config', label: '配置管理', icon: 'configuration' },
      { id: 'permissions', label: '权限', icon: 'permissions' },
      { id: 'runtime', label: '运行状态', icon: 'runtime' },
      { id: 'extension-points', label: '扩展点位', icon: 'outlets' },
      { id: 'routes', label: '路由', icon: 'routes' },
    ], pluginDetailTab, 'data-plugin-detail-tab', (tab) => {
      pluginDetailTab = tab as PluginDetailTab
      renderContent()
    }))

    if (pluginDetailTab === 'readme') {
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

    if (pluginDetailTab === 'config') {
      const panel = createTabPanel(document, '配置管理')
      panel.append(create(document, 'pre', 'cxm-code', formatConfig(plugin.config)))
      panel.append(create(document, 'div', 'cxm-notice', '当前配置来自本次 launcher composition，只读展示；可跨 generation 安全写入前不会在 renderer 内直接修改配置文件。'))
      content.append(panel)
      return
    }

    if (pluginDetailTab === 'permissions') {
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
        const supported = snapshot.platform.supportedCapabilities.includes(permission.capability)
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
        open.append(createCapabilityIcon(document, permission.capability), copy, createManagerIcon(document, 'view-detail', 'cxm-chevron'))
        open.addEventListener('click', () => {
          permissionDetail = { pluginId: plugin.id, capability: permission.capability }
          operationError = undefined
          renderContent()
        })
        const control = create(document, 'div', 'cxm-permission-control')
        if (supported) {
          control.append(createPermissionPolicySelect(document, permission, async (policy, select) => {
            await commitPermissionPolicy(plugin.id, permission, policy, select)
          }))
        } else {
          const unavailable = create(document, 'span', 'cxm-permission-unavailable', '暂不可用')
          unavailable.dataset.permissionUnavailable = permission.capability
          control.append(unavailable)
        }
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
    if (pluginDetailTab === 'runtime') {
      const panel = createTabPanel(document, '运行状态')
      const runtimeToolbar = create(document, 'div', 'cxm-runtime-toolbar')
      const identity = create(document, 'code', 'cxm-detail-id', plugin.id)
      const action = create(document, 'button', 'cxm-action cxm-plugin-runtime-action')
      action.type = 'button'
      const blocked = plugin.status === 'blocked' || plugin.status === 'failed'
      action.textContent = busyPluginId === plugin.id
        ? '处理中…'
        : plugin.status === 'configured-disabled'
          ? '配置中已禁用'
          : plugin.status === 'permission-blocked'
            ? '由必需权限阻止'
          : blocked ? '恢复插件' : '屏蔽插件'
      action.disabled = busyPluginId !== undefined || plugin.status === 'configured-disabled' || plugin.status === 'permission-blocked'
      if (!blocked) action.dataset.tone = 'danger'
      action.addEventListener('click', async () => {
        busyPluginId = plugin.id
        operationError = undefined
        renderContent()
        try {
          await model.setPluginBlocked(plugin.id, !blocked)
        } catch (error) {
          operationError = error instanceof Error ? error.message : String(error)
        } finally {
          busyPluginId = undefined
          renderContent()
        }
      })
      runtimeToolbar.append(identity, action)
      panel.append(runtimeToolbar)
      const fields = create(document, 'div', 'cxm-detail-grid')
      for (const [label, value] of [
        ['状态', statusLabel(plugin.status)],
        ['来源', plugin.source],
        ['注入服务', plugin.inject.join(', ') || '无'],
        ['活跃贡献', String(pluginRegistrations.filter(item => item.visible && item.valid).length)],
        ['Commands', String(pluginCommands.length)],
        ['元数据', '模块 manifest + launcher 绑定身份'],
      ]) {
        const field = create(document, 'div', 'cxm-field')
        field.append(create(document, 'div', 'cxm-field-label', label), create(document, 'div', 'cxm-field-value', value))
        fields.append(field)
      }
      panel.append(fields)
      if (plugin.error !== undefined) panel.append(create(document, 'div', 'cxm-error', plugin.error))
      if (plugin.blockedReason !== undefined) panel.append(create(document, 'div', 'cxm-error', plugin.blockedReason))
      if (operationError !== undefined) panel.append(create(document, 'div', 'cxm-error', operationError))
      const localeCatalogs = snapshot.localeCatalogs.filter(item => item.owner === plugin.id)
      const localeDiagnostics = snapshot.localizationDiagnostics.filter(item => item.owner === plugin.id)
      panel.append(createSectionTitle(document, '本地化'))
      if (localeCatalogs.length === 0) {
        panel.append(create(document, 'div', 'cxm-empty', '当前插件没有活跃 locale dictionary'))
      } else {
        for (const catalog of localeCatalogs) {
          panel.append(create(
            document,
            'div',
            'cxm-notice',
            `${catalog.namespace} · ${catalog.locale} · ${catalog.messageCount} keys · ${catalog.active ? 'active' : 'shadowed'}`,
          ))
        }
      }
      for (const diagnostic of localeDiagnostics) {
        panel.append(create(
          document,
          'div',
          'cxm-error',
          `${diagnostic.diagnostic ?? 'unknown'} · ${diagnostic.namespace}:${diagnostic.key} · ${diagnostic.text}`,
        ))
      }
      panel.append(createSectionTitle(document, '结构化运行时'))
      if (pluginCommands.length === 0) {
        panel.append(create(document, 'div', 'cxm-empty', '当前插件没有 command 注册'))
      }
      for (const command of pluginCommands) panel.append(create(document, 'div', 'cxm-notice', `${command.qualifiedId} · running ${command.running}`))
      const adapter = snapshot.platform
      const diagnostics = create(document, 'details', 'cxm-diagnostics')
      diagnostics.dataset.runtimeDiagnostics = 'platform'
      diagnostics.append(create(document, 'summary', undefined, '诊断'))
      const diagnosticsBody = create(document, 'div', 'cxm-diagnostics-body')
      diagnosticsBody.append(create(
        document,
        'div',
        'cxm-copy',
        `宿主：${adapter.hostName} · adapter ${adapter.mode} · 二次连接 ${adapter.secondConnectionCreated ? '是' : '否'} · 原始 bridge 暴露 ${adapter.rawBridgeExposed ? '是' : '否'}`,
      ))
      for (const diagnostic of adapter.diagnostics) diagnosticsBody.append(create(document, 'div', 'cxm-error', `${diagnostic.code} · ${diagnostic.message}`))
      const securityBoundary = create(document, 'div', 'cxm-notice', '权限策略只约束通过 CordisX Platform API 的调用；当前 trusted renderer code 不是安全沙箱。')
      securityBoundary.dataset.tone = 'warning'
      diagnosticsBody.append(securityBoundary)
      diagnostics.append(diagnosticsBody)
      panel.append(diagnostics)
      content.append(panel)
      return
    }

    if (pluginDetailTab === 'extension-points') {
      const panel = createTabPanel(document, '扩展点位')
      const points = (snapshot.extensionPoints?.points ?? []).filter(point => point.plugins.some(usage => (
        usage.identity.source === plugin.source && usage.identity.id === plugin.id
      )))
      if (points.length === 0) panel.append(create(document, 'div', 'cxm-empty', '当前插件没有使用任何扩展点'))
      const list = create(document, 'div', 'cxm-catalog-list')
      list.setAttribute('role', 'list')
      for (const point of points) {
        const usage = point.plugins.find(item => item.identity.source === plugin.source && item.identity.id === plugin.id)
        const item = create(document, 'div', 'cxm-catalog-row')
        item.setAttribute('role', 'listitem')
        const copy = create(document, 'span', 'cxm-catalog-copy')
        copy.append(
          create(document, 'span', 'cxm-catalog-title', point.titleProjection.text),
          create(document, 'span', 'cxm-catalog-description', point.descriptionProjection.text),
          create(document, 'code', 'cxm-catalog-id', point.id),
        )
        const state = usage?.authorized === false ? '已拒绝' : usage?.active === true ? '使用中' : '已登记'
        item.append(
          createManagerIcon(document, extensionPointIcon(point), 'cxm-catalog-icon'),
          copy,
          create(document, 'span', 'cxm-kind-badge', state),
          create(document, 'span'),
        )
        if (point.kind === 'surface' && usage !== undefined && usage.registrations.length > 0) {
          const resources = create(document, 'div', 'cxm-usage-resources')
          resources.style.gridColumn = '2 / -1'
          for (const registration of usage.registrations) {
            resources.append(create(document, 'div', 'cxm-resource-row', registration.id))
          }
          item.append(resources)
        }
        list.append(item)
      }
      if (points.length > 0) panel.append(list)
      content.append(panel)
      return
    }

    const panel = createTabPanel(document, '路由')
    if (pluginRoutes.length === 0 && pluginPages.length === 0) {
      panel.append(create(document, 'div', 'cxm-empty', '当前插件没有注册路由或页面'))
    }
    const routeList = create(document, 'div', 'cxm-catalog-list')
    routeList.setAttribute('role', 'list')
    for (const route of pluginRoutes) {
      const row = create(document, 'div', 'cxm-catalog-row')
      row.setAttribute('role', 'listitem')
      const copy = create(document, 'span', 'cxm-catalog-copy')
      copy.append(
        create(document, 'span', 'cxm-catalog-title', route.qualifiedId),
        create(document, 'span', 'cxm-catalog-description', `${route.definition.path} → ${route.definition.outlet}`),
        create(document, 'code', 'cxm-catalog-id', `${route.owner}:${route.definition.page}`),
      )
      row.append(
        createManagerIcon(document, 'routes', 'cxm-catalog-icon'),
        copy,
        create(document, 'span', 'cxm-kind-badge', route.valid && route.authorized ? '可用' : '受限'),
        create(document, 'span'),
      )
      routeList.append(row)
    }
    for (const page of pluginPages) {
      const row = create(document, 'div', 'cxm-catalog-row')
      row.setAttribute('role', 'listitem')
      const copy = create(document, 'span', 'cxm-catalog-copy')
      copy.append(create(document, 'span', 'cxm-catalog-title', page.qualifiedId), create(document, 'span', 'cxm-catalog-description', '受控页面 mount'))
      row.append(createManagerIcon(document, 'document', 'cxm-catalog-icon'), copy, create(document, 'span', 'cxm-kind-badge', '页面'), create(document, 'span'))
      routeList.append(row)
    }
    if (pluginRoutes.length > 0 || pluginPages.length > 0) panel.append(routeList)
    content.append(panel)
  }

  const renderMarketplaceList = (): void => {
    const snapshot = marketplace.snapshot()
    setHeading('插件商店', '从已配置 JSON feed 浏览插件元数据；当前只读，不提供安装', { icon: 'marketplace' })
    const toolbar = create(document, 'div', 'cxm-toolbar')
    const search = create(document, 'input', 'cxm-search')
    search.type = 'search'
    search.placeholder = '搜索商店插件、作者、关键词或来源…'
    search.value = marketplaceQuery
    search.setAttribute('aria-label', '搜索 CordisX 插件商店')
    const normalized = marketplaceQuery.trim().toLowerCase()
    const filtered = snapshot.plugins.filter(plugin => [
      plugin.id,
      plugin.name,
      plugin.description,
      plugin.source,
      plugin.feedName,
      ...plugin.keywords,
      ...plugin.authors.map(author => author.name),
    ].join('\n').toLowerCase().includes(normalized))
    toolbar.append(search)
    content.append(toolbar)

    const list = create(document, 'div', 'cxm-plugin-list')
    if (!snapshot.loading && filtered.length === 0) {
      list.append(create(document, 'div', 'cxm-empty', snapshot.sources.length === 0 ? '尚未配置插件商店地址' : '没有可展示的匹配插件'))
    }
    for (const plugin of filtered) {
      const row = create(document, 'button', 'cxm-plugin-row')
      row.type = 'button'
      row.dataset.marketplacePlugin = plugin.id
      row.append(createPluginIcon(document, plugin.name))
      const body = create(document, 'span', 'cxm-plugin-body')
      body.append(
        create(document, 'span', 'cxm-plugin-name', plugin.name),
        create(document, 'span', 'cxm-plugin-description', plugin.description),
      )
      const meta = create(document, 'span', 'cxm-plugin-meta')
      meta.append(create(document, 'span', undefined, `v${plugin.version}`), create(document, 'span', undefined, plugin.feedName))
      body.append(meta)
      row.append(body, createManagerIcon(document, 'view-detail', 'cxm-chevron'))
      row.addEventListener('click', () => {
        rememberListScroll()
        secondaryView = { kind: 'marketplace', identity: plugin.identity }
        marketplaceDetailTab = 'overview'
        renderContent()
      })
      list.append(row)
    }
    content.append(list)
    const boundary = create(document, 'div', 'cxm-notice', '商店收录、schema 校验和页面展示都不代表代码审计、签名验证、安全批准或可安装性。')
    boundary.dataset.tone = 'warning'
    content.append(boundary)

    search.addEventListener('input', () => {
      marketplaceQuery = search.value
      renderContent()
      const next = content.querySelector<HTMLInputElement>('.cxm-search')
      next?.focus()
      next?.setSelectionRange(marketplaceQuery.length, marketplaceQuery.length)
    })
  }

  const renderMarketplaceDetail = (identityValue: string): void => {
    const plugin = marketplace.snapshot().plugins.find(item => item.identity === identityValue)
    setHeading(plugin?.name ?? '已移除的插件', '来自已配置插件商店的只读元数据', {
      root: '插件商店',
      onBack: () => {
        secondaryView = undefined
        renderContent()
        restoreListScroll()
      },
    })
    if (plugin === undefined) {
      content.append(create(document, 'div', 'cxm-empty', '该插件已不在当前聚合结果中'))
      return
    }
    content.append(createLocalTabs(document, [
      { id: 'overview', label: '概览', icon: 'overview' },
      { id: 'authors-source', label: '作者与来源', icon: 'authors-source' },
    ], marketplaceDetailTab, 'data-marketplace-detail-tab', (tab) => {
      marketplaceDetailTab = tab as MarketplaceDetailTab
      renderContent()
    }))

    if (marketplaceDetailTab === 'overview') {
      const panel = createTabPanel(document, '概览')
      panel.append(create(document, 'p', 'cxm-detail-description', plugin.description))
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
      if (plugin.keywords.length > 0) {
        panel.append(createSectionTitle(document, '关键词'))
        panel.append(create(document, 'p', 'cxm-copy', plugin.keywords.join(' · ')))
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
    for (const author of plugin.authors) {
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
    appendLink(`商店来源 · ${plugin.feedName}`, plugin.feedUrl, plugin.feedUrl)
    appendLink('商店主页', plugin.feedHomepage, plugin.feedHomepage)
    panel.append(links)
    const boundary = create(document, 'div', 'cxm-notice', '商店元数据与外部链接不代表代码审计、签名验证、安全批准或可安装性；当前不会下载、执行、安装或激活这个插件。')
    boundary.dataset.tone = 'warning'
    panel.append(boundary)
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

  const renderMarketplaceSettings = (): void => {
    const snapshot = marketplace.snapshot()
    const panel = createTabPanel(document, '插件商店')
    panel.append(create(document, 'p', 'cxm-copy', '按优先级保存多个 marketplace JSON 地址。feed 地址只记录目录来源；插件唯一性由 canonical source 与小写 id 共同决定。'))

    const form = create(document, 'form', 'cxm-source-form')
    const input = create(document, 'input', 'cxm-source-input')
    input.type = 'url'
    input.required = true
    input.placeholder = 'https://example.com/cordisx-marketplace.json'
    input.setAttribute('aria-label', '新的插件商店 JSON 地址')
    const add = create(document, 'button', 'cxm-action', '添加商店')
    add.type = 'submit'
    add.disabled = sourcesBusy
    form.append(input, add)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      try {
        const normalized = normalizeMarketplaceSource(input.value.trim())
        if (snapshot.sources.includes(normalized)) throw new Error('这个商店地址已经配置')
        void commitSources([...snapshot.sources, normalized])
      } catch (error) {
        sourceOperationError = error instanceof Error ? error.message : String(error)
        renderContent()
      }
    })
    panel.append(form)
    if (sourceOperationError !== undefined) panel.append(create(document, 'div', 'cxm-error', sourceOperationError))

    const sourceList = create(document, 'div', 'cxm-source-list')
    if (snapshot.sources.length === 0) sourceList.append(create(document, 'div', 'cxm-empty', '没有已配置商店；插件商店页会保持为空'))
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
        ? `${state.name ?? '已验证 feed'} · 已加载`
        : state?.status === 'failed' ? `加载失败 · ${state.error ?? '未知错误'}` : '加载中…'
      status.append(dot, create(document, 'span', undefined, stateText))
      body.append(status)
      row.append(body)
      const actions = create(document, 'div', 'cxm-source-actions')
      const up = create(document, 'button', 'cxm-mini-action', '上移')
      up.type = 'button'
      up.disabled = index === 0 || sourcesBusy
      up.addEventListener('click', () => {
        const next = [...snapshot.sources]
        const previous = next[index - 1]
        if (previous === undefined) return
        next[index - 1] = url
        next[index] = previous
        void commitSources(next)
      })
      const down = create(document, 'button', 'cxm-mini-action', '下移')
      down.type = 'button'
      down.disabled = index === snapshot.sources.length - 1 || sourcesBusy
      down.addEventListener('click', () => {
        const next = [...snapshot.sources]
        const following = next[index + 1]
        if (following === undefined) return
        next[index + 1] = url
        next[index] = following
        void commitSources(next)
      })
      const remove = create(document, 'button', 'cxm-mini-action', '移除')
      remove.type = 'button'
      remove.disabled = sourcesBusy
      remove.addEventListener('click', () => void commitSources(snapshot.sources.filter(item => item !== url)))
      actions.append(up, down, remove)
      row.append(actions)
      sourceList.append(row)
    })
    panel.append(sourceList)

    const footerActions = create(document, 'div', 'cxm-toolbar')
    footerActions.style.marginTop = '14px'
    const reset = create(document, 'button', 'cxm-action', '恢复官方商店')
    reset.type = 'button'
    reset.disabled = sourcesBusy || (snapshot.sources.length === 1 && snapshot.sources[0] === OFFICIAL_MARKETPLACE_SOURCE)
    reset.addEventListener('click', () => void commitSources([OFFICIAL_MARKETPLACE_SOURCE]))
    const reload = create(document, 'button', 'cxm-action', snapshot.loading ? '加载中…' : '重新加载')
    reload.type = 'button'
    reload.disabled = snapshot.loading || sourcesBusy
    reload.addEventListener('click', () => void marketplace.reload())
    footerActions.append(reset, reload)
    panel.append(footerActions)
    content.append(panel)
  }

  const renderRuntimeSettings = (): void => {
    const panel = createTabPanel(document, '运行状态')
    const runtime = model.snapshot()
    const blocked = runtime.plugins.filter(plugin => plugin.status === 'blocked' || plugin.status === 'failed')
    if (blocked.length === 0) {
      panel.append(create(document, 'p', 'cxm-copy', '当前没有被 profile 本地状态屏蔽的插件。单个插件可在插件详情页屏蔽或恢复。'))
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
            await model.setPluginBlocked(plugin.id, false)
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
    const boundary = create(document, 'div', 'cxm-notice', '屏蔽状态保存在当前隔离 Chromium profile，只控制已打包插件的 Cordis fiber；它不是卸载、权限隔离或 package 禁用。')
    boundary.dataset.tone = 'warning'
    panel.append(boundary)
    content.append(panel)
  }

  const renderLauncherSettings = (): void => {
    const panel = createTabPanel(document, '启动器')
    const launcherNotice = create(document, 'div', 'cxm-notice', '`cordisx.config.json` 仍负责 Codex 可执行文件、插件 composition 和插件配置。修改这些字段需要重新打包并启动新 generation，当前页面只读展示这条边界。')
    launcherNotice.dataset.tone = 'warning'
    panel.append(launcherNotice)
    content.append(panel)
  }

  const renderSettings = (): void => {
    setHeading('配置', '管理 CordisX 设置与当前 profile 状态', { icon: 'settings' })
    content.append(createLocalTabs(document, [
      { id: 'marketplace', label: '插件商店', icon: 'marketplace' },
      { id: 'runtime', label: '运行状态', icon: 'runtime' },
      { id: 'launcher', label: '启动器', icon: 'launcher' },
    ], settingsTab, 'data-settings-tab', (tab) => {
      settingsTab = tab as SettingsTab
      renderContent()
    }))
    if (settingsTab === 'marketplace') renderMarketplaceSettings()
    if (settingsTab === 'runtime') renderRuntimeSettings()
    if (settingsTab === 'launcher') renderLauncherSettings()
  }

  function renderContent(): void {
    const snapshot = model.snapshot()
    content.replaceChildren()
    for (const [id, button] of navButtons) button.setAttribute('aria-selected', String(id === activeTab))
    if (permissionDetail !== undefined && secondaryView?.kind === 'plugin' && activeTab === 'plugins') {
      renderPermissionDetail(snapshot, permissionDetail)
      return
    }
    if (secondaryView?.kind === 'plugin' && activeTab === 'plugins') {
      renderPluginDetail(snapshot, secondaryView.id)
      return
    }
    if (secondaryView?.kind === 'marketplace' && activeTab === 'marketplace') {
      renderMarketplaceDetail(secondaryView.identity)
      return
    }
    if (secondaryView?.kind === 'extension-point' && activeTab === 'extension-points') {
      renderExtensionPointDetail(snapshot, secondaryView.id)
      return
    }
    if (secondaryView?.kind === 'route' && activeTab === 'routes') {
      renderRouteDetail(snapshot, secondaryView.qualifiedId)
      return
    }
    if (activeTab === 'about') renderAbout(snapshot)
    if (activeTab === 'extension-points') renderExtensionPointList(snapshot)
    if (activeTab === 'routes') renderRouteList(snapshot)
    if (activeTab === 'plugins') renderPluginList(snapshot)
    if (activeTab === 'marketplace') renderMarketplaceList()
    if (activeTab === 'settings') renderSettings()
  }

  const open = (): void => {
    modal.hidden = false
    trigger.setAttribute('aria-expanded', 'true')
    renderContent()
    close.focus()
  }
  const dismiss = (): void => {
    modal.hidden = true
    trigger.setAttribute('aria-expanded', 'false')
    trigger.focus()
  }
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !modal.hidden) dismiss()
  }
  trigger.addEventListener('click', open)
  close.addEventListener('click', dismiss)
  content.addEventListener('click', (event) => {
    const target = event.target instanceof document.defaultView!.Element ? event.target : undefined
    if (target?.closest('a[href]') !== null && target !== undefined) hideForExternalNavigation()
  })
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) dismiss()
  })
  document.addEventListener('keydown', onKeydown)
  for (const [id, button] of navButtons) {
    button.addEventListener('click', () => {
      activeTab = id
      secondaryView = undefined
      permissionDetail = undefined
      renderContent()
    })
  }

  let currentTarget: HTMLElement | undefined
  let scheduled = false
  const reconcile = (): void => {
    scheduled = false
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
  const observer = Observer === undefined ? undefined : new Observer(schedule)
  if (document.documentElement !== null) observer?.observe(document.documentElement, { childList: true, subtree: true })
  reconcile()
  renderContent()
  const unsubscribeRuntime = model.subscribe(renderContent)
  const unsubscribeMarketplace = marketplace.subscribe(renderContent)
  void marketplace.reload()

  return () => {
    observer?.disconnect()
    unsubscribeRuntime()
    unsubscribeMarketplace()
    marketplace.dispose()
    marketplaceFetcher.dispose()
    document.removeEventListener('keydown', onKeydown)
    trigger.removeEventListener('click', open)
    trigger.remove()
    modal.remove()
    style.remove()
  }
}
