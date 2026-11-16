import * as React from 'react'
import type { FilterToolbarProps, SearchFieldProps } from '../../ui.js'
import { ActionGroup } from './ActionGroup.js'
import { SearchField as HostSearchField } from './SearchField.js'

const EmbeddedSearch = React.createContext(false)

/** Public plugin controls use the same search shell as the Manager collection. */
export function SearchField({ className, clearable = false, ...props }: SearchFieldProps): React.ReactElement {
  return (
    <HostSearchField
      {...props}
      clearable={clearable}
      embedded={React.useContext(EmbeddedSearch)}
      className={['cxr-ui-filter-search', className].filter(Boolean).join(' ')}
    />
  )
}

export function FilterToolbar({
  search,
  filters = [],
  actions,
  className,
  'aria-label': ariaLabel,
  ...props
}: FilterToolbarProps): React.ReactElement {
  return (
    <div
      {...props}
      className={['cxh-search-toolbar', 'cxr-ui-filter-toolbar', className].filter(Boolean).join(' ')}
      role="toolbar"
      aria-label={ariaLabel}
    >
      <EmbeddedSearch.Provider value={true}>{search}</EmbeddedSearch.Provider>
      {filters.length === 0 ? null : <div className="cxr-ui-filter-toolbar__filters">{filters}</div>}
      {actions == null ? null : <ActionGroup className="cxh-search-toolbar-actions">{actions}</ActionGroup>}
    </div>
  )
}
