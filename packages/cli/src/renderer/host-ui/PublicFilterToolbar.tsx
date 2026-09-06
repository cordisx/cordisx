import * as React from 'react'
import type { FilterToolbarProps, SearchFieldProps } from '../../ui.js'
import { HostIcon } from './HostIcon.js'

export function SearchField({ className, value, onChange, ...props }: SearchFieldProps): React.ReactElement {
  return (
    <label className={['cxr-ui-filter-search', className].filter(Boolean).join(' ')}>
      <HostIcon token="search" className="cxr-ui-filter-search__icon" size={16} />
      <input {...props} type="search" value={value} onChange={event => onChange(event.currentTarget.value)} />
    </label>
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
      className={['cxr-ui-filter-toolbar', className].filter(Boolean).join(' ')}
      role="toolbar"
      aria-label={ariaLabel}
    >
      <div className="cxr-ui-filter-toolbar__search">{search}</div>
      {filters.length === 0 ? null : <div className="cxr-ui-filter-toolbar__filters">{filters}</div>}
      {actions === undefined ? null : <div className="cxr-ui-filter-toolbar__actions">{actions}</div>}
    </div>
  )
}
