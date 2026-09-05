import { useState } from 'react'
import type { ManagerSnapshot } from '../../manager.js'
import { managerCopy } from '../../ui-copy.js'
import type { ManagerRouter } from '../model/routes.js'
import { SearchField } from '../../host-ui/SearchField.js'

export function ExtensionPointsPage(
  { snapshot, router }: { readonly snapshot: ManagerSnapshot; readonly router: ManagerRouter },
) {
  const [query, setQuery] = useState('')
  const normalized = query.trim().toLocaleLowerCase()
  const points = (snapshot.extensionPoints?.points ?? []).filter(point =>
    `${point.id} ${point.titleProjection.text} ${point.descriptionProjection.text}`.toLocaleLowerCase().includes(
      normalized,
    )
  )
  return (
    <section className="cxr-page">
      <SearchField
        className="cxr-search"
        value={query}
        aria-label={managerCopy(snapshot.localization.locale, 'extension.search-label')}
        placeholder={managerCopy(snapshot.localization.locale, 'extension.search-placeholder')}
        onChange={setQuery}
      />
      <div className="cxr-list">
        {points.map(point => (
          <button
            key={point.id}
            type="button"
            className="cxr-card"
            onClick={() => router.navigate({ kind: 'extension-point', pointId: point.id })}
          >
            <span className="cxr-card-icon">EP</span>
            <span className="cxr-card-body">
              <span className="cxr-card-title">{point.titleProjection.text}</span>
              <span className="cxr-card-description">{point.descriptionProjection.text}</span>
              <code className="cxr-card-code">{point.id}</code>
            </span>
            <span className="cxr-status">{point.plugins.length}</span>
          </button>
        ))}
        {points.length === 0
          ? (
            <div className="cxr-empty">
              {managerCopy(
                snapshot.localization.locale,
                normalized === '' ? 'extension.empty' : 'extension.no-matches',
              )}
            </div>
          )
          : null}
      </div>
    </section>
  )
}
