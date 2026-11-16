import { Radio, RadioGroup, Tooltip } from 'tdesign-react'
import type { CordisXConfigFieldSnapshot } from '../../contracts.js'
import type { SemanticIconKey } from '../../icon-theme-contracts.js'
import { HostIcon } from './HostIcon.js'

export type HostFormChoiceIcons = Readonly<Record<string, SemanticIconKey>>
export type HostFormChoiceLabels = Readonly<Record<string, string>>

/** Shared Host controls retain native radio behavior; icons are decorative. */
export const HOST_RADIO_CHOICE_STYLES = String.raw`
  .cxf-choice-label { display: inline-flex; min-width: 0; align-items: center; gap: 6px; line-height: 20px; }
  .cxf-choice-label .cordisx-host-icon { flex: none; }
  .cxf-choice-text { min-width: 0; overflow-wrap: anywhere; }
`

export function HostRadioChoices({ field, value, onChange, icons, labels }: {
  readonly field: CordisXConfigFieldSnapshot
  readonly value: unknown
  readonly onChange: (value: unknown) => void
  readonly icons?: HostFormChoiceIcons
  readonly labels?: HostFormChoiceLabels
}) {
  // Index keys preserve distinct JSON scalar choices, including null.
  const selected = field.choices?.findIndex(choice => Object.is(choice.value, value)) ?? -1
  return (
    <RadioGroup
      className="cxf-segmented"
      theme="button"
      variant="primary-filled"
      value={selected < 0 ? '' : String(selected)}
      disabled={field.disabled}
      onChange={next => onChange(field.choices?.[Number(next)]?.value)}
    >
      {field.choices?.map((choice, index) => {
        const icon = typeof choice.value === 'string' ? icons?.[choice.value] : undefined
        const label = typeof choice.value === 'string' ? labels?.[choice.value] ?? choice.label : choice.label
        return (
          <Tooltip key={index} content={choice.label} placement="top">
            <Radio.Button value={String(index)} aria-label={choice.label}>
              <span className="cxf-choice-label">
                {icon === undefined ? null : <HostIcon token={icon} size={15} />}
                <span className="cxf-choice-text">{label}</span>
              </span>
            </Radio.Button>
          </Tooltip>
        )
      })}
    </RadioGroup>
  )
}
