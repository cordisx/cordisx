import { useState } from 'react'
import type { ManagerSnapshot } from '../../manager.js'
import { managerCopy } from '../../ui-copy.js'
import type { ManagerRouter } from '../model/routes.js'
import { SearchField } from '../../host-ui/SearchField.js'

export function RoutesPage({ snapshot, router }: { readonly snapshot: ManagerSnapshot; readonly router: ManagerRouter }) {
  const [query, setQuery] = useState('')
  const normalized = query.trim().toLocaleLowerCase()
  const routes = snapshot.navigation.routes.filter(route => `${route.qualifiedId} ${route.definition.path} ${route.productMetadata.title ?? ''}`.toLocaleLowerCase().includes(normalized))
  const pages = snapshot.navigation.pages.filter(page => `${page.qualifiedId} ${page.metadata.title ?? ''} ${page.productMetadata.title ?? ''}`.toLocaleLowerCase().includes(normalized))
  return (
    <section className="cxr-page">
      <SearchField className="cxr-search" value={query} aria-label={managerCopy(snapshot.localization.locale, 'routes.search-label')} placeholder={managerCopy(snapshot.localization.locale, 'routes.search-placeholder')} onChange={setQuery} />
      <div className="cxr-list">
        {routes.map(route => <button key={`route:${route.qualifiedId}`} type="button" className="cxr-card" onClick={() => router.navigate({ kind: 'route', qualifiedId: route.qualifiedId })}><span className="cxr-card-icon">R</span><span className="cxr-card-body"><span className="cxr-card-title">{route.productMetadata.title ?? route.qualifiedId}</span><span className="cxr-card-description">{route.productMetadata.description ?? route.definition.path}</span><code className="cxr-card-code">{route.definition.path}</code></span></button>)}
        {pages.map(page => <button key={`page:${page.qualifiedId}`} type="button" className="cxr-card" onClick={() => router.navigate({ kind: 'page', qualifiedId: page.qualifiedId })}><span className="cxr-card-icon">P</span><span className="cxr-card-body"><span className="cxr-card-title">{page.productMetadata.title ?? page.metadata.title?.toString() ?? page.qualifiedId}</span><span className="cxr-card-description">{page.productMetadata.description}</span><code className="cxr-card-code">{page.qualifiedId}</code></span></button>)}
        {routes.length + pages.length === 0 ? <div className="cxr-empty">{managerCopy(snapshot.localization.locale, normalized === '' ? 'routes.empty' : 'routes.no-matches')}</div> : null}
      </div>
    </section>
  )
}
