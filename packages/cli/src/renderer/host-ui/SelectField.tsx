import { useLayoutEffect, useRef } from 'react'
import { Select } from 'tdesign-react'
import { HostIcon } from './HostIcon.js'
import type { ManagerIconToken } from '../icons.js'

export interface SelectFieldOption {
  readonly value: string
  readonly label: string
}
export interface SelectFieldProps {
  readonly label: string
  readonly icon: ManagerIconToken
  readonly options: readonly SelectFieldOption[]
  readonly value: string
  readonly className?: string
  readonly onChange: (value: string) => void
}

export function SelectField({ label, icon, options, value, className, onChange }: SelectFieldProps) {
  const root = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    // Keep the accessible name on the official control's real focus target.
    root.current?.querySelector('input')?.setAttribute('aria-label', label)
  })
  return (
    <span ref={root} style={{ display: 'contents' }}>
      <Select
        className={['cxh-select-field', className].filter(Boolean).join(' ')}
        value={value}
        options={[...options]}
        prefixIcon={<HostIcon token={icon} />}
        onChange={next => onChange(String(next))}
      />
    </span>
  )
}
