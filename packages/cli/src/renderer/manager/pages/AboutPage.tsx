import type { ManagerSnapshot } from '../../manager.js'
import { BrandMark } from '../../host-ui/BrandMark.js'
import { HostIcon } from '../../host-ui/HostIcon.js'
import type { ManagerIconToken } from '../../icons.js'

const links = [
  ['反馈问题', 'https://github.com/cordisx/cordisx/issues/new', 'diagnostics'],
  ['参与建设', 'https://github.com/cordisx/cordisx', 'plugins'],
  ['查看文档', 'https://cordisx.github.io/docs/', 'document'],
  ['项目主页', 'https://cordisx.github.io/', 'external-link'],
] as const satisfies readonly (readonly [string, string, ManagerIconToken])[]

export function AboutPage({ snapshot }: { readonly snapshot: ManagerSnapshot }) {
  return <section className="cxr-page"><div className="cxr-about-identity"><BrandMark /><div><strong>CordisX</strong><span>Version {snapshot.version}</span></div></div><div className="cxr-list cxr-about-links" role="list">{links.map(([label, href, icon]) => <a key={href} className="cxr-card" role="listitem" href={href} target="_blank" rel="noopener noreferrer" aria-label={`${label}（在新窗口打开）`}><span className="cxr-card-icon"><HostIcon token={icon} /></span><span className="cxr-card-body"><span className="cxr-card-title">{label}</span></span><HostIcon token="external-link" /></a>)}</div></section>
}
