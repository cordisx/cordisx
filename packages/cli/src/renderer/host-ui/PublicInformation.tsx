import { type CSSProperties, useLayoutEffect, useRef, useState } from 'react'
import type { DisclosureProps, FieldListProps, StatusBadgeProps } from '../../ui.js'

export const PUBLIC_INFORMATION_STYLES = `
.cxr-ui-status-badge{display:inline-flex;max-width:100%;min-height:22px;align-items:center;border:1px solid var(--cx-border);border-radius:999px;padding:2px 8px;background:var(--cx-surface-raised);color:var(--cx-muted);font-size:12px;font-weight:600;line-height:16px;overflow-wrap:anywhere}
.cxr-ui-status-badge[data-tone="info"]{border-color:color-mix(in srgb,var(--cx-primary) 42%,var(--cx-border));background:color-mix(in srgb,var(--cx-primary) 11%,var(--cx-surface));color:var(--cx-primary)}
.cxr-ui-status-badge[data-tone="success"]{border-color:color-mix(in srgb,var(--cx-success,var(--cx-primary)) 42%,var(--cx-border));background:color-mix(in srgb,var(--cx-success,var(--cx-primary)) 11%,var(--cx-surface));color:var(--cx-success,var(--cx-primary))}
.cxr-ui-status-badge[data-tone="warning"]{border-color:color-mix(in srgb,var(--cx-warning,var(--cx-primary)) 46%,var(--cx-border));background:color-mix(in srgb,var(--cx-warning,var(--cx-primary)) 12%,var(--cx-surface));color:var(--cx-warning,var(--cx-primary))}
.cxr-ui-status-badge[data-tone="danger"]{border-color:color-mix(in srgb,var(--cx-danger) 45%,var(--cx-border));background:color-mix(in srgb,var(--cx-danger) 11%,var(--cx-surface));color:var(--cx-danger)}
.cxr-ui-field-list{container-type:inline-size;display:flex;flex-wrap:wrap;gap:0 24px;margin:0}.cxr-ui-field-list-row{display:grid;min-width:0;flex:0 0 100%;grid-template-columns:minmax(96px,35%) minmax(0,1fr);gap:8px 14px;align-items:start;border-bottom:1px solid var(--cx-border);padding:10px 0}.cxr-ui-field-list[data-columns="2"] .cxr-ui-field-list-row{flex-basis:calc(50% - 12px)}.cxr-ui-field-list[data-density="compact"] .cxr-ui-field-list-row{padding:7px 0}.cxr-ui-field-list dt{min-width:0;color:var(--cx-muted);font-size:12px;line-height:1.45;overflow-wrap:anywhere}.cxr-ui-field-list dd{min-width:0;margin:0;color:var(--cx-text);line-height:1.45;overflow-wrap:anywhere}.cxr-ui-field-list-description{display:block;margin-top:3px;color:var(--cx-muted);font-size:12px}
.cxr-ui-disclosure{border-top:1px solid var(--cx-border);border-bottom:1px solid var(--cx-border)}.cxr-ui-disclosure[data-tone="warning"]{border-color:color-mix(in srgb,#d99b22 40%,var(--cx-border))}.cxr-ui-disclosure[data-tone="danger"]{border-color:color-mix(in srgb,var(--cx-danger) 42%,var(--cx-border))}.cxr-ui-disclosure summary{display:flex;min-height:38px;align-items:center;gap:8px;color:var(--cx-text);font-weight:600;cursor:pointer;list-style:none}.cxr-ui-disclosure summary::-webkit-details-marker{display:none}.cxr-ui-disclosure summary::before{width:8px;height:8px;flex:none;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;content:"";transform:rotate(-45deg);transition:transform .14s ease}.cxr-ui-disclosure[open] summary::before{transform:rotate(45deg)}.cxr-ui-disclosure summary:focus-visible{outline:2px solid var(--cx-focus);outline-offset:2px}.cxr-ui-disclosure-body{min-width:0;padding:0 0 12px 16px;color:var(--cx-muted);overflow-wrap:anywhere}
@container(max-width:520px){.cxr-ui-field-list[data-columns="2"] .cxr-ui-field-list-row{flex-basis:100%}.cxr-ui-field-list-row{grid-template-columns:minmax(0,1fr);gap:3px}}
@media(max-width:640px){.cxr-ui-field-list[data-columns="2"] .cxr-ui-field-list-row{flex-basis:100%}.cxr-ui-field-list-row{grid-template-columns:minmax(0,1fr);gap:3px}}
@media(prefers-reduced-motion:reduce){.cxr-ui-disclosure summary::before{transition:none}}
`

function joinClassName(...values: (string | undefined)[]): string {
  return values.filter((value): value is string => value !== undefined && value !== '').join(' ')
}

export function StatusBadge({ tone = 'neutral', className, ...props }: StatusBadgeProps) {
  return <span {...props} className={joinClassName('cxr-ui-status-badge', className)} data-tone={tone} />
}

export function FieldList({ items, density = 'default', columns = 1, className, style, ...props }: FieldListProps) {
  return (
    <dl
      {...props}
      className={joinClassName('cxr-ui-field-list', className)}
      data-columns={columns}
      data-density={density}
      style={style as CSSProperties}
    >
      {items.map(item => (
        <div className="cxr-ui-field-list-row" key={item.id}>
          <dt>{item.label}</dt>
          <dd>
            {item.value}
            {item.description === undefined
              ? null
              : <span className="cxr-ui-field-list-description">{item.description}</span>}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function Disclosure({
  summary,
  children,
  open,
  defaultOpen,
  onToggle,
  tone = 'neutral',
  className,
  ...props
}: DisclosureProps) {
  const ref = useRef<HTMLDetailsElement>(null)
  const restoring = useRef<boolean | undefined>(undefined)
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen ?? false)
  const effectiveOpen = open ?? uncontrolledOpen
  useLayoutEffect(() => {
    if (ref.current !== null && ref.current.open !== effectiveOpen) ref.current.open = effectiveOpen
  }, [effectiveOpen])
  return (
    <details
      {...props}
      ref={ref}
      className={joinClassName('cxr-ui-disclosure', className)}
      data-tone={tone}
      open={effectiveOpen}
      onToggle={event => {
        const next = event.currentTarget.open
        if (open === undefined) {
          setUncontrolledOpen(next)
        } else if (restoring.current === next) {
          restoring.current = undefined
          return
        } else if (next !== open) {
          restoring.current = open
          event.currentTarget.open = open
        }
        onToggle?.(next)
      }}
    >
      <summary>{summary}</summary>
      <div className="cxr-ui-disclosure-body">{children}</div>
    </details>
  )
}
