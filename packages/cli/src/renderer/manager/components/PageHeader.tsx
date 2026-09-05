import type { ReactNode } from 'react'

export function PageHeader(
  { title, description, actions }: {
    readonly title: string
    readonly description?: string
    readonly actions?: ReactNode
  },
) {
  return (
    <header className="cxr-page-head">
      <div>
        <h3>{title}</h3>
        {description === undefined ? null : <p>{description}</p>}
      </div>
      {actions}
    </header>
  )
}
