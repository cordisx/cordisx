import { useEffect, useState } from 'react'
import { projectPermissionCapabilityName } from '../../../permission-locales.js'
import { projectMarketplacePlugin, type MarketplaceModel } from '../../marketplace.js'
import type { ManagerSnapshot } from '../../manager.js'
import { HostIcon } from '../../host-ui/HostIcon.js'
import { IconButton } from '../../host-ui/IconButton.js'
import { SearchField } from '../../host-ui/SearchField.js'
import { productLocale } from '../../ui-copy.js'
import { ManagerTabs, type ManagerTab } from '../components/ManagerTabs.js'
import { MarkdownDocument } from '../components/MarkdownDocument.js'
import { readMarketplaceFavorites, writeMarketplaceFavorites } from '../model/marketplace-favorites.js'
import { useMarketplaceSnapshot } from '../model/marketplace-store.js'
import type { ManagerRouter } from '../model/routes.js'
import { MarketplaceTrustBadges, marketplaceTrustLabels } from '../components/MarketplaceTrustBadges.js'

type MarketplaceDetailTab = 'readme' | 'permissions' | 'authors-source'

const COPY = {
  'zh-CN': {
    tabs: { readme: 'README', permissions: '所需权限', authorsSource: '作者与来源' },
    installed: '已安装', install: '安装', installedDescription: '当前版本已经安装', installUnavailable: '当前 Host 尚未发布商店安装服务',
    favorite: '收藏', unfavorite: '取消收藏', noReadme: '该商店记录没有提供 README；安装后可在插件详情中查看随包文档。',
    noPermissions: '该插件未声明平台权限', permissionsUnavailable: '该商店记录尚未提供可预览的权限清单；安装前 Host 会显示最终权限授权步骤。',
    searchPermissions: '搜索权限、申请理由或类型…', searchPermissionsLabel: '搜索插件权限', noMatchingPermissions: '没有匹配的权限',
    version: '版本', compatibility: '兼容性', license: '许可证', source: '插件源码', homepage: '插件主页', feed: '商店来源', author: '作者',
    opensInNewWindow: '在新窗口打开', missing: '插件目录记录已不存在', required: '必需', optional: '可选',
    identityLabel: '插件信息与操作', detailsLabel: 'Marketplace 身份与审核信息', official: '官方', certified: '已认证', evidence: '查看受保护审核证据',
    officialSummary: '“官方”表示该插件由 CordisX 团队通过受信任发布者、源码仓库与包命名空间创建并持续维护。它只影响 Marketplace 身份、筛选和同等相关性内的产品排序；不会改变 PermissionBroker 决策，也不自动等于“已认证”。',
    certifiedSummary: 'CordisX 已按策略 {policy} 审核当前 {version} 版本的明确制品，并认定其代码符合该版本策略。新版本或制品摘要变化后必须重新认证。',
    certifiedBoundary: '认证不是绝对安全保证，也不放宽沙箱、生命周期或安装审核。仅权限目录明确标记的界面能力可免去显式确认；Host 仍会按当前范围和运行实例创建可撤销、可审计的授权，其他权限照常确认。',
    mergeChain: 'v1 信任根是受保护的 Marketplace 合入链；当前不声称存在制品密码学签名。',
    fallbackDescription: '审核记录说明',
  },
  en: {
    tabs: { readme: 'README', permissions: 'Permissions', authorsSource: 'Authors & source' },
    installed: 'Installed', install: 'Install', installedDescription: 'This version is already installed', installUnavailable: 'This Host has not published Marketplace installation yet',
    favorite: 'Favorite', unfavorite: 'Remove favorite', noReadme: 'This catalog record does not provide a README. Packaged documentation appears after installation.',
    noPermissions: 'This plugin declares no platform permissions', permissionsUnavailable: 'This catalog record does not expose a permission preview. The Host will show the final authorization step before installation.',
    searchPermissions: 'Search permissions, request reasons, or type…', searchPermissionsLabel: 'Search plugin permissions', noMatchingPermissions: 'No matching permissions',
    version: 'Version', compatibility: 'Compatibility', license: 'License', source: 'Source', homepage: 'Homepage', feed: 'Marketplace source', author: 'Author',
    opensInNewWindow: 'opens in a new window', missing: 'This Marketplace record no longer exists', required: 'Required', optional: 'Optional',
    identityLabel: 'Plugin information and actions', detailsLabel: 'Marketplace identity and review information', official: 'Official', certified: 'Certified', evidence: 'View protected review evidence',
    officialSummary: 'Official means CordisX creates and maintains this plugin through a trusted publisher, source repository, and package namespace. It affects Marketplace identity, filters, and product ordering among equally relevant results only. It never changes PermissionBroker decisions or automatically means Certified.',
    certifiedSummary: 'CordisX reviewed the exact {version} artifact under policy {policy} and determined that its code conforms to that policy version. A new version or artifact digest requires a new certification.',
    certifiedBoundary: 'Certification is not an absolute safety guarantee and does not relax sandbox, lifecycle, or installation review. Only interface capabilities explicitly marked in the permission catalog may omit explicit confirmation. The Host still creates a revocable, audited authorization for the current scope and runtime instance; every other permission prompts normally.',
    mergeChain: 'The v1 trust root is the protected Marketplace merge chain; no cryptographic artifact signature is claimed.',
    fallbackDescription: 'Review record description',
  },
} as const

function tabs(locale: 'zh-CN' | 'en'): readonly ManagerTab<MarketplaceDetailTab>[] {
  const copy = COPY[locale].tabs
  return [
    { id: 'readme', label: copy.readme, icon: 'document' },
    { id: 'permissions', label: copy.permissions, icon: 'permissions' },
    { id: 'authors-source', label: copy.authorsSource, icon: 'authors-source' },
  ]
}

export function MarketplacePluginPage({ marketplace, snapshot: managerSnapshot, router }: {
  readonly marketplace: MarketplaceModel
  readonly snapshot: ManagerSnapshot
  readonly router: ManagerRouter
}) {
  const [tab, setTab] = useState<MarketplaceDetailTab>('readme')
  const [permissionQuery, setPermissionQuery] = useState('')
  const [favorites, setFavorites] = useState(readMarketplaceFavorites)
  const route = router.route
  const snapshot = useMarketplaceSnapshot(marketplace)
  const identity = route.kind === 'marketplace-plugin' ? route.identity : undefined
  useEffect(() => { setTab('readme'); setPermissionQuery('') }, [identity])
  if (identity === undefined) return null
  const plugin = snapshot.plugins.find(item => item.identity === identity)
  const locale = productLocale(managerSnapshot.localization.locale)
  const copy = COPY[locale]
  if (plugin === undefined) return <div className="cxr-empty">{copy.missing}</div>
  const projection = projectMarketplacePlugin(plugin, managerSnapshot.localization.locale)
  const installed = managerSnapshot.plugins.find(item => item.id === plugin.id)
  const permissions = installed === undefined ? [] : managerSnapshot.permissions.filter(item => item.identity.id === installed.id && item.identity.source === installed.source)
  const permissionName = (capability: typeof permissions[number]['capability']): string => projectPermissionCapabilityName(capability, managerSnapshot.localization.locale)
  const normalizedPermissionQuery = permissionQuery.trim().toLocaleLowerCase()
  const visiblePermissions = normalizedPermissionQuery.length === 0 ? permissions : permissions.filter(item =>
    [permissionName(item.capability), item.capability, item.reasonText, item.required ? copy.required : copy.optional]
      .some(value => value.toLocaleLowerCase().includes(normalizedPermissionQuery)))
  const favorite = favorites.has(plugin.identity)
  const trustLabels = marketplaceTrustLabels(plugin, managerSnapshot.localization.locale)
  const toggleFavorite = () => {
    setFavorites(current => {
      const next = new Set(current)
      if (next.has(plugin.identity)) next.delete(plugin.identity); else next.add(plugin.identity)
      writeMarketplaceFavorites(next)
      return next
    })
  }
  const externalLabel = (label: string): string => locale === 'zh-CN' ? `${label}（${copy.opensInNewWindow}）` : `${label} (${copy.opensInNewWindow})`
  const links = [
    ...projection.authors.flatMap(author => author.url === undefined ? [] : [{ label: `${copy.author} · ${author.name}`, value: author.url, href: author.url }]),
    { label: copy.source, value: plugin.source, href: plugin.source },
    ...(plugin.homepage === undefined ? [] : [{ label: copy.homepage, value: plugin.homepage, href: plugin.homepage }]),
    { label: `${copy.feed} · ${projection.feedName}`, value: plugin.feedUrl, href: plugin.feedUrl },
  ]

  const certifiedSummary = plugin.certification === undefined ? undefined : copy.certifiedSummary
    .replace('{policy}', `${plugin.certification.reviewPolicy.id} ${plugin.certification.reviewPolicy.version}`)
    .replace('{version}', plugin.version)

  return <section className="cxr-page" data-marketplace-plugin-detail={plugin.id}>
    <section className="cxr-plugin-identity cxr-marketplace-identity" aria-label={[copy.identityLabel, ...trustLabels].join(' · ')}>
      <span className="cxr-card-icon">{plugin.icon === undefined ? projection.name.slice(0, 2).toLocaleUpperCase() : <img src={plugin.icon} alt="" referrerPolicy="no-referrer" />}</span>
      <span className="cxr-plugin-identity-copy">
        <span className="cxr-marketplace-title-row"><strong>{projection.name}</strong><MarketplaceTrustBadges plugin={plugin} locale={managerSnapshot.localization.locale} /></span>
        <span className="cxr-plugin-identity-description">{projection.description}</span>
        <span className="cxr-plugin-identity-meta"><span>{plugin.version}</span><code>{plugin.id}</code><span>{projection.feedName}</span></span>
      </span>
      <span className="cxr-plugin-identity-actions">
        <IconButton icon="import-plugin" label={installed === undefined ? copy.install : copy.installed} description={installed === undefined ? copy.installUnavailable : copy.installedDescription} disabled />
        <IconButton icon={favorite ? 'favorite-active' : 'favorite'} label={favorite ? copy.unfavorite : copy.favorite} aria-pressed={favorite} onClick={toggleFavorite} />
      </span>
    </section>
    {plugin.official === undefined && plugin.certification === undefined ? null : <section className="cxr-marketplace-trust-details" aria-label={copy.detailsLabel}>
      {plugin.official === undefined ? null : <div data-marketplace-trust-dimension="official">
        <h3><HostIcon token="marketplace-official" />{copy.official}</h3>
        <p>{copy.officialSummary}</p>
        <p><span className="cxr-marketplace-trust-record-label">{copy.fallbackDescription}：</span>{plugin.official.description.fallback}</p>
        <a href={plugin.official.reviewer.evidenceRef} target="_blank" rel="noopener noreferrer">{copy.evidence}<HostIcon token="external-link" /></a>
      </div>}
      {plugin.certification === undefined ? null : <div data-marketplace-trust-dimension="certified">
        <h3><HostIcon token="marketplace-certified" />{copy.certified}</h3>
        <p>{certifiedSummary}</p>
        <p><span className="cxr-marketplace-trust-record-label">{copy.fallbackDescription}：</span>{plugin.certification.description.fallback}</p>
        <p>{copy.certifiedBoundary}</p>
        <p>{copy.mergeChain}</p>
        <a href={plugin.certification.reviewer.evidenceRef} target="_blank" rel="noopener noreferrer">{copy.evidence}<HostIcon token="external-link" /></a>
      </div>}
    </section>}
    <ManagerTabs label="插件商店详情" tabs={tabs(locale)} value={tab} onChange={setTab} />
    {tab === 'readme' && <div role="tabpanel" aria-label={copy.tabs.readme}>{installed?.readme === undefined ? <div className="cxr-empty">{copy.noReadme}</div> : <MarkdownDocument source={installed.readme} />}</div>}
    {tab === 'permissions' && <div role="tabpanel" aria-label={copy.tabs.permissions}>
      <SearchField className="cxr-search" value={permissionQuery} aria-label={copy.searchPermissionsLabel} placeholder={copy.searchPermissions} onChange={setPermissionQuery} />
      <div className="cxr-list cxr-permission-list" role="list">
        {visiblePermissions.map(item => <article className="cxr-card cxr-permission-summary" role="listitem" key={item.capability}><span className="cxr-card-icon"><HostIcon token="permissions" /></span><span className="cxr-card-body"><span className="cxr-card-title">{permissionName(item.capability)}</span><span className="cxr-card-description">{item.reasonText}</span><code className="cxr-card-code">{item.capability}</code></span><span className="cxr-status">{item.required ? copy.required : copy.optional}</span></article>)}
        {permissions.length === 0 ? <div className="cxr-empty">{installed === undefined ? copy.permissionsUnavailable : copy.noPermissions}</div> : visiblePermissions.length === 0 ? <div className="cxr-empty">{copy.noMatchingPermissions}</div> : null}
      </div>
    </div>}
    {tab === 'authors-source' && <div role="tabpanel" aria-label={copy.tabs.authorsSource}>
      <div className="cxr-marketplace-detail-grid">
        <section className="cxr-metric"><span>{copy.version}</span><strong>{plugin.version}</strong></section>
        <section className="cxr-metric"><span>{copy.compatibility}</span><strong>{plugin.compatibility.cordisx}</strong></section>
        <section className="cxr-metric"><span>{copy.license}</span><strong>{plugin.license}</strong></section>
        {links.map(link => <a key={`${link.label}:${link.href}`} className="cxr-card cxr-marketplace-source-link" href={link.href} target="_blank" rel="noopener noreferrer" aria-label={externalLabel(link.label)}><span className="cxr-card-icon"><HostIcon token="authors-source" /></span><span className="cxr-card-body"><span className="cxr-card-title">{link.label}</span><code className="cxr-card-code">{link.value}</code></span><HostIcon token="external-link" /></a>)}
      </div>
    </div>}
  </section>
}
