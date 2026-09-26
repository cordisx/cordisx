import { useRef } from 'react'
import type { InputHTMLAttributes } from 'react'
import { HostIcon } from './HostIcon.js'

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'type' | 'value'> {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly clearLabel?: string
  readonly embedded?: boolean
}

/** One Host search control for standalone fields and toolbar composition. */
export function SearchField(
  { className, value, onChange, clearLabel = 'Clear search', embedded, onKeyDown, ...props }: SearchFieldProps,
) {
  const input = useRef<HTMLInputElement>(null)
  const editable = !props.disabled && !props.readOnly
  return (
    <span
      className={['cxh-search-field', className].filter(Boolean).join(' ')}
      data-embedded={embedded ? 'true' : undefined}
      data-disabled={props.disabled ? 'true' : undefined}
      onClick={event => {
        if ((event.target as Element).closest('button,input') === null) input.current?.focus()
      }}
    >
      <span className="cxh-search-icon" aria-hidden="true">
        <HostIcon token="search" />
      </span>
      <input
        {...props}
        ref={input}
        type="search"
        value={value}
        onChange={event => onChange(event.currentTarget.value)}
        onKeyDown={event => {
          onKeyDown?.(event)
          if (!event.defaultPrevented && event.key === 'Escape' && value !== '' && editable) {
            event.preventDefault()
            event.stopPropagation()
            onChange('')
          }
        }}
      />
      {value === '' ? null : (
        <button
          type="button"
          className="cxh-search-clear"
          aria-label={clearLabel}
          title={clearLabel}
          disabled={!editable}
          onClick={() => {
            onChange('')
            input.current?.focus()
          }}
        >
          <HostIcon token="close" />
        </button>
      )}
    </span>
  )
}
