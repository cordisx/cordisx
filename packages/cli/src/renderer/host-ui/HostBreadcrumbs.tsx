import { Fragment } from 'react'

export interface HostBreadcrumbSegment {
  readonly key: string
  readonly label: string
  readonly onActivate?: () => void
}

/** Shared Host breadcrumb presentation used by Manager headers and form subpages. */
export function HostBreadcrumbs({ segments, label = '面包屑' }: {
  readonly segments: readonly HostBreadcrumbSegment[]
  readonly label?: string
}) {
  return (
    <nav className="cxr-breadcrumbs" aria-label={label}>
      {segments.map((segment, index) => {
        const current = index === segments.length - 1
        return (
          <Fragment key={segment.key}>
            {index === 0 ? null : <span aria-hidden="true">/</span>}
            {current
              ? <span aria-current="page">{segment.label}</span>
              : segment.onActivate === undefined
              ? <span>{segment.label}</span>
              : <button type="button" onClick={segment.onActivate}>{segment.label}</button>}
          </Fragment>
        )
      })}
    </nav>
  )
}
