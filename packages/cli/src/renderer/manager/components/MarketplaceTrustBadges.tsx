import type { MarketplaceCatalogPlugin } from '../../marketplace.js'
import { HostIcon } from '../../host-ui/HostIcon.js'
import { productLocale } from '../../ui-copy.js'

const COPY = {
  'zh-CN': {
    official: '官方',
    certified: '已认证',
    officialTooltip: '由 CordisX 团队创建并持续维护的发布者身份；只影响 Marketplace 身份、筛选与排序，不改变权限。',
    certifiedTooltip: 'CordisX 已按审核策略检查当前版本的明确制品；不参与 Marketplace 排序，也不代表绝对安全。',
  },
  en: {
    official: 'Official',
    certified: 'Certified',
    officialTooltip:
      'Publisher identity created and maintained by CordisX. It affects Marketplace identity, filters, and ordering only, never permissions.',
    certifiedTooltip:
      'CordisX reviewed this exact versioned artifact under the stated policy. It does not affect Marketplace ordering or guarantee absolute safety.',
  },
} as const

export function marketplaceTrustLabels(
  plugin: Pick<MarketplaceCatalogPlugin, 'official' | 'certification'>,
  locale: string,
): readonly string[] {
  const copy = COPY[productLocale(locale)]
  return [
    ...(plugin.official === undefined ? [] : [copy.official]),
    ...(plugin.certification === undefined ? [] : [copy.certified]),
  ]
}

export function MarketplaceTrustBadges({ plugin, locale }: {
  readonly plugin: Pick<MarketplaceCatalogPlugin, 'official' | 'certification'>
  readonly locale: string
}) {
  const copy = COPY[productLocale(locale)]
  if (plugin.official === undefined && plugin.certification === undefined) return null
  return (
    <span className="cxr-marketplace-trust-badges">
      {plugin.official === undefined
        ? null
        : (
          <span
            className="cxr-marketplace-trust-badge"
            data-trust-dimension="official"
            role="img"
            aria-label={`${copy.official}：${copy.officialTooltip}`}
            title={copy.officialTooltip}
          >
            <HostIcon token="marketplace-official" />
            <span>{copy.official}</span>
          </span>
        )}
      {plugin.certification === undefined
        ? null
        : (
          <span
            className="cxr-marketplace-trust-badge"
            data-trust-dimension="certified"
            role="img"
            aria-label={`${copy.certified}：${copy.certifiedTooltip}`}
            title={copy.certifiedTooltip}
          >
            <HostIcon token="marketplace-certified" />
            <span>{copy.certified}</span>
          </span>
        )}
    </span>
  )
}
