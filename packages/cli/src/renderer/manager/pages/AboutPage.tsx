import { useMemo, useState } from 'react'
import type { ManagerModel, ManagerSnapshot } from '../../manager.js'
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
  readonly iconTheme: string
  readonly iconThemeDescription: string
  readonly iconThemeProvider: string
  readonly iconThemeUnavailable: string
  readonly iconThemeError: string
  readonly statuses: Readonly<Record<string, string>>
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
    iconTheme: '图标主题',
    iconThemeDescription: '选择 Reicon 或已注册主题提供方；更改会立即应用到当前配置。',
    iconThemeProvider: '图标主题提供方',
    iconThemeUnavailable: '当前运行环境不支持保存图标主题选择。',
    iconThemeError: '未能保存图标主题，已恢复安全默认值。',
    statuses: { active: '使用中', ready: '可用', staged: '准备中', retiring: '正在卸载', failed: '不可用', disposed: '已卸载' },
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
    iconTheme: 'Icon theme',
    iconThemeDescription: 'Choose Reicon or a registered theme provider. Changes apply immediately to this profile.',
    iconThemeProvider: 'Icon theme provider',
    iconThemeUnavailable: 'Icon theme preferences cannot be saved in this runtime.',
    iconThemeError: 'The icon theme could not be saved. The safe default was restored.',
    statuses: { active: 'Active', ready: 'Available', staged: 'Preparing', retiring: 'Unloading', failed: 'Unavailable', disposed: 'Disposed' },
    links: [
      ['Report an issue', 'https://github.com/cordisx/cordisx/issues/new', 'diagnostics'],
      ['Contribute', 'https://github.com/cordisx/cordisx', 'plugins'],
      ['Documentation', 'https://cordisx.github.io/docs/', 'document'],
      ['Project website', 'https://cordisx.github.io/', 'external-link'],
    ],
  },
} as const satisfies Readonly<Record<'zh-CN' | 'en', AboutCopy>>

function safeProviderName(provider: NonNullable<ManagerSnapshot['iconThemes']>['providers'][number]): string {
  if (provider.providerId === 'builtin:reicon') return 'Reicon'
  return provider.namespace.split(/[._-]+/u).filter(Boolean).map(part => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join(' ')
}

export function AboutPage({ model, snapshot, router }: { readonly model: ManagerModel; readonly snapshot: ManagerSnapshot; readonly router: ManagerRouter }) {
  const locale = productLocale(snapshot.localization.locale)
  const copy = ABOUT_COPY[locale]
  const [changingTheme, setChangingTheme] = useState(false)
  const [themeError, setThemeError] = useState(false)
  const providers = snapshot.iconThemes?.providers ?? []
  const options = useMemo(() => providers.map((provider, index) => ({ provider, token: `theme-${index}` })), [providers])
  const selectedToken = options.find(({ provider }) => provider.providerId === snapshot.iconThemes?.selected.providerId
    && provider.namespace === snapshot.iconThemes.selected.namespace
    && provider.providerVersion === snapshot.iconThemes.selected.providerVersion
    && provider.providerGeneration === snapshot.iconThemes.selected.providerGeneration)?.token ?? ''
  const selectTheme = async (token: string): Promise<void> => {
    const option = options.find(item => item.token === token)
    if (option === undefined || snapshot.iconThemes === undefined || model.selectIconTheme === undefined || model.iconThemePreferenceWritable !== true) return
    setChangingTheme(true)
    setThemeError(false)
    try {
      await model.selectIconTheme(snapshot.iconThemes.profileRevision, option.provider)
    } catch {
      setThemeError(true)
    } finally {
      setChangingTheme(false)
    }
  }
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
    {snapshot.iconThemes === undefined ? null : <section className="cxr-icon-theme" aria-labelledby="cxr-icon-theme-title" data-host-icon-theme-picker="true">
      <div className="cxr-icon-theme-copy">
        <h3 id="cxr-icon-theme-title">{copy.iconTheme}</h3>
        <p>{copy.iconThemeDescription}</p>
      </div>
      <label htmlFor="cxr-icon-theme-provider">{copy.iconThemeProvider}</label>
      <select
        id="cxr-icon-theme-provider"
        value={selectedToken}
        disabled={changingTheme || model.selectIconTheme === undefined || model.iconThemePreferenceWritable !== true}
        aria-busy={changingTheme || undefined}
        onChange={event => { void selectTheme(event.currentTarget.value) }}
      >
        {options.map(({ provider, token }) => <option key={token} value={token} disabled={provider.status !== 'ready' && provider.status !== 'active'}>
          {safeProviderName(provider)} · v{provider.providerVersion} · {copy.statuses[provider.status] ?? provider.status}
        </option>)}
      </select>
      {model.selectIconTheme === undefined || model.iconThemePreferenceWritable !== true ? <p className="cxr-icon-theme-note">{copy.iconThemeUnavailable}</p> : null}
      {themeError ? <p className="cxr-icon-theme-error" role="alert">{copy.iconThemeError}</p> : null}
    </section>}
    <div className="cxr-list cxr-about-links">
      {copy.links.map(([label, href, icon]) => <a key={href} className="cxr-card" href={href} target="_blank" rel="noopener noreferrer" aria-label={locale === 'zh-CN' ? `${label}（${copy.opensInNewWindow}）` : `${label} (${copy.opensInNewWindow})`}><span className="cxr-card-icon"><HostIcon token={icon} /></span><span className="cxr-card-body"><span className="cxr-card-title">{label}</span></span><HostIcon token="external-link" /></a>)}
      <button type="button" className="cxr-card" onClick={() => router.navigate({ kind: 'about-acknowledgements' })}><span className="cxr-card-icon"><HostIcon token="contributions" /></span><span className="cxr-card-body"><span className="cxr-card-title">{copy.acknowledgements}</span></span><span className="cxr-card-arrow" aria-hidden="true">›</span></button>
    </div>
  </section>
}
