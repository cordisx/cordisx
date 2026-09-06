import { type HostCollectionStatus } from '.././host-collection.js'
import { createManagerIcon } from '.././icons.js'
import type { MarketplaceRankingExplanation } from '.././marketplace-ranking.js'
import type { MarketplaceCertificationRecord } from '.././marketplace-trust.js'
import { type MarketplaceStorage } from '.././marketplace.js'
import { managerCopy, productLocale } from '.././ui-copy.js'
import { create, markDecorative } from './dom.js'
import { LocalTabIcon, ManagerPluginSnapshot, ManagerPluginStatus } from './model.js'

export function createLocalTabs(
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
    visibleContent.append(
      createManagerIcon(document, item.icon, 'cxm-tab-icon'),
      create(document, 'span', undefined, item.label),
    )
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

export function createTabPanel(document: Document, label: string): HTMLDivElement {
  const panel = create(document, 'div', 'cxm-tab-panel')
  panel.setAttribute('role', 'tabpanel')
  panel.setAttribute('aria-label', label)
  return panel
}

export function createSectionTitle(document: Document, text: string): HTMLHeadingElement {
  return create(document, 'h3', 'cxm-section-title', text)
}

export function statusLabel(status: ManagerPluginStatus, locale: string): string {
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

export function formatConfig(config: unknown): string {
  try {
    return JSON.stringify(config, null, 2) ?? String(config)
  } catch {
    return '[unserializable config]'
  }
}

export function initials(name: string): string {
  const value = name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase() ?? '').join('')
  return value || 'CX'
}

export function createPluginIcon(document: Document, name: string, source?: string): HTMLSpanElement {
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

export function pluginStatusDescription(
  plugin: ManagerPluginSnapshot,
  status: ManagerPluginStatus,
  locale: string,
): string {
  const reason = status === 'failed' || status === 'rollback-failed'
    ? plugin.error
    : status === 'blocked' || status === 'permission-blocked'
    ? plugin.blockedReason ?? plugin.error
    : undefined
  const label = statusLabel(status, locale)
  if (reason === undefined) return label
  return productLocale(locale) === 'zh-CN' ? `${label}：${reason}` : `${label}: ${reason}`
}

export function pluginCollectionStatus(
  plugin: ManagerPluginSnapshot,
  status: ManagerPluginStatus,
  locale: string,
): HostCollectionStatus {
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

export function safeStorage(view: Window | null): MarketplaceStorage | undefined {
  try {
    return view?.localStorage
  } catch {
    return undefined
  }
}

export function normalizeManagerSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

export function matchesManagerSearch(query: string, fields: readonly string[]): boolean {
  const terms = normalizeManagerSearchText(query).split(' ').filter(Boolean)
  const haystack = normalizeManagerSearchText(fields.join('\n'))
  return terms.every(term => haystack.includes(term))
}

export function marketplaceTextTierLabel(tier: MarketplaceRankingExplanation['textTier']): string {
  switch (tier) {
    case 'exact-identity':
      return '插件标识精确命中'
    case 'exact-name':
      return '插件名称精确命中'
    case 'primary-prefix':
      return '插件标识或名称前缀命中'
    case 'all-primary-terms':
      return '插件标识或名称完整词项命中'
    case 'all-catalog-terms':
      return '目录元数据完整词项命中'
    case 'partial-catalog':
      return '目录元数据部分词项命中'
    case 'browse':
      return '无关键词浏览'
  }
}

export function marketplaceRankingDescription(ranking: MarketplaceRankingExplanation): string {
  return `排序依据：${
    marketplaceTextTierLabel(ranking.textTier)
  }；官方产品优先级 +${ranking.officialPriority}。官方优先级只在同一文本相关性层级内生效；认证状态不参与排序。`
}

export function marketplaceCertifiedDetailCopy(
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

export function activateManagerListRow(row: HTMLButtonElement, action: () => void): void {
  row.addEventListener('click', event => {
    const selection = row.ownerDocument.defaultView?.getSelection()
    if (
      event.detail > 0 && selection !== undefined && selection !== null && !selection.isCollapsed
      && selection.toString() !== ''
      && selection.anchorNode !== null && selection.focusNode !== null
      && row.contains(selection.anchorNode) && row.contains(selection.focusNode)
    ) return
    action()
  })
  row.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    action()
  })
}
