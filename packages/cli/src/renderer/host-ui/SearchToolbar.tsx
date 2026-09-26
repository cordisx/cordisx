import type { ReactNode } from 'react'
import { SearchField } from './SearchField.js'
import type { SearchFieldProps } from './SearchField.js'

export interface SearchToolbarProps extends Omit<SearchFieldProps, 'embedded'> {
  readonly actions?: ReactNode
  readonly toolbarLabel?: string
}

/** The Marketplace search shell, shared by every Manager list toolbar. */
export function SearchToolbar({ className, actions, toolbarLabel, ...search }: SearchToolbarProps) {
  return (
    <div
      className={['cxh-search-toolbar', className].filter(Boolean).join(' ')}
      role="search"
      aria-label={toolbarLabel ?? search['aria-label']}
    >
      <SearchField {...search} embedded />
      {actions == null ? null : <div className="cxh-search-toolbar-actions">{actions}</div>}
    </div>
  )
}
