import { HostIcon } from '../../host-ui/HostIcon.js'
import { productLocale } from '../../ui-copy.js'
import { ACKNOWLEDGEMENT_CONTRIBUTORS } from '../data/contributors.generated.js'

interface AcknowledgementContributor {
  readonly name: string
  readonly contribution: Readonly<Record<'en' | 'zh-CN', string>>
  readonly profileUrl?: string
  readonly avatarUrl?: string
}

const CONTRIBUTORS: readonly AcknowledgementContributor[] = ACKNOWLEDGEMENT_CONTRIBUTORS

const TOOLS = [
  {
    name: 'Cordis',
    url: 'https://github.com/deepseek-ai/deepseek-harness/tree/main/vendor/cordis',
    iconUrl: 'https://avatars.githubusercontent.com/u/148330874?v=4',
  },
  {
    name: 'React',
    url: 'https://react.dev/',
    iconUrl: 'https://avatars.githubusercontent.com/u/102812?v=4',
  },
  {
    name: 'TDesign React',
    url: 'https://github.com/Tencent/tdesign-react',
    iconUrl: 'https://raw.githubusercontent.com/Tencent/tdesign/main/site/src/assets/logo.png',
  },
  {
    name: 'Shiki',
    url: 'https://shiki.style/',
    iconUrl: 'https://avatars.githubusercontent.com/u/69196822?v=4',
  },
  {
    name: 'Vite',
    url: 'https://vite.dev/',
    iconUrl: 'https://avatars.githubusercontent.com/u/65625612?v=4',
  },
] as const

const COPY = {
  'zh-CN': {
    projects: '仓库与工具',
    contributors: '贡献者',
    empty: '当前构建尚未注入贡献者名单。',
    opensInNewWindow: '在新窗口打开',
  },
  en: {
    projects: 'Repositories & tools',
    contributors: 'Contributors',
    empty: 'No contributor list was injected into this build.',
    opensInNewWindow: 'opens in a new window',
  },
} as const

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return (parts.length > 1 ? `${parts[0]?.[0] ?? ''}${parts.at(-1)?.[0] ?? ''}` : name.slice(0, 2)).toUpperCase()
}

export function AcknowledgementsPage({ locale: localeSource }: { readonly locale: string }) {
  const locale = productLocale(localeSource)
  const copy = COPY[locale]
  return <section className="cxr-page cxr-acknowledgements">
    <section className="cxr-ack-section" aria-labelledby="cxr-ack-projects-title">
      <header><h3 id="cxr-ack-projects-title">{copy.projects}</h3></header>
      <ul className="cxr-ack-grid cxr-tool-grid">
        {TOOLS.map(tool => <li key={tool.name}><a className="cxr-tool-icon" href={tool.url} target="_blank" rel="noopener noreferrer" title={tool.name} aria-label={locale === 'zh-CN' ? `${tool.name}（${copy.opensInNewWindow}）` : `${tool.name} (${copy.opensInNewWindow})`}>
          <img src={tool.iconUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
        </a></li>)}
      </ul>
    </section>
    <section className="cxr-ack-section" aria-labelledby="cxr-ack-contributors-title">
      <header><h3 id="cxr-ack-contributors-title">{copy.contributors}</h3></header>
      {CONTRIBUTORS.length === 0
        ? <div className="cxr-empty cxr-ack-empty">{copy.empty}</div>
        : <ul className="cxr-ack-grid cxr-contributor-grid">
          {CONTRIBUTORS.map(contributor => {
            const content = <><span className="cxr-ack-avatar" aria-hidden="true">{contributor.avatarUrl === undefined ? initials(contributor.name) : <img src={contributor.avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />}</span><span className="cxr-ack-card-body"><strong>{contributor.name}</strong><span>{contributor.contribution[locale]}</span></span>{contributor.profileUrl === undefined ? null : <HostIcon token="external-link" />}</>
            return <li key={contributor.name}>{contributor.profileUrl !== undefined
              ? <a className="cxr-ack-card" href={contributor.profileUrl} target="_blank" rel="noopener noreferrer" aria-label={locale === 'zh-CN' ? `${contributor.name}（${copy.opensInNewWindow}）` : `${contributor.name} (${copy.opensInNewWindow})`}>{content}</a>
              : <div className="cxr-ack-card">{content}</div>}</li>
          })}
        </ul>}
    </section>
  </section>
}
