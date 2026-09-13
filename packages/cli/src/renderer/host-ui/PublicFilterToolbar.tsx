import * as React from 'react'
import type { FilterToolbarProps, SearchFieldProps } from '../../ui.js'
import { HostIcon } from './HostIcon.js'

export function SearchField({
  className,
  value,
  onChange,
  clearable = false,
  clearLabel = 'Clear search',
  ...props
}: SearchFieldProps): React.ReactElement {
  const input = React.useRef<HTMLInputElement>(null)
  return (
    <span
      className={['cxr-ui-filter-search', className].filter(Boolean).join(' ')}
      data-clearable={clearable ? 'true' : undefined}
      onClick={event => {
        const target = event.target as Element
        if (target.closest('button,input,a,[role="button"]') !== null) return
        input.current?.focus()
      }}
    >
      <HostIcon token="search" className="cxr-ui-filter-search__icon" size={16} />
      <input
        {...props}
        ref={input}
        type="search"
        value={value}
        onChange={event => onChange(event.currentTarget.value)}
      />
      {clearable && value.length > 0
        ? (
          <button
            type="button"
            className="cxr-ui-button cxr-ui-filter-search__clear"
            data-variant="ghost"
            aria-label={clearLabel.trim() || 'Clear search'}
            title={clearLabel.trim() || 'Clear search'}
            disabled={props.disabled || props.readOnly}
            onClick={() => {
              onChange('')
              input.current?.focus()
            }}
          >
            <HostIcon token="close" surfaceToken="host:close" size={16} />
          </button>
        )
        : null}
    </span>
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
