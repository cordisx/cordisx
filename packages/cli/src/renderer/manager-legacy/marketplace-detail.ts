import { type CordisXIconToken } from '../../contracts.js'
import { createManagerIcon, type ManagerIconToken } from '.././icons.js'
import { type MarketplaceCatalogPlugin, type MarketplaceModel, projectMarketplacePlugin } from '.././marketplace.js'
import { managerCopy, productLocale } from '.././ui-copy.js'
import { PublisherGrantClient } from './bridges.js'
import { create } from './dom.js'
import { LocalTabIcon, ManagerRouteState, ManagerSnapshot, MarketplaceDetailTab } from './model.js'
import { LocalizedTab, MARKETPLACE_DETAIL_TABS } from './presentation.js'
import { createLocalTabs, createSectionTitle, createTabPanel, marketplaceCertifiedDetailCopy } from './widgets.js'

export interface MarketplaceDetailDependencies {
  marketplace: MarketplaceModel
  setHeading: (
    headingCopy: string | undefined,
    snapshot: ManagerSnapshot,
    options?: { readonly icon?: ManagerIconToken | CordisXIconToken; readonly brand?: boolean },
  ) => void
  copy: (key: Parameters<typeof managerCopy>[1]) => string
  content: HTMLDivElement
  document: Document
  routeState: ManagerRouteState
  localizeTabs: <T extends string>(
    items: readonly LocalizedTab<T>[],
  ) => readonly { readonly id: T; readonly label: string; readonly icon: LocalTabIcon }[]
  navigateRoute: (
    target: ManagerRouteState,
    options?: { readonly recordHistory?: boolean; readonly restoreFocus?: boolean },
  ) => Promise<void>
  configureExternalLink: <T extends HTMLAnchorElement>(link: T, href: string) => T
  refreshPublisherGrantStatus: (plugin: MarketplaceCatalogPlugin) => Promise<void>
  publisherGrantStatuses: Map<string, string>
  publisherGrantClient: PublisherGrantClient
  renderContent: () => void
}

/** Dependencies are live views of installation-owned state; this module owns no duplicate lifecycle. */
export function createMarketplaceDetail(dependencies: MarketplaceDetailDependencies) {
  const renderMarketplaceDetail = (managerSnapshot: ManagerSnapshot, identityValue: string): void => {
    const plugin = dependencies.marketplace.snapshot().plugins.find(item => item.identity === identityValue)
    dependencies.setHeading(dependencies.copy('plugins.heading'), managerSnapshot)
    if (plugin === undefined) {
      dependencies.content.append(create(dependencies.document, 'div', 'cxm-empty', '该插件已不在当前聚合结果中'))
      return
    }
    const metadata = projectMarketplacePlugin(plugin, managerSnapshot.localization.locale)
    const chinese = productLocale(managerSnapshot.localization.locale) === 'zh-CN'
    const activeFacet = dependencies.routeState.kind === 'marketplace' ? dependencies.routeState.facet : 'overview'
    dependencies.content.append(
      createLocalTabs(
        dependencies.document,
        dependencies.localizeTabs(MARKETPLACE_DETAIL_TABS),
        activeFacet,
        'data-marketplace-detail-tab',
        (tab) => {
          void dependencies.navigateRoute({
            kind: 'marketplace',
            identity: identityValue,
            facet: tab as MarketplaceDetailTab,
          })
        },
      ),
    )

    if (activeFacet === 'overview') {
      const panel = createTabPanel(dependencies.document, dependencies.copy('marketplace-tab.overview'))
      panel.append(create(dependencies.document, 'p', 'cxm-detail-description', metadata.description))
      const fields = create(dependencies.document, 'div', 'cxm-detail-grid')
      for (
        const [label, value] of [
          ['版本', `v${plugin.version}`],
          ['CordisX 兼容范围', plugin.compatibility.cordisx],
          ['许可证', plugin.license],
          ['插件标识', plugin.id],
        ]
      ) {
        const field = create(dependencies.document, 'div', 'cxm-field')
        field.append(
          create(dependencies.document, 'div', 'cxm-field-label', label),
          create(dependencies.document, 'div', 'cxm-field-value', value),
        )
        fields.append(field)
      }
      panel.append(fields)
      if (plugin.official !== undefined || plugin.certification !== undefined) {
        panel.append(
          createSectionTitle(
            dependencies.document,
            chinese ? 'Marketplace 身份与审核信息' : 'Marketplace identity and review information',
          ),
        )
        const trustList = create(dependencies.document, 'div', 'cxm-marketplace-trust-list')
        const appendEvidence = (target: HTMLElement, href: string): void => {
          const evidence = dependencies.configureExternalLink(
            create(dependencies.document, 'a', 'cxm-action cxm-marketplace-trust-evidence'),
            href,
          )
          evidence.append(
            create(
              dependencies.document,
              'span',
              undefined,
              chinese ? '查看受保护审核证据' : 'View protected review evidence',
            ),
            createManagerIcon(dependencies.document, 'external-link', 'cxm-action-icon'),
          )
          target.append(evidence)
        }
        if (plugin.official !== undefined) {
          const official = plugin.official
          const item = create(dependencies.document, 'section', 'cxm-marketplace-trust-item')
          item.dataset.marketplaceTrustDimension = 'official'
          const title = create(dependencies.document, 'div', 'cxm-marketplace-trust-title')
          title.append(
            createManagerIcon(dependencies.document, 'marketplace-official'),
            create(dependencies.document, 'span', undefined, chinese ? '官方' : 'Official'),
          )
          item.append(
            title,
            create(
              dependencies.document,
              'p',
              'cxm-marketplace-trust-copy',
              `${official.label.fallback}。${official.description.fallback}`,
            ),
            create(
              dependencies.document,
              'p',
              'cxm-marketplace-trust-copy',
              chinese
                ? '“官方”表示该插件由 CordisX 团队通过受信任发布者、源码仓库与包命名空间创建并持续维护。它只影响 Marketplace 身份、筛选和同等相关性内的产品排序；不会改变 PermissionBroker 决策，也不自动等于“已认证”。'
                : 'Official means CordisX creates and maintains this plugin through a trusted publisher, source repository, and package namespace. It affects Marketplace identity, filters, and ordering among equally relevant results only. It never changes PermissionBroker decisions or automatically means Certified.',
            ),
          )
          appendEvidence(item, official.reviewer.evidenceRef)
          trustList.append(item)
        }
        if (plugin.certification !== undefined) {
          const certification = plugin.certification
          const [reviewSummary, permissionBoundary, trustRootBoundary] = marketplaceCertifiedDetailCopy(
            certification,
            plugin.version,
            chinese,
          )
          const item = create(dependencies.document, 'section', 'cxm-marketplace-trust-item')
          item.dataset.marketplaceTrustDimension = 'certified'
          const title = create(dependencies.document, 'div', 'cxm-marketplace-trust-title')
          title.append(
            createManagerIcon(dependencies.document, 'marketplace-certified'),
            create(dependencies.document, 'span', undefined, chinese ? '已认证' : 'Certified'),
          )
          item.append(
            title,
            create(
              dependencies.document,
              'p',
              'cxm-marketplace-trust-copy',
              `${certification.label.fallback}。${certification.description.fallback}`,
            ),
            create(dependencies.document, 'p', 'cxm-marketplace-trust-copy', reviewSummary),
            create(dependencies.document, 'p', 'cxm-marketplace-trust-copy', permissionBoundary),
            create(dependencies.document, 'p', 'cxm-marketplace-trust-copy', trustRootBoundary),
          )
          appendEvidence(item, certification.reviewer.evidenceRef)
          trustList.append(item)
        }
        panel.append(trustList)
        const boundary = create(
          dependencies.document,
          'div',
          'cxm-notice',
          chinese ? '认证不是绝对安全保证。' : 'Certification is not an absolute safety guarantee.',
        )
        boundary.dataset.marketplaceTrustBoundary = 'true'
        panel.append(boundary)
      }
      if (metadata.keywords.length > 0) {
        panel.append(createSectionTitle(dependencies.document, '关键词'))
        panel.append(create(dependencies.document, 'p', 'cxm-copy', metadata.keywords.join(' · ')))
      }
      if (plugin.commerce !== undefined) {
        void dependencies.refreshPublisherGrantStatus(plugin)
        panel.append(createSectionTitle(dependencies.document, '开发者授权'))
        const commerce = create(dependencies.document, 'section', 'cxm-marketplace-trust-item')
        commerce.dataset.publisherGrant = plugin.id
        const current = dependencies.publisherGrantStatuses.get(plugin.identity)
        const label = current === 'authorized'
          ? '已授权'
          : current === 'refresh-due'
          ? '即将到期'
          : current === 'grace'
          ? '离线宽限期'
          : current === 'expired'
          ? '已过期'
          : current === 'device-mismatch'
          ? '设备不匹配'
          : current === 'revoked'
          ? '已撤销'
          : current === 'invalid-signature'
          ? '签名无效'
          : current === 'loading'
          ? '正在检查授权…'
          : '未授权'
        commerce.append(create(dependencies.document, 'p', 'cxm-marketplace-trust-copy', `授权状态：${label}`))
        commerce.append(
          create(
            dependencies.document,
            'p',
            'cxm-marketplace-trust-copy',
            'CordisX 只验证开发者签名的授权声明。付款、退款和售后由开发者负责。',
          ),
        )
        const actions = create(dependencies.document, 'div', 'cxm-manager-inline-actions')
        const purchase = create(dependencies.document, 'button', 'cxm-action')
        purchase.type = 'button'
        purchase.dataset.publisherGrantPurchase = plugin.id
        purchase.append(
          create(dependencies.document, 'span', undefined, '前往开发者购买'),
          createManagerIcon(dependencies.document, 'external-link', 'cxm-action-icon'),
        )
        purchase.addEventListener('click', () => {
          void (async () => {
            try {
              const challenge = await dependencies.publisherGrantClient.request('challenge')
              const href = new URL(plugin.commerce!.purchaseUrl)
              href.searchParams.set(
                'cordisxDeviceChallenge',
                btoa(
                  unescape(encodeURIComponent(JSON.stringify(challenge))).replaceAll('+', '-').replaceAll('/', '_')
                    .replaceAll('=', ''),
                ),
              )
              dependencies.document.defaultView?.open(href.href, '_blank', 'noopener,noreferrer')
            } catch {
              dependencies.publisherGrantStatuses.set(plugin.identity, 'unavailable')
              dependencies.renderContent()
            }
          })()
        })
        const copyChallenge = create(dependencies.document, 'button', 'cxm-action')
        copyChallenge.type = 'button'
        copyChallenge.dataset.publisherGrantChallenge = plugin.id
        copyChallenge.append(create(dependencies.document, 'span', undefined, '复制设备挑战'))
        copyChallenge.addEventListener('click', () => {
          void (async () => {
            try {
              const challenge = await dependencies.publisherGrantClient.request('challenge')
              await dependencies.document.defaultView?.navigator.clipboard?.writeText(JSON.stringify(challenge))
              copyChallenge.replaceChildren('已复制')
            } catch {
              copyChallenge.replaceChildren('设备密钥不可用')
            }
          })()
        })
        const importGrant = create(dependencies.document, 'button', 'cxm-action')
        importGrant.type = 'button'
        importGrant.dataset.publisherGrantImport = plugin.id
        importGrant.append(create(dependencies.document, 'span', undefined, '导入授权声明'))
        importGrant.addEventListener('click', () => {
          const input = create(dependencies.document, 'input') as HTMLInputElement
          input.type = 'file'
          input.accept = 'application/json,.json'
          input.hidden = true
          input.addEventListener('change', () => {
            void (async () => {
              const file = input.files?.[0]
              if (file === undefined) return
              try {
                const result = await dependencies.publisherGrantClient.request(
                  'import',
                  JSON.parse(await file.text()),
                ) as {
                  status?: unknown
                }
                dependencies.publisherGrantStatuses.set(
                  plugin.identity,
                  typeof result?.status === 'string' ? result.status : 'unavailable',
                )
              } catch {
                dependencies.publisherGrantStatuses.set(plugin.identity, 'invalid-signature')
              }
              input.remove()
              dependencies.renderContent()
            })()
          }, { once: true })
          dependencies.document.body?.append(input)
          input.click()
        })
        const importClipboard = create(dependencies.document, 'button', 'cxm-action')
        importClipboard.type = 'button'
        importClipboard.dataset.publisherGrantClipboard = plugin.id
        importClipboard.append(create(dependencies.document, 'span', undefined, '从剪贴板导入'))
        importClipboard.addEventListener('click', () => {
          void (async () => {
            try {
              const text = await dependencies.document.defaultView?.navigator.clipboard?.readText()
              const result = await dependencies.publisherGrantClient.request('import', JSON.parse(text ?? '')) as {
                status?: unknown
              }
              dependencies.publisherGrantStatuses.set(
                plugin.identity,
                typeof result?.status === 'string' ? result.status : 'unavailable',
              )
            } catch {
              dependencies.publisherGrantStatuses.set(plugin.identity, 'invalid-signature')
            }
            dependencies.renderContent()
          })()
        })
        actions.append(purchase, copyChallenge, importGrant, importClipboard)
        if (plugin.commerce.manageUrl !== undefined) {
          const manage = dependencies.configureExternalLink(
            create(dependencies.document, 'a', 'cxm-action'),
            plugin.commerce.manageUrl,
          )
          manage.append('管理授权')
          actions.append(manage)
        }
        if (plugin.commerce.recoveryUrl !== undefined) {
          const recover = dependencies.configureExternalLink(
            create(dependencies.document, 'a', 'cxm-action'),
            plugin.commerce.recoveryUrl,
          )
          recover.append('恢复授权')
          actions.append(recover)
        }
        commerce.append(actions)
        panel.append(commerce)
      }
      dependencies.content.append(panel)
      return
    }

    const panel = createTabPanel(dependencies.document, dependencies.copy('marketplace-tab.authors-source'))
    const links = create(dependencies.document, 'div', 'cxm-link-list')
    links.setAttribute('role', 'list')
    const appendLink = (label: string, value: string, href: string): void => {
      const row = create(dependencies.document, 'div', 'cxm-link-row')
      row.setAttribute('role', 'listitem')
      const copy = create(dependencies.document, 'div', 'cxm-link-row-copy')
      copy.append(
        create(dependencies.document, 'div', 'cxm-link-row-title', label),
        create(dependencies.document, 'code', 'cxm-link-row-value', value),
      )
      const link = dependencies.configureExternalLink(create(dependencies.document, 'a', 'cxm-action'), href)
      link.append(
        create(dependencies.document, 'span', undefined, '打开'),
        createManagerIcon(dependencies.document, 'external-link', 'cxm-action-icon'),
      )
      row.append(copy, link)
      links.append(row)
    }
    for (const author of metadata.authors) {
      if (author.url === undefined) {
        const row = create(dependencies.document, 'div', 'cxm-link-row')
        row.setAttribute('role', 'listitem')
        row.append(create(dependencies.document, 'div', 'cxm-link-row-title', `作者 · ${author.name}`))
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
    dependencies.content.append(panel)
  }
  return { renderMarketplaceDetail }
}
