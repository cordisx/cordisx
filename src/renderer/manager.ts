import {
  CORDISX_SLOT_NAMES,
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
import { resolveManagerTriggerTarget, type SlotRegistrationSnapshot } from './slots.js'

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
  readonly registrations: readonly SlotRegistrationSnapshot[]
  readonly localization: CordisXLocalizationSnapshot
  readonly localeCatalogs: readonly LocaleCatalogSnapshot[]
  readonly localizationDiagnostics: readonly CordisXLocalizationDiagnostic[]
  readonly platform: CordisXPlatformAdapterStatus
  readonly permissions: readonly ManagerPermissionSnapshot[]
}

export interface ManagerModel {
  snapshot(): ManagerSnapshot
  setPluginBlocked(id: string, blocked: boolean): Promise<void>
  setPermissionPolicy(id: string, capability: CordisXPlatformCapability, policy: CordisXPermissionPolicy): Promise<void>
  subscribe(listener: () => void): () => void
}

type ManagerTab = 'about' | 'slots' | 'plugins' | 'marketplace' | 'settings'
type PluginDetailTab = 'readme' | 'config' | 'permissions' | 'runtime' | 'slots'
type SettingsTab = 'marketplace' | 'runtime' | 'launcher'
type SecondaryView =
  | { readonly kind: 'plugin'; readonly id: string }
  | { readonly kind: 'marketplace'; readonly identity: string }

const MANAGER_STYLE_ID = 'cordisx-manager-style'

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
    outline: 2px solid #8b5cf6;
    outline-offset: 1px;
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
    padding: 28px;
    box-sizing: border-box;
    background: rgba(5, 7, 12, .66);
    backdrop-filter: blur(8px);
  }
  .cxm-dialog {
    display: grid;
    grid-template-columns: 210px minmax(0, 1fr);
    width: min(980px, calc(100vw - 56px));
    height: min(680px, calc(100vh - 56px));
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
  .cxm-brand { padding: 2px 10px 18px; }
  .cxm-eyebrow { color: #a78bfa; font-size: 10px; font-weight: 800; letter-spacing: .12em; }
  .cxm-brand-title { margin-top: 3px; color: #fff; font-size: 16px; font-weight: 700; }
  .cxm-version { margin-top: 4px; color: #8d96a8; font: 11px/1.3 ui-monospace, monospace; }
  .cxm-nav { display: grid; gap: 4px; }
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
  .cxm-nav-button[aria-selected="true"] { background: rgba(139, 92, 246, .16); color: #ddd6fe; }
  .cxm-nav-icon { display: inline-grid; place-items: center; width: 20px; color: #a78bfa; font-size: 15px; }
  .cxm-sidebar-note { margin-top: auto; padding: 10px; color: #70798b; font-size: 10px; }
  .cxm-main { display: flex; min-width: 0; flex-direction: column; }
  .cxm-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 72px;
    padding: 0 22px;
    border-bottom: 1px solid rgba(255, 255, 255, .08);
  }
  .cxm-heading { min-width: 0; }
  .cxm-heading-row { display: flex; align-items: center; gap: 9px; min-width: 0; }
  .cxm-heading h2 { min-width: 0; margin: 0; overflow: hidden; color: #fff; font-size: 16px; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-heading p { margin: 3px 0 0 35px; color: #7f899a; font-size: 11px; }
  .cxm-heading-leading {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    flex: none;
    box-sizing: border-box;
    border: 1px solid rgba(167, 139, 250, .28);
    border-radius: 8px;
    background: rgba(139, 92, 246, .1);
    color: #b9a6ff;
  }
  .cxm-back {
    padding: 0;
    cursor: pointer;
  }
  .cxm-back:hover { border-color: rgba(167, 139, 250, .55); background: rgba(139, 92, 246, .18); color: #ddd6fe; }
  .cxm-back:focus-visible { outline: 2px solid #8b5cf6; outline-offset: 2px; }
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
    font: 18px/1 system-ui, sans-serif;
  }
  .cxm-content { min-height: 0; overflow: auto; padding: 20px 22px 24px; }
  .cxm-tabs {
    display: flex;
    gap: 4px;
    margin: -5px 0 16px;
    padding: 0 2px;
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
  .cxm-tab:hover { color: #ddd6fe; }
  .cxm-tab[aria-selected="true"] { color: #ddd6fe; }
  .cxm-tab[aria-selected="true"]::after {
    position: absolute;
    right: 8px;
    bottom: -1px;
    left: 8px;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: #8b5cf6;
    content: '';
  }
  .cxm-card-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .cxm-card, .cxm-detail, .cxm-slot-card, .cxm-source-row {
    border: 1px solid rgba(255, 255, 255, .09);
    border-radius: 12px;
    background: rgba(255, 255, 255, .035);
  }
  .cxm-card { padding: 15px; }
  .cxm-card-label { color: #7f899a; font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
  .cxm-card-value { margin-top: 6px; color: #fff; font-size: 20px; font-weight: 700; }
  .cxm-section-title { margin: 22px 0 8px; color: #f2f4f8; font-size: 13px; font-weight: 700; }
  .cxm-copy { margin: 0; color: #98a1b2; font-size: 12px; }
  .cxm-notice {
    margin-top: 14px;
    padding: 12px 14px;
    border: 1px solid rgba(167, 139, 250, .2);
    border-radius: 11px;
    background: rgba(139, 92, 246, .07);
    color: #b8bfd0;
    font-size: 11px;
  }
  .cxm-notice[data-tone="warning"] { border-color: rgba(251, 191, 36, .2); background: rgba(251, 191, 36, .055); color: #c5b889; }
  .cxm-slots { display: grid; gap: 10px; }
  .cxm-slot-card { padding: 13px 14px; }
  .cxm-slot-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .cxm-slot-name { color: #ddd6fe; font: 12px/1.3 ui-monospace, monospace; }
  .cxm-count { color: #86efac; font-size: 10px; font-weight: 700; }
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
  .cxm-dot { color: #86efac; }
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
  .cxm-search:focus, .cxm-source-input:focus { border-color: rgba(167, 139, 250, .65); }
  .cxm-result-count { flex: none; color: #737e90; font-size: 10px; }
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
  .cxm-plugin-row:hover { border-color: rgba(167, 139, 250, .3); background: rgba(139, 92, 246, .07); }
  .cxm-plugin-icon {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    flex: none;
    border: 1px solid rgba(167, 139, 250, .24);
    border-radius: 10px;
    background: rgba(139, 92, 246, .1);
    color: #c4b5fd;
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
  .cxm-chevron { flex: none; color: #626c7d; font-size: 18px; }
  .cxm-detail { min-width: 0; padding: 18px; }
  .cxm-detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  .cxm-permission-policy { display: grid; grid-template-columns: max-content minmax(0, 1fr); align-items: center; gap: 12px; }
  .cxm-permission-policy .cxm-field-label { white-space: nowrap; }
  .cxm-permission-policy .cxm-source-input { width: 100%; min-width: 0; }
  .cxm-detail h3 { margin: 0; color: #fff; font-size: 17px; }
  .cxm-detail-id { margin-top: 3px; color: #747f91; font: 10px/1.3 ui-monospace, monospace; }
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
  }
  .cxm-action:hover:not(:disabled) { border-color: rgba(167, 139, 250, .5); background: rgba(139, 92, 246, .12); }
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
  .cxm-readme a { color: #b9a6ff; text-decoration: none; }
  .cxm-readme a:hover { text-decoration: underline; }
  .cxm-readme code { padding: 1px 4px; border-radius: 4px; background: rgba(255, 255, 255, .065); color: #ddd6fe; font: 10px/1.5 ui-monospace, monospace; }
  .cxm-readme pre { margin: 12px 0 16px; overflow: auto; padding: 12px 14px; border: 1px solid rgba(255, 255, 255, .08); border-radius: 10px; background: #0d1017; }
  .cxm-readme pre code { padding: 0; background: transparent; color: #c5ccda; white-space: pre; }
  .cxm-error { margin-top: 12px; color: #fda4af; font-size: 11px; }
  .cxm-feed-summary { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .cxm-feed-chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 8px; background: rgba(255, 255, 255, .04); color: #8c96a8; font-size: 10px; }
  .cxm-source-form { display: flex; gap: 8px; margin-top: 16px; }
  .cxm-source-list { display: grid; gap: 8px; margin-top: 14px; }
  .cxm-source-row { display: flex; align-items: center; gap: 10px; padding: 11px; }
  .cxm-source-index { display: grid; place-items: center; width: 24px; height: 24px; flex: none; border-radius: 7px; background: rgba(139, 92, 246, .11); color: #b9a6ff; font-size: 10px; font-weight: 700; }
  .cxm-source-body { min-width: 0; flex: 1; }
  .cxm-source-url { overflow: hidden; color: #c6ccd8; font: 10px/1.35 ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-source-state { display: flex; align-items: center; gap: 6px; margin-top: 4px; color: #737e90; font-size: 10px; }
  .cxm-source-actions { display: flex; flex: none; gap: 5px; }
  .cxm-mini-action { padding: 5px 7px; border: 1px solid rgba(255, 255, 255, .09); border-radius: 7px; background: transparent; color: #99a2b2; cursor: pointer; font: 10px/1.2 system-ui, sans-serif; }
  .cxm-mini-action:hover:not(:disabled) { color: #fff; border-color: rgba(167, 139, 250, .4); }
  .cxm-mini-action:disabled { cursor: default; opacity: .35; }
  @media (max-width: 760px) {
    .cxm-dialog { grid-template-columns: 165px minmax(0, 1fr); }
    .cxm-card-grid, .cxm-detail-grid, .cxm-plugin-list { grid-template-columns: 1fr; }
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

function createLocalTabs(
  document: Document,
  items: readonly { readonly id: string; readonly label: string }[],
  active: string,
  dataAttribute: string,
  onSelect: (id: string) => void,
): HTMLElement {
  const tabs = create(document, 'div', 'cxm-tabs')
  tabs.setAttribute('role', 'tablist')
  for (const item of items) {
    const button = create(document, 'button', 'cxm-tab', item.label)
    button.type = 'button'
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-selected', String(item.id === active))
    button.setAttribute(dataAttribute, item.id)
    button.addEventListener('click', () => onSelect(item.id))
    tabs.append(button)
  }
  return tabs
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
  trigger.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><path d="M17 13.5v7m-3.5-3.5h7" stroke-linecap="round"/></svg>'

  const modal = create(document, 'div')
  modal.dataset.cordisxManagerModal = 'true'
  modal.hidden = true
  const backdrop = create(document, 'div', 'cxm-backdrop')
  const dialog = create(document, 'section', 'cxm-dialog')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-label', 'CordisX 插件与扩展点管理器')

  const sidebar = create(document, 'aside', 'cxm-sidebar')
  const brand = create(document, 'div', 'cxm-brand')
  brand.append(
    create(document, 'div', 'cxm-eyebrow', 'CORDISX'),
    create(document, 'div', 'cxm-brand-title', '插件管理器'),
    create(document, 'div', 'cxm-version', `v${model.snapshot().version}`),
  )
  sidebar.append(brand)

  const nav = create(document, 'nav', 'cxm-nav')
  const tabs: readonly { id: ManagerTab; icon: string; label: string }[] = [
    { id: 'about', icon: '◈', label: '关于 CordisX' },
    { id: 'slots', icon: '⊞', label: '扩展点' },
    { id: 'plugins', icon: '◫', label: '插件' },
    { id: 'marketplace', icon: '◇', label: '插件商店' },
    { id: 'settings', icon: '⚙', label: '配置' },
  ]
  let activeTab: ManagerTab = 'about'
  const navButtons = new Map<ManagerTab, HTMLButtonElement>()
  for (const tab of tabs) {
    const button = create(document, 'button', 'cxm-nav-button')
    button.type = 'button'
    button.dataset.tab = tab.id
    button.setAttribute('role', 'tab')
    const icon = create(document, 'span', 'cxm-nav-icon', tab.icon)
    icon.setAttribute('aria-hidden', 'true')
    button.append(icon, create(document, 'span', undefined, tab.label))
    navButtons.set(tab.id, button)
    nav.append(button)
  }
  sidebar.append(nav, create(document, 'div', 'cxm-sidebar-note', 'Trusted local code · 当前不是安全沙箱'))

  const main = create(document, 'div', 'cxm-main')
  const header = create(document, 'header', 'cxm-header')
  const heading = create(document, 'div', 'cxm-heading')
  const close = create(document, 'button', 'cxm-close', '×')
  close.type = 'button'
  close.setAttribute('aria-label', '关闭 CordisX 管理器')
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
  let secondaryView: SecondaryView | undefined
  let pluginDetailTab: PluginDetailTab = 'readme'
  let settingsTab: SettingsTab = 'marketplace'
  let busyPluginId: string | undefined
  let operationError: string | undefined
  let sourceOperationError: string | undefined
  let sourcesBusy = false

  const setHeading = (
    title: string,
    copy: string,
    options: { readonly icon?: string; readonly root?: string; readonly onBack?: () => void } = {},
  ): void => {
    heading.replaceChildren()
    const row = create(document, 'div', 'cxm-heading-row')
    if (options.onBack !== undefined) {
      const back = create(document, 'button', 'cxm-heading-leading cxm-back')
      back.type = 'button'
      back.setAttribute('aria-label', '返回')
      back.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9"><path d="m15 18-6-6 6-6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      back.addEventListener('click', options.onBack)
      row.append(back)
    } else {
      const icon = create(document, 'span', 'cxm-heading-leading cxm-heading-icon', options.icon ?? '◈')
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
    setHeading('关于 CordisX', '当前 renderer 中的宿主与运行状态', { icon: '◈' })
    const active = snapshot.plugins.filter(plugin => plugin.status === 'active').length
    const grid = create(document, 'div', 'cxm-card-grid')
    for (const [label, value] of [
      ['CordisX 版本', `v${snapshot.version}`],
      ['运行插件', `${active} / ${snapshot.plugins.length}`],
      ['语义扩展点', String(CORDISX_SLOT_NAMES.length)],
      ['宿主语言', `${snapshot.localization.locale} / ${snapshot.localization.direction}`],
      ['词典', String(snapshot.localeCatalogs.filter(item => item.active).length)],
      ['i18n 诊断', String(snapshot.localizationDiagnostics.length)],
    ]) {
      const card = create(document, 'div', 'cxm-card')
      card.append(create(document, 'div', 'cxm-card-label', label), create(document, 'div', 'cxm-card-value', value))
      grid.append(card)
    }
    content.append(grid)
    content.append(create(document, 'div', 'cxm-section-title', '运行边界'))
    content.append(create(document, 'p', 'cxm-copy', '插件作为可信本地代码运行在 Codex renderer 中；Cordis fiber 提供生命周期与可逆卸载，但不提供进程隔离或权限沙箱。'))
    content.append(create(document, 'div', 'cxm-notice', '管理器里的“屏蔽”会卸载插件 fiber，并保存在当前 Chromium profile。它不会删除包、修改配置文件或阻止已打包模块的顶层代码。'))
  }

  const renderSlots = (snapshot: ManagerSnapshot): void => {
    setHeading('扩展点', '按语义 slot 查看当前活跃插件贡献', { icon: '⊞' })
    const slots = create(document, 'div', 'cxm-slots')
    for (const slot of CORDISX_SLOT_NAMES) {
      const registrations = snapshot.registrations.filter(item => item.slot === slot && item.active)
      const card = create(document, 'section', 'cxm-slot-card')
      const head = create(document, 'div', 'cxm-slot-head')
      head.append(
        create(document, 'code', 'cxm-slot-name', slot),
        create(document, 'span', 'cxm-count', `${registrations.length} 个活跃贡献`),
      )
      card.append(head)
      const rows = create(document, 'div', 'cxm-contributions')
      if (registrations.length === 0) {
        rows.append(create(document, 'span', 'cxm-empty', '当前没有插件贡献'))
      } else {
        for (const registration of registrations) {
          const row = create(document, 'span', 'cxm-contribution')
          row.append(
            create(document, 'span', 'cxm-dot', registration.mounted ? '●' : '○'),
            create(document, 'strong', undefined, registration.pluginId),
            create(document, 'span', undefined, registration.id),
          )
          rows.append(row)
        }
      }
      card.append(rows)
      slots.append(card)
    }
    content.append(slots)
  }

  const renderPluginList = (snapshot: ManagerSnapshot): void => {
    setHeading('插件', '搜索当前 bundle 中的插件；选择一项进入二级详情', { icon: '◫' })
    const toolbar = create(document, 'div', 'cxm-toolbar')
    const search = create(document, 'input', 'cxm-search')
    search.type = 'search'
    search.placeholder = '搜索插件、扩展点或 contribution id…'
    search.value = pluginQuery
    search.setAttribute('aria-label', '搜索 CordisX 插件')

    const normalized = pluginQuery.trim().toLowerCase()
    const filtered = snapshot.plugins.filter((plugin) => {
      const registrations = snapshot.registrations.filter(item => item.pluginId === plugin.id)
      const haystack = [plugin.id, plugin.name, ...plugin.inject, ...registrations.flatMap(item => [item.slot, item.id])]
        .join('\n').toLowerCase()
      return haystack.includes(normalized)
    })
    toolbar.append(search, create(document, 'span', 'cxm-result-count', `${filtered.length} / ${snapshot.plugins.length}`))
    content.append(toolbar)

    const list = create(document, 'div', 'cxm-plugin-list')
    if (filtered.length === 0) list.append(create(document, 'div', 'cxm-empty', '没有匹配的插件'))
    for (const plugin of filtered) {
      const row = create(document, 'button', 'cxm-plugin-row')
      row.type = 'button'
      row.dataset.pluginId = plugin.id
      row.append(create(document, 'span', 'cxm-plugin-icon', initials(plugin.name)))
      const body = create(document, 'span', 'cxm-plugin-body')
      body.append(create(document, 'span', 'cxm-plugin-name', plugin.name))
      const meta = create(document, 'span', 'cxm-plugin-meta')
      const dot = create(document, 'span', 'cxm-status-dot')
      dot.dataset.status = plugin.status
      meta.append(dot, create(document, 'span', undefined, statusLabel(plugin.status)), create(document, 'span', undefined, plugin.id))
      body.append(meta)
      row.append(body, create(document, 'span', 'cxm-chevron', '›'))
      row.addEventListener('click', () => {
        secondaryView = { kind: 'plugin', id: plugin.id }
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

  const renderPluginDetail = (snapshot: ManagerSnapshot, id: string): void => {
    const plugin = snapshot.plugins.find(item => item.id === id)
    setHeading(plugin?.name ?? id, '当前 bundle 中的本地插件详情', {
      root: '插件',
      onBack: () => {
        secondaryView = undefined
        renderContent()
      },
    })
    if (plugin === undefined) {
      const detail = create(document, 'section', 'cxm-detail')
      detail.append(create(document, 'div', 'cxm-empty', '插件已不在当前 bundle 中'))
      content.append(detail)
      return
    }

    content.append(createLocalTabs(document, [
      { id: 'readme', label: 'README' },
      { id: 'config', label: '配置管理' },
      { id: 'permissions', label: '权限' },
      { id: 'runtime', label: '运行状态' },
      { id: 'slots', label: '扩展点位' },
    ], pluginDetailTab, 'data-plugin-detail-tab', (tab) => {
      pluginDetailTab = tab as PluginDetailTab
      renderContent()
    }))

    if (pluginDetailTab === 'readme') {
      if (plugin.readme?.trim() === '') {
        content.append(create(document, 'div', 'cxm-empty', '该插件没有随当前 bundle 提供 README.md'))
      } else if (plugin.readme === undefined) {
        content.append(create(document, 'div', 'cxm-empty', '该插件没有随当前 bundle 提供 README.md'))
      } else {
        content.append(renderSafeMarkdown(document, plugin.readme))
      }
      return
    }

    if (pluginDetailTab === 'config') {
      const detail = create(document, 'section', 'cxm-detail')
      detail.append(create(document, 'h3', undefined, '插件配置'))
      detail.append(create(document, 'pre', 'cxm-code', formatConfig(plugin.config)))
      detail.append(create(document, 'div', 'cxm-notice', '当前配置来自本次 launcher composition，只读展示；可跨 generation 安全写入前不会在 renderer 内直接修改配置文件。'))
      content.append(detail)
      return
    }

    if (pluginDetailTab === 'permissions') {
      const detail = create(document, 'section', 'cxm-detail')
      detail.append(create(document, 'h3', undefined, 'Platform 权限'))
      const permissions = snapshot.permissions.filter(item => item.identity.source === plugin.source && item.identity.id === plugin.id)
      if (permissions.length === 0) {
        detail.append(create(document, 'div', 'cxm-empty', '该插件没有声明 Platform capability'))
      }
      for (const permission of permissions) {
        const card = create(document, 'section', 'cxm-slot-card')
        const head = create(document, 'div', 'cxm-slot-head')
        head.append(
          create(document, 'code', 'cxm-slot-name', permission.capability),
          create(document, 'span', 'cxm-count', permission.required ? '必需' : '可选'),
        )
        const reason = create(document, 'div', 'cxm-copy', permission.reasonText)
        const scope = create(document, 'pre', 'cxm-code', formatConfig(permission.scope))
        const policyRow = create(document, 'div', 'cxm-permission-policy')
        const policyLabel = create(document, 'label', 'cxm-field-label', '用户策略')
        const policy = create(document, 'select', 'cxm-source-input')
        policy.dataset.permissionCapability = permission.capability
        for (const value of ['ask', 'deny', 'allow'] as const) {
          const option = document.createElement('option')
          option.value = value
          option.textContent = value
          option.selected = permission.policy === value
          policy.append(option)
        }
        policy.addEventListener('change', async () => {
          operationError = undefined
          policy.disabled = true
          try {
            await model.setPermissionPolicy(plugin.id, permission.capability, policy.value as CordisXPermissionPolicy)
          } catch (error) {
            operationError = error instanceof Error ? error.message : String(error)
          } finally {
            renderContent()
          }
        })
        policyRow.append(policyLabel, policy)
        const recent = create(
          document,
          'div',
          'cxm-copy',
          `最近使用：${permission.lastUsedAt ?? '无'} · 最近拒绝：${permission.lastDeniedAt ?? '无'} · 拒绝次数：${permission.denialCount}`,
        )
        card.append(head, reason, scope, policyRow, recent)
        if (permission.blockedReason !== undefined) card.append(create(document, 'div', 'cxm-error', permission.blockedReason))
        detail.append(card)
      }
      if (operationError !== undefined) detail.append(create(document, 'div', 'cxm-error', operationError))
      const adapter = snapshot.platform
      detail.append(create(
        document,
        'div',
        'cxm-notice',
        `当前连接：${adapter.hostName} · ${adapter.mode} · 二次连接 ${adapter.secondConnectionCreated ? '是' : '否'} · 原始 bridge 暴露 ${adapter.rawBridgeExposed ? '是' : '否'}`,
      ))
      for (const diagnostic of adapter.diagnostics) detail.append(create(document, 'div', 'cxm-error', `${diagnostic.code} · ${diagnostic.message}`))
      detail.append(create(document, 'div', 'cxm-notice', '这些策略只约束通过 CordisX Platform API 的调用；当前 trusted renderer code 不是安全沙箱。'))
      content.append(detail)
      return
    }

    const pluginRegistrations = snapshot.registrations.filter(item => item.pluginId === plugin.id)
    if (pluginDetailTab === 'runtime') {
      const detail = create(document, 'section', 'cxm-detail')
      const detailHead = create(document, 'div', 'cxm-detail-head')
      const identity = create(document, 'div')
      identity.append(create(document, 'h3', undefined, plugin.name), create(document, 'div', 'cxm-detail-id', plugin.id))
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
      detailHead.append(identity, action)
      detail.append(detailHead)
      const fields = create(document, 'div', 'cxm-detail-grid')
      for (const [label, value] of [
        ['状态', statusLabel(plugin.status)],
        ['来源', plugin.source],
        ['注入服务', plugin.inject.join(', ') || '无'],
        ['活跃贡献', String(pluginRegistrations.filter(item => item.active).length)],
        ['元数据', '模块 manifest + launcher 绑定身份'],
      ]) {
        const field = create(document, 'div', 'cxm-field')
        field.append(create(document, 'div', 'cxm-field-label', label), create(document, 'div', 'cxm-field-value', value))
        fields.append(field)
      }
      detail.append(fields)
      if (plugin.error !== undefined) detail.append(create(document, 'div', 'cxm-error', plugin.error))
      if (plugin.blockedReason !== undefined) detail.append(create(document, 'div', 'cxm-error', plugin.blockedReason))
      if (operationError !== undefined) detail.append(create(document, 'div', 'cxm-error', operationError))
      const localeCatalogs = snapshot.localeCatalogs.filter(item => item.owner === plugin.id)
      const localeDiagnostics = snapshot.localizationDiagnostics.filter(item => item.owner === plugin.id)
      detail.append(create(document, 'div', 'cxm-section-title', '本地化'))
      if (localeCatalogs.length === 0) {
        detail.append(create(document, 'div', 'cxm-empty', '当前插件没有活跃 locale dictionary'))
      } else {
        for (const catalog of localeCatalogs) {
          detail.append(create(
            document,
            'div',
            'cxm-notice',
            `${catalog.namespace} · ${catalog.locale} · ${catalog.messageCount} keys · ${catalog.active ? 'active' : 'shadowed'}`,
          ))
        }
      }
      for (const diagnostic of localeDiagnostics) {
        detail.append(create(
          document,
          'div',
          'cxm-error',
          `${diagnostic.diagnostic ?? 'unknown'} · ${diagnostic.namespace}:${diagnostic.key} · ${diagnostic.text}`,
        ))
      }
      content.append(detail)
      return
    }

    const slots = create(document, 'div', 'cxm-slots')
    if (pluginRegistrations.length === 0) slots.append(create(document, 'div', 'cxm-empty', '当前没有可归属到该插件的扩展点注册'))
    for (const registration of pluginRegistrations) {
      const card = create(document, 'section', 'cxm-slot-card')
      const head = create(document, 'div', 'cxm-slot-head')
      const registrationState = !registration.active ? '未激活' : registration.mounted ? '已挂载' : '等待宿主锚点'
      head.append(create(document, 'code', 'cxm-slot-name', registration.slot), create(document, 'span', 'cxm-count', registrationState))
      const rows = create(document, 'div', 'cxm-contributions')
      rows.append(
        create(document, 'span', 'cxm-contribution', registration.id),
        create(document, 'span', 'cxm-contribution', `order ${registration.order}`),
        create(document, 'span', 'cxm-contribution', `priority ${registration.priority}`),
      )
      card.append(head, rows)
      slots.append(card)
    }
    content.append(slots)
  }

  const renderMarketplaceList = (): void => {
    const snapshot = marketplace.snapshot()
    setHeading('插件商店', '从已配置 JSON feed 浏览插件元数据；当前只读，不提供安装', { icon: '◇' })
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
    toolbar.append(search, create(document, 'span', 'cxm-result-count', `${filtered.length} / ${snapshot.plugins.length}`))
    content.append(toolbar)

    const feedSummary = create(document, 'div', 'cxm-feed-summary')
    for (const source of snapshot.sourceStates) {
      const chip = create(document, 'span', 'cxm-feed-chip')
      const dot = create(document, 'span', 'cxm-status-dot')
      dot.dataset.status = source.status
      const label = source.status === 'loaded'
        ? `${source.name ?? new URL(source.url).hostname} · ${source.pluginCount ?? 0}`
        : source.status === 'loading' ? `${new URL(source.url).hostname} · 加载中` : `${new URL(source.url).hostname} · 失败`
      chip.title = source.error ?? source.url
      chip.append(dot, create(document, 'span', undefined, label))
      feedSummary.append(chip)
    }
    if (snapshot.duplicates.length > 0) feedSummary.append(create(document, 'span', 'cxm-feed-chip', `${snapshot.duplicates.length} 个重复项已忽略`))
    content.append(feedSummary)

    const list = create(document, 'div', 'cxm-plugin-list')
    if (!snapshot.loading && filtered.length === 0) {
      list.append(create(document, 'div', 'cxm-empty', snapshot.sources.length === 0 ? '尚未配置插件商店地址' : '没有可展示的匹配插件'))
    }
    for (const plugin of filtered) {
      const row = create(document, 'button', 'cxm-plugin-row')
      row.type = 'button'
      row.dataset.marketplacePlugin = plugin.id
      row.append(create(document, 'span', 'cxm-plugin-icon', initials(plugin.name)))
      const body = create(document, 'span', 'cxm-plugin-body')
      body.append(
        create(document, 'span', 'cxm-plugin-name', plugin.name),
        create(document, 'span', 'cxm-plugin-description', plugin.description),
      )
      const meta = create(document, 'span', 'cxm-plugin-meta')
      meta.append(create(document, 'span', undefined, `v${plugin.version}`), create(document, 'span', undefined, plugin.feedName))
      body.append(meta)
      row.append(body, create(document, 'span', 'cxm-chevron', '›'))
      row.addEventListener('click', () => {
        secondaryView = { kind: 'marketplace', identity: plugin.identity }
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
      },
    })
    const detail = create(document, 'section', 'cxm-detail')
    if (plugin === undefined) {
      detail.append(create(document, 'div', 'cxm-empty', '该插件已不在当前聚合结果中'))
      content.append(detail)
      return
    }
    const detailHead = create(document, 'div', 'cxm-detail-head')
    const identity = create(document, 'div')
    identity.append(create(document, 'h3', undefined, plugin.name), create(document, 'div', 'cxm-detail-id', `${plugin.source} / ${plugin.id}`))
    const sourceLink = create(document, 'a', 'cxm-action', '查看源码 ↗')
    sourceLink.href = plugin.homepage ?? plugin.source
    sourceLink.target = '_blank'
    sourceLink.rel = 'noreferrer'
    detailHead.append(identity, sourceLink)
    detail.append(detailHead, create(document, 'p', 'cxm-detail-description', plugin.description))

    const fields = create(document, 'div', 'cxm-detail-grid')
    for (const [label, value] of [
      ['版本', `v${plugin.version}`],
      ['CordisX 兼容范围', plugin.compatibility.cordisx],
      ['作者', plugin.authors.map(author => author.name).join(', ')],
      ['许可证', plugin.license],
      ['插件来源', plugin.source],
      ['商店来源', `${plugin.feedName}\n${plugin.feedUrl}`],
    ]) {
      const field = create(document, 'div', 'cxm-field')
      field.append(create(document, 'div', 'cxm-field-label', label), create(document, 'div', 'cxm-field-value', value))
      fields.append(field)
    }
    detail.append(fields)
    if (plugin.keywords.length > 0) {
      detail.append(create(document, 'div', 'cxm-section-title', '关键词'))
      detail.append(create(document, 'p', 'cxm-copy', plugin.keywords.join(' · ')))
    }
    const boundary = create(document, 'div', 'cxm-notice', '当前阶段只提供发现与源码跳转，不会下载、执行、安装或激活这个插件。')
    boundary.dataset.tone = 'warning'
    detail.append(boundary)
    content.append(detail)
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
    content.append(create(document, 'div', 'cxm-section-title', '插件商店来源'))
    content.append(create(document, 'p', 'cxm-copy', '按优先级保存多个 marketplace JSON 地址。feed 地址只记录目录来源；插件唯一性由 canonical source 与小写 id 共同决定。'))

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
    content.append(form)
    if (sourceOperationError !== undefined) content.append(create(document, 'div', 'cxm-error', sourceOperationError))

    const sourceList = create(document, 'div', 'cxm-source-list')
    if (snapshot.sources.length === 0) sourceList.append(create(document, 'div', 'cxm-empty', '没有已配置商店；插件商店页会保持为空'))
    snapshot.sources.forEach((url, index) => {
      const state = snapshot.sourceStates[index]
      const row = create(document, 'div', 'cxm-source-row')
      row.append(create(document, 'span', 'cxm-source-index', String(index + 1)))
      const body = create(document, 'div', 'cxm-source-body')
      body.append(create(document, 'div', 'cxm-source-url', url))
      const status = create(document, 'div', 'cxm-source-state')
      const dot = create(document, 'span', 'cxm-status-dot')
      dot.dataset.status = state?.status ?? 'loading'
      const stateText = state?.status === 'loaded'
        ? `${state.name ?? '已验证 feed'} · ${state.pluginCount ?? 0} 个插件`
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
    content.append(sourceList)

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
    content.append(footerActions)
  }

  const renderRuntimeSettings = (): void => {
    content.append(create(document, 'div', 'cxm-section-title', '插件运行状态'))
    const runtime = model.snapshot()
    const blocked = runtime.plugins.filter(plugin => plugin.status === 'blocked' || plugin.status === 'failed')
    if (blocked.length === 0) {
      content.append(create(document, 'p', 'cxm-copy', '当前没有被 profile 本地状态屏蔽的插件。单个插件可在插件详情页屏蔽或恢复。'))
    } else {
      const list = create(document, 'div', 'cxm-source-list')
      for (const plugin of blocked) {
        const row = create(document, 'div', 'cxm-source-row')
        row.append(create(document, 'span', 'cxm-plugin-icon', initials(plugin.name)))
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
      content.append(list)
    }
    const boundary = create(document, 'div', 'cxm-notice', '屏蔽状态保存在当前隔离 Chromium profile，只控制已打包插件的 Cordis fiber；它不是卸载、权限隔离或 package 禁用。')
    boundary.dataset.tone = 'warning'
    content.append(boundary)
  }

  const renderLauncherSettings = (): void => {
    content.append(create(document, 'div', 'cxm-section-title', '启动器配置'))
    const launcherNotice = create(document, 'div', 'cxm-notice', '`cordisx.config.json` 仍负责 Codex 可执行文件、插件 composition 和插件配置。修改这些字段需要重新打包并启动新 generation，当前页面只读展示这条边界。')
    launcherNotice.dataset.tone = 'warning'
    content.append(launcherNotice)
  }

  const renderSettings = (): void => {
    setHeading('配置', '管理 CordisX 设置与当前 profile 状态', { icon: '⚙' })
    content.append(createLocalTabs(document, [
      { id: 'marketplace', label: '插件商店' },
      { id: 'runtime', label: '运行状态' },
      { id: 'launcher', label: '启动器' },
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
    if (secondaryView?.kind === 'plugin' && activeTab === 'plugins') {
      renderPluginDetail(snapshot, secondaryView.id)
      return
    }
    if (secondaryView?.kind === 'marketplace' && activeTab === 'marketplace') {
      renderMarketplaceDetail(secondaryView.identity)
      return
    }
    if (activeTab === 'about') renderAbout(snapshot)
    if (activeTab === 'slots') renderSlots(snapshot)
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
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) dismiss()
  })
  document.addEventListener('keydown', onKeydown)
  for (const [id, button] of navButtons) {
    button.addEventListener('click', () => {
      activeTab = id
      secondaryView = undefined
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
