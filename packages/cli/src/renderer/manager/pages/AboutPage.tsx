import type { ManagerSnapshot } from '../../manager.js'
import { AnimatedBrandMark } from '../../host-ui/BrandMark.js'
import { HostIcon } from '../../host-ui/HostIcon.js'
import type { ManagerIconToken } from '../../icons.js'
import { productLocale } from '../../ui-copy.js'
import type { ManagerRouter } from '../model/routes.js'

interface AboutCopy {
  readonly poweredBy: string
  readonly description: string
  readonly version: string
  readonly release: string
  readonly copyright: string
  readonly acknowledgements: string
  readonly opensInNewWindow: string
  readonly links: readonly (readonly [string, string, ManagerIconToken])[]
}

const ABOUT_COPY = {
  'zh-CN': {
    poweredBy: '由 Cordis 与 React 驱动',
    description: 'Codex Desktop 的实验性 UI 插件宿主',
    version: '版本',
    release: 'Beta 预览版 · AGPL-3.0-or-later',
    copyright: '© 2026 CordisX Contributors',
    acknowledgements: '致谢',
    opensInNewWindow: '在新窗口打开',
    links: [
      ['反馈问题', 'https://github.com/cordisx/cordisx/issues/new', 'diagnostics'],
      ['参与建设', 'https://github.com/cordisx/cordisx', 'plugins'],
      ['查看文档', 'https://cordisx.github.io/docs/', 'document'],
      ['项目主页', 'https://cordisx.github.io/', 'external-link'],
    ],
  },
  en: {
    poweredBy: 'Powered by Cordis & React',
    description: 'An experimental UI plugin host for Codex Desktop',
    version: 'Version',
    release: 'Beta preview · AGPL-3.0-or-later',
    copyright: '© 2026 CordisX Contributors',
    acknowledgements: 'Acknowledgements',
    opensInNewWindow: 'opens in a new window',
    links: [
      ['Report an issue', 'https://github.com/cordisx/cordisx/issues/new', 'diagnostics'],
      ['Contribute', 'https://github.com/cordisx/cordisx', 'plugins'],
      ['Documentation', 'https://cordisx.github.io/docs/', 'document'],
      ['Project website', 'https://cordisx.github.io/', 'external-link'],
    ],
  },
} as const satisfies Readonly<Record<'zh-CN' | 'en', AboutCopy>>

export function AboutPage({ snapshot, router }: { readonly snapshot: ManagerSnapshot; readonly router: ManagerRouter }) {
  const locale = productLocale(snapshot.localization.locale)
  const copy = ABOUT_COPY[locale]
  return <section className="cxr-page">
    <div className="cxr-about-identity">
      <AnimatedBrandMark />
      <div className="cxr-about-copy">
        <strong>CordisX</strong>
        <span className="cxr-about-powered">{copy.poweredBy}</span>
        <span>{copy.description}</span>
        <span>{copy.version} {snapshot.version}</span>
        <span className="cxr-about-release">{copy.release}</span>
        <span className="cxr-about-copyright">{copy.copyright}</span>
      </div>
    </div>
    <div className="cxr-list cxr-about-links">
      {copy.links.map(([label, href, icon]) => <a key={href} className="cxr-card" href={href} target="_blank" rel="noopener noreferrer" aria-label={locale === 'zh-CN' ? `${label}（${copy.opensInNewWindow}）` : `${label} (${copy.opensInNewWindow})`}><span className="cxr-card-icon"><HostIcon token={icon} /></span><span className="cxr-card-body"><span className="cxr-card-title">{label}</span></span><HostIcon token="external-link" /></a>)}
      <button type="button" className="cxr-card" onClick={() => router.navigate({ kind: 'about-acknowledgements' })}><span className="cxr-card-icon"><HostIcon token="contributions" /></span><span className="cxr-card-body"><span className="cxr-card-title">{copy.acknowledgements}</span></span><span className="cxr-card-arrow" aria-hidden="true">›</span></button>
    </div>
  </section>
}
