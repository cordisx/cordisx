import { RadioGroup } from 'tdesign-react'
import type { CordisXConfigFieldSnapshot } from '../../contracts.js'
import type { SemanticIconKey } from '../../icon-theme-contracts.js'
import { HostIcon } from './HostIcon.js'

export type HostFormChoiceIcons = Readonly<Record<string, SemanticIconKey>>

/** Shared Host controls retain native radio behavior; icons are decorative. */
export const HOST_RADIO_CHOICE_STYLES = String.raw`
  .cxf-choice-buttons.t-radio-group.t-radio-group__outline { gap: 6px; }
  .cxf-choice-buttons.t-radio-group.t-radio-group__outline .t-radio-button { height: auto; min-height: 32px; max-width: 100%; margin: 0; padding: 6px 10px; border: 1px solid var(--td-border-level-2-color); border-radius: var(--td-radius-default); white-space: normal; }
  .cxf-choice-buttons.t-radio-group.t-radio-group__outline .t-radio-button.t-is-checked { border-color: var(--td-brand-color); background: var(--td-brand-color-light); }
  .cxf-choice-buttons.t-radio-group.t-radio-group__outline .t-radio-button.t-is-disabled.t-is-checked { border-color: var(--td-brand-color-disabled); background: var(--td-bg-color-component-disabled); }
  .cxf-choice-label { display: inline-flex; min-width: 0; align-items: center; gap: 6px; line-height: 20px; }
  .cxf-choice-label .cordisx-host-icon { flex: none; }
  .cxf-choice-text { min-width: 0; overflow-wrap: anywhere; }
`

export function HostRadioChoices({ field, value, onChange, icons }: {
  readonly field: CordisXConfigFieldSnapshot
  readonly value: unknown
  readonly onChange: (value: unknown) => void
  readonly icons?: HostFormChoiceIcons
}) {
  // Index keys preserve distinct JSON scalar choices, including null.
  const selected = field.choices?.findIndex(choice => Object.is(choice.value, value)) ?? -1
  const segmented = field.presenter?.kind === 'choice.segmented'
  return (
    <RadioGroup
      className={segmented ? 'cxf-segmented' : 'cxf-choice-buttons'}
      theme="button"
      variant={segmented ? 'primary-filled' : 'outline'}
      value={selected < 0 ? '' : String(selected)}
      options={field.choices?.map((choice, index) => {
        const icon = typeof choice.value === 'string' ? icons?.[choice.value] : undefined
        return {
          value: String(index),
          label: (
            <span className="cxf-choice-label">
              {icon === undefined ? null : <HostIcon token={icon} size={15} />}
              <span className="cxf-choice-text">{choice.label}</span>
            </span>
          ),
        }
      }) ?? []}
      disabled={field.disabled}
      onChange={next => onChange(field.choices?.[Number(next)]?.value)}
    />
  )
}
