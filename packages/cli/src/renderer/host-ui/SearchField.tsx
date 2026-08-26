import type { InputHTMLAttributes } from 'react'
import { HostIcon } from './HostIcon.js'

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'type' | 'value'> {
  readonly value: string
  readonly onChange: (value: string) => void
}

/** Shared Host-owned search control with a consistent semantic leading icon. */
export function SearchField({ className, value, onChange, ...props }: SearchFieldProps) {
  return <span className={['cxh-search-field', className].filter(Boolean).join(' ')}>
    <span className="cxh-search-icon" aria-hidden="true"><HostIcon token="search" /></span>
    <input {...props} type="search" value={value} onChange={event => onChange(event.currentTarget.value)} />
  </span>
}
