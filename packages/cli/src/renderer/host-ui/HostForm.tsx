import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  Button,
  Checkbox,
  ColorPicker,
  DatePicker,
  Dropdown,
  type DropdownOption,
  Form,
  Input,
  InputNumber,
  RadioGroup,
  Select,
  Slider,
  Switch,
  TagInput,
  Textarea,
  TimePicker,
} from 'tdesign-react'
import { type FormDescriptor, FormDraft, type FormPrimitive, resolveFormPresenter } from '@cordisx/schemastery-ui'
import type { CordisXConfigFieldSnapshot, CordisXJsonValue } from '../../contracts.js'
import type { ManagerModel, ManagerPluginSnapshot } from '../manager.js'
import type { ConfigMutationOperation } from '../configuration.js'
import { managerCopy } from '../ui-copy.js'
import { ArrayEditor, type ArrayEditorFieldRowRenderProps } from './ArrayEditor.js'
import { HostFormPageStack } from './HostFormPages.js'
import { HostSurfaceIcon } from './HostSurfaceIcon.js'
import { hostFormTagValues, hostFormValidationIssueText } from './HostFormValidation.js'

export { hostFormValidationIssueText } from './HostFormValidation.js'

export const HOST_FORM_REACT_STYLES = String.raw`
  .cxf-react-form { --cxf-number-input-width: 116px; display: flex; width: 100%; min-width: 0; min-height: 0; flex-direction: column; margin: 0; }
  .cxf-form-page-stack, .cxf-form-page-root, .cxf-form-page-layer, .cxf-form-subpage { display: flex; min-width: 0; min-height: 0; flex: 1; flex-direction: column; overflow: hidden; }
  :is(.cxf-form-page-root,.cxf-form-page-layer)[hidden] { display: none; }
  .cxf-form-body { display: grid; min-width: 0; align-content: start; grid-auto-rows: max-content; gap: 1.35rem; padding: 4px 0 16px; }
  .cxf-form-subpage-header { display: grid; min-width: 0; grid-template-columns: 32px minmax(0,1fr); flex: none; align-items: center; gap: 8px; border-bottom: 1px solid var(--cx-border,#353a42); padding: 4px 0 12px; }
  .cxf-form-subpage-header-seat { display: grid; width: 32px; height: 32px; place-items: center; }
  .cxf-form-subpage-header-seat > .t-button { width: 32px; height: 32px; padding: 0; }
  .cxf-form-subpage-header-seat > .t-button :is(.t-icon,.cordisx-host-icon) { width: 16px; height: 16px; color: var(--cx-muted,#9ca5b5); font-size: 16px !important; }
  .cxf-form-subpage-body { min-width: 0; min-height: 0; flex: 1; overflow: auto; padding: 16px 0; }
  .cxf-section { display: grid; min-width: 0; gap: 9px; }
  .cxf-section-heading { padding: 0 4px; }
  .cxf-section-heading h3 { margin: 0; font-size: 14px; line-height: 20px; font-weight: 650; }
  .cxf-section-heading p { margin: 3px 0 0; color: var(--cx-muted,#9ca5b5); font-size: 11px; line-height: 1.5; }
  .cxf-form-grid { display: grid; min-width: 0; overflow: clip; border: 1px solid var(--cx-border,#353a42); border-radius: 12px; background: color-mix(in srgb,var(--cx-surface-raised,#20242b) 86%,var(--cx-surface,#17191d)); box-shadow: 0 1px 2px rgb(0 0 0 / 12%); }
  .cxf-item { display: grid; min-width: 0; grid-template-columns: minmax(0,1fr) minmax(13rem,min(44%,25rem)); grid-template-areas: "label control" "help control" "error error"; align-items: center; gap: 4px 20px; padding: 14px 16px; }
  .cxf-item + .cxf-item { border-top: 1px solid var(--cx-border,#353a42); }
  .cxf-item[data-full-width="true"] { grid-template-columns: minmax(0,1fr); grid-template-areas: "label" "help" "control" "error"; align-items: start; }
  .cxf-label-row { grid-area: label; display: flex; min-width: 0; align-items: center; gap: 4px; }
  .cxf-field-label { display: inline-flex; min-width: 0; align-items: center; gap: 6px; color: var(--cx-text,#edf0f4); font-weight: 600; line-height: 24px; }
  .cxf-field-label-text { min-width: 0; overflow-wrap: anywhere; }
  .cxf-required { order: 2; color: var(--td-error-color,var(--cx-danger,#e34d59)); font-weight: 700; line-height: 24px; }
  .cxf-field-menu-trigger.t-button { width: 24px; height: 24px; flex: none; margin-left: -4px; padding: 0; color: var(--cx-muted,#9ca5b5); vertical-align: middle; }
  .cxf-field-menu-trigger.t-button:hover, .cxf-field-menu-trigger.t-button[aria-expanded="true"] { background: transparent; color: var(--cx-text,#edf0f4); }
  .cxf-field-icon { display: inline-grid; width: 24px; height: 24px; flex: none; margin-left: -4px; place-items: center; color: var(--cx-muted,#9ca5b5); }
  :is(.cxf-field-menu-trigger,.cxf-field-icon) :is(.t-icon,.cordisx-host-icon) { display: block; width: 15px; height: 15px; font-size: 15px; }
  .cxf-control-seat { grid-area: control; min-width: 0; justify-self: stretch; }
  .cxf-item[data-control-layout="compact"] .cxf-control-seat { width: auto; max-width: 100%; justify-self: end; }
  .cxf-item[data-control-layout="fill"] .cxf-control-seat > :not(.cxf-custom-seat) { width: 100%; }
  .cxf-item[data-primitive="date-picker"] .cxf-control-seat .t-date-picker,
  .cxf-item[data-primitive="time-picker"] .cxf-control-seat .t-time-picker,
  .cxf-item[data-primitive="color-picker"] .cxf-control-seat .t-color-picker__trigger,
  .cxf-item[data-primitive="color-picker"] .cxf-control-seat .t-color-picker__trigger--default,
  .cxf-item[data-primitive="color-picker"] .cxf-control-seat .t-input__wrap { width: 100%; }
  .cxf-item[data-primitive="slider"] .cxf-control-seat { width: auto; justify-self: stretch; }
  .cxf-item[data-primitive="slider"] .cxf-control-seat > :not(.cxf-custom-seat) { width: 100%; }
  .cxf-item[data-control-layout="compact"] .t-input-number { width: var(--cxf-number-input-width); }
  .cxf-item[data-control-layout="compact"] .t-radio-group { width: fit-content; max-width: 100%; }
  .cxf-help, .cxf-error { margin: 0; overflow-wrap: anywhere; font-size: 11px; line-height: 1.45; }
  .cxf-help { grid-area: help; color: var(--cx-muted,#9ca5b5); }
  .cxf-error { grid-area: error; color: var(--cx-danger,#e34d59); }
  .cxf-control-seat .t-input-number, .cxf-control-seat .t-input-number__input, .cxf-control-seat .t-input-number .t-input { min-width: 0; max-width: 100%; }
  .cxf-textarea textarea { min-height: 104px !important; resize: vertical; }
  .cxf-json textarea { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 12px; }
  .cxf-slider-control { display: grid; width: 100%; grid-template-columns: minmax(0,1fr) var(--cxf-number-input-width); align-items: center; gap: 10px; }
  .cxf-segmented .t-radio-button { min-height: 32px; }
  .cxf-array-editor { display: grid; gap: 7px; width: 100%; }
  .cxf-item[data-primitive="object-array"] { position: relative; }
  .cxf-item[data-primitive="object-array"] > .cxf-label-row { padding-right: 34px; }
  .cxf-array-editor-toolbar { position: absolute; z-index: 1; top: 10px; right: 12px; display: flex; justify-content: flex-end; }
  .cxf-array-editor-toolbar .t-button { width: 28px; height: 28px; padding: 0; }
  .cxf-array-row { display: flex; min-width: 0; min-height: 40px; align-items: center; gap: 8px; border: 1px solid var(--cx-border,#353a42); border-radius: 9px; padding: 4px 6px; background: var(--cx-surface,#17191d); }
  .cxf-array-row-drag-handle { display: grid; width: 28px; height: 28px; flex: none; place-items: center; border: 0; background: transparent; color: var(--cx-muted,#9ca5b5); cursor: grab; }
  .cxf-array-row-summary { min-width: 0; flex: 1; overflow: hidden; color: var(--cx-muted,#9ca5b5); text-overflow: ellipsis; white-space: nowrap; }
  .cxf-array-row-actions { display: flex; flex: none; opacity: 0; pointer-events: none; transition: opacity 120ms ease; }
  .cxf-array-row:hover .cxf-array-row-actions, .cxf-array-row:focus-within .cxf-array-row-actions { opacity: 1; pointer-events: auto; }
  .cxf-array-row-actions .t-button { width: 30px; height: 30px; }
  .cxf-array-delete { color: var(--td-error-color,#e34d59); }
  .cxf-array-item-dialog.t-dialog { --cxf-manager-dialog-gap: .85rem; --cxf-manager-dialog-padding: 1rem; padding: var(--cxf-manager-dialog-padding); }
  .cxf-array-item-dialog .t-dialog__body { padding: var(--cxf-manager-dialog-gap) 0; }
  .cxf-array-item-dialog .t-dialog__footer { padding: 0; }
  .cxf-array-item-fields { gap: 0; }
  .cxf-form-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .cxf-status { min-width: 0; flex: 1; color: var(--cx-muted,#9ca5b5); font-size: 11px; }
  .cxf-form-action-buttons { display: flex; flex: none; gap: 8px; }
  @media (max-width: 760px) {
    .cxf-item, .cxf-item[data-full-width="true"] { grid-template-columns: minmax(0,1fr); grid-template-areas: "label" "help" "control" "error"; align-items: start; gap: 5px; }
    .cxf-item[data-control-layout="compact"] .cxf-control-seat { justify-self: start; }
  }
`

const SENSITIVE_ROLES = new Set(['secret', 'credential', 'credential-ref', 'permission', 'capability'])

function pathKey(field: CordisXConfigFieldSnapshot): string {
  return field.path.join('.')
}

function humanizeFieldName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return value
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, character => character.toLocaleUpperCase())
}

function descriptor(field: CordisXConfigFieldSnapshot): FormDescriptor {
  return {
    path: field.path,
    type: field.type as FormDescriptor['type'],
    ...(field.role === undefined ? {} : { role: field.role }),
    ...(field.label === undefined ? {} : { label: field.label }),
    ...(field.description === undefined ? {} : { description: field.description }),
    required: field.required,
    disabled: field.disabled,
    ...(field.hasDefault === true ? { defaultValue: field.defaultValue } : {}),
    ...(field.min === undefined ? {} : { min: field.min }),
    ...(field.max === undefined ? {} : { max: field.max }),
    ...(field.step === undefined ? {} : { step: field.step }),
    ...(field.choices === undefined ? {} : { choices: field.choices }),
    ...(field.arrayItemType === undefined ? {} : { itemType: field.arrayItemType }),
    ...(field.arrayItemSchema === undefined ? {} : { item: { path: [...field.path, '*'], type: 'object' } }),
    ...(field.presenter === undefined ? {} : { presentation: field.presenter }),
  }
}

function primitive(field: CordisXConfigFieldSnapshot): FormPrimitive | 'sensitive-unavailable' {
  if (field.role !== undefined && SENSITIVE_ROLES.has(field.role)) return 'sensitive-unavailable'
  return resolveFormPresenter(descriptor(field)).primitive
}

function fullWidth(resolved: ReturnType<typeof primitive>): boolean {
  return [
    'textarea',
    'json-textarea',
    'path-input',
    'tag-input',
    'multi-select',
    'object-array',
    'unsupported',
    'sensitive-unavailable',
  ].includes(resolved)
}

function numericProps(field: Pick<CordisXConfigFieldSnapshot, 'min' | 'max' | 'step'>) {
  return {
    ...(field.min === undefined ? {} : { min: field.min }),
    ...(field.max === undefined ? {} : { max: field.max }),
    ...(field.step === undefined ? {} : { step: field.step }),
  }
}

function Control({ field, resolved, value, onChange, controlId, locale, transientSecret }: {
  readonly field: CordisXConfigFieldSnapshot
  readonly resolved: ReturnType<typeof primitive>
  readonly value: unknown
  readonly onChange: (value: unknown) => void
  readonly controlId?: string
  readonly locale: string
  readonly transientSecret?: boolean
}) {
  // TDesign values exclude null. Stable option keys preserve every JSON scalar,
  // including null and distinct boolean, numeric and string schema choices.
  const choices = field.choices?.map((choice, index) => ({ label: choice.label, value: String(index) })) ?? []
  const choiceKey = (candidate: unknown) => {
    const index = field.choices?.findIndex(choice => Object.is(choice.value, candidate)) ?? -1
    return index < 0 ? '' : String(index)
  }
  const choiceValue = (key: unknown) => field.choices?.[Number(key)]?.value
  if (resolved === 'sensitive-unavailable') {
    return <div className="cxr-notice cxf-alert" role="note">{managerCopy(locale, 'form.sensitive-unavailable')}</div>
  }
  if (resolved === 'unsupported') return <div className="cxr-notice">{managerCopy(locale, 'form.unsupported')}</div>
  if (resolved === 'object-array') {
    return (
      <ArrayEditor
        field={field}
        value={Array.isArray(value) ? value as Record<string, unknown>[] : []}
        onChange={onChange}
        locale={locale}
        validateField={candidate => hostFormValidationIssueText(candidate, candidate.value, locale)}
        renderFieldRow={props => <ArrayItemFieldRow {...props} locale={locale} />}
      />
    )
  }
  if (resolved === 'textarea') {
    return (
      <Textarea
        className="cxf-textarea"
        value={typeof value === 'string' ? value : ''}
        autosize={{ minRows: 5, maxRows: 14 }}
        disabled={field.disabled}
        onChange={onChange}
      />
    )
  }
  if (resolved === 'json-textarea') {
    return (
      <Textarea
        className="cxf-textarea cxf-json"
        value={typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
        autosize={{ minRows: 5, maxRows: 18 }}
        disabled={field.disabled}
        onChange={text => {
          try {
            onChange(JSON.parse(text))
          } catch {
            onChange(text)
          }
        }}
      />
    )
  }
  if (resolved === 'checkbox') {
    return <Checkbox checked={value === true} disabled={field.disabled} onChange={onChange} />
  }
  if (resolved === 'switch') return <Switch value={value === true} disabled={field.disabled} onChange={onChange} />
  if (resolved === 'slider') {
    return (
      <div className="cxf-slider-control">
        <Slider
          value={typeof value === 'number' ? value : 0}
          {...numericProps(field)}
          disabled={field.disabled}
          onChange={onChange}
        />
        <InputNumber
          value={typeof value === 'number' ? value : ''}
          {...numericProps(field)}
          disabled={field.disabled}
          onChange={next => onChange(next === '' ? undefined : next)}
        />
      </div>
    )
  }
  if (resolved === 'number-input') {
    return (
      <InputNumber
        value={typeof value === 'number' ? value : ''}
        {...numericProps(field)}
        disabled={field.disabled}
        onChange={next => onChange(next === '' ? undefined : next)}
      />
    )
  }
  if (resolved === 'radio') {
    return (
      <RadioGroup
        {...(field.presenter?.kind === 'choice.segmented' ? { className: 'cxf-segmented' } : {})}
        variant={field.presenter?.kind === 'choice.segmented' ? 'primary-filled' : 'default-filled'}
        value={choiceKey(value)}
        options={choices}
        disabled={field.disabled}
        onChange={next => onChange(choiceValue(next))}
      />
    )
  }
  if (resolved === 'select') {
    return (
      <Select
        value={choiceKey(value)}
        options={choices}
        disabled={field.disabled}
        clearable={!field.required}
        onChange={(next, context) => onChange(context.trigger === 'clear' ? undefined : choiceValue(next))}
      />
    )
  }
  if (resolved === 'multi-select') {
    return (
      <Select
        multiple
        clearable
        value={Array.isArray(value) ? value.map(choiceKey) : []}
        options={choices}
        disabled={field.disabled}
        onChange={next => onChange(Array.isArray(next) ? next.map(choiceValue) : [])}
      />
    )
  }
  if (resolved === 'tag-input') {
    return (
      <TagInput
        value={Array.isArray(value) ? value.map(String) : []}
        disabled={field.disabled}
        onChange={next => onChange(hostFormTagValues(field.arrayItemType, next))}
      />
    )
  }
  if (resolved === 'date-picker') {
    return (
      <DatePicker
        value={typeof value === 'string' ? value : ''}
        enableTimePicker={field.role === 'datetime'}
        format={field.role === 'datetime' ? 'YYYY-MM-DD HH:mm:ss' : 'YYYY-MM-DD'}
        disabled={field.disabled}
        onChange={onChange}
      />
    )
  }
  if (resolved === 'time-picker') {
    return (
      <TimePicker
        format="HH:mm"
        value={typeof value === 'string' ? value : ''}
        disabled={field.disabled}
        onChange={onChange}
      />
    )
  }
  if (resolved === 'color-picker') {
    return (
      <ColorPicker
        format="HEX"
        enableAlpha={false}
        value={typeof value === 'string' ? value : ''}
        disabled={field.disabled}
        onChange={onChange}
      />
    )
  }
  return (
    <Input
      {...(controlId === undefined ? {} : { id: controlId })}
      type={field.role === 'url' ? 'url' : field.role === 'password' ? 'password' : 'text'}
      value={typeof value === 'string' ? value : ''}
      disabled={field.disabled}
      {...(field.role === 'password' ? { autocomplete: 'new-password' } : {})}
      {...(transientSecret === true ? { 'data-channel-credential-capture': 'true' } : {})}
      onChange={onChange}
    />
  )
}

function ArrayItemFieldRow(
  { field, controlId, issueText, onChange, locale }: ArrayEditorFieldRowRenderProps & { readonly locale: string },
) {
  return (
    <HostFieldRow
      field={field}
      value={field.value}
      changed={false}
      locale={locale}
      idPrefix={`array-item-${controlId}`}
      controlId={controlId}
      {...(issueText === undefined ? {} : { issueText })}
      fieldActions="static"
      onChange={onChange}
    />
  )
}

function ConfigControl({ model, pluginId, field, blocked, value, resolved, onChange, controlId, locale }: {
  readonly model: ManagerModel
  readonly pluginId: string
  readonly field: CordisXConfigFieldSnapshot
  readonly blocked: boolean
  readonly value: unknown
  readonly resolved: ReturnType<typeof primitive>
  readonly onChange: (value: unknown) => void
  readonly controlId: string
  readonly locale: string
}) {
  const custom = useRef<HTMLDivElement>(null)
  const latestChange = useRef(onChange)
  latestChange.current = next => {
    if (!blocked) onChange(next)
  }
  const [customMounted, setCustomMounted] = useState(false)
  useEffect(() => {
    setCustomMounted(false)
    if (model.mountConfigRenderer === undefined || custom.current === null || field.disabled) return
    let disposed = false
    let mount: Awaited<ReturnType<NonNullable<ManagerModel['mountConfigRenderer']>>> | undefined
    void model.mountConfigRenderer(pluginId, { ...field, value }, custom.current, next => latestChange.current(next))
      .then(next => {
        if (disposed) {
          void next.dispose()
          return
        }
        mount = next
        if (!next.mounted) return
        setCustomMounted(true)
      }).catch(() => undefined)
    return () => {
      disposed = true
      void mount?.dispose()
    }
    // The plugin renderer owns its draft after mounting; draft changes must not
    // tear down and recreate that renderer.
  }, [controlId, field.disabled, field.path, field.required, model, pluginId])
  useLayoutEffect(() => {
    if (!customMounted) return
    const focusable = custom.current?.querySelector<HTMLElement>('input,select,textarea,button,[tabindex]')
    if (focusable !== null && focusable !== undefined) {
      focusable.id = controlId
      focusable.dataset.hostFormPrimitive = 'custom'
      const labelId = custom.current?.closest('.cxf-control-seat')?.getAttribute('aria-labelledby')
      if (labelId) focusable.setAttribute('aria-labelledby', `${labelId}-text`)
      focusable.setAttribute(
        'aria-describedby',
        `${field.description === undefined ? '' : `${controlId}-help `}${controlId}-error`,
      )
      if (field.required) focusable.setAttribute('aria-required', 'true')
    }
  }, [customMounted, controlId, field.description, field.required])
  return (
    <>
      {customMounted ? null : (
        <div>
          <Control
            field={blocked && !field.disabled ? { ...field, disabled: true } : field}
            resolved={resolved}
            value={value}
            onChange={onChange}
            controlId={controlId}
            locale={locale}
          />
        </div>
      )}
      <div
        ref={custom}
        className="cxm-config-renderer cxf-custom-seat"
        hidden={!customMounted}
        inert={blocked}
        aria-disabled={blocked}
      />
    </>
  )
}

type FieldLabelProps =
  & { readonly field: CordisXConfigFieldSnapshot; readonly labelId: string }
  & (
    | { readonly mode: 'static' }
    | {
      readonly mode: 'menu'
      readonly changed: boolean
      readonly locale: string
      readonly onUseDefault: () => void
      readonly onRollback: () => void
      readonly onCopyPath: () => void
    }
  )

function FieldLabel(props: FieldLabelProps) {
  const { field } = props
  if (props.mode === 'static') {
    return (
      <span className="cxf-field-label">
        {field.icon === undefined ? null : (
          <span className="cxf-field-icon" aria-hidden="true">
            <HostSurfaceIcon token={field.icon} />
          </span>
        )}
        <span id={props.labelId} className="cxf-field-label-text cxf-label">
          {field.label ?? humanizeFieldName(field.path.at(-1))}
        </span>
      </span>
    )
  }
  const icon = <HostSurfaceIcon token={field.icon ?? 'host:settings'} />
  const { changed, locale, onUseDefault, onRollback, onCopyPath } = props
  const options: DropdownOption[] = [
    {
      value: 'default',
      content: managerCopy(locale, 'form.use-default'),
      prefixIcon: <HostSurfaceIcon token="host:reset" />,
      disabled: field.disabled || field.hasDefault !== true,
    },
    {
      value: 'rollback',
      content: managerCopy(locale, 'form.rollback-field'),
      prefixIcon: <HostSurfaceIcon token="host:reset" />,
      disabled: field.disabled || !changed,
    },
    {
      value: 'copy',
      content: managerCopy(locale, 'form.copy-path'),
      prefixIcon: <HostSurfaceIcon token="host:files" />,
    },
  ]
  return (
    <span className="cxf-field-label">
      <Dropdown
        trigger="click"
        placement="bottom-left"
        options={options}
        minColumnWidth={208}
        onClick={item => {
          if (item.value === 'default') onUseDefault()
          else if (item.value === 'rollback') onRollback()
          else if (item.value === 'copy') onCopyPath()
        }}
      >
        <Button
          tag="button"
          type="button"
          shape="square"
          variant="text"
          className="cxf-field-menu-trigger"
          aria-label={managerCopy(locale, 'form.field-actions')}
          aria-haspopup="menu"
          data-host-form-action="field-actions"
          data-host-form-action-icon={field.icon ?? 'host:settings'}
          icon={icon}
        />
      </Dropdown>
      <span id={props.labelId} className="cxf-field-label-text cxf-label">
        {field.label ?? humanizeFieldName(field.path.at(-1))}
      </span>
    </span>
  )
}

interface HostFieldRowBaseProps {
  readonly field: CordisXConfigFieldSnapshot
  readonly value: unknown
  readonly changed: boolean
  readonly locale: string
  readonly idPrefix: string
  readonly issueText?: string
  readonly forceFullWidth?: boolean
  readonly controlId?: string
  readonly transientSecret?: boolean
  readonly disabled?: boolean
  readonly customControl?: { readonly model: ManagerModel; readonly pluginId: string }
  readonly onChange: (value: unknown) => void
}

type HostFieldRowActions =
  | {
    readonly fieldActions?: 'menu'
    readonly onUseDefault: () => void
    readonly onRollback: () => void
    readonly onCopyPath: () => void
  }
  | { readonly fieldActions: 'static' }

export type HostFieldRowProps = HostFieldRowBaseProps & HostFieldRowActions

/** Shared React field row used by plugin configuration and Host-owned draft forms. */
export function HostFieldRow(props: HostFieldRowProps) {
  const {
    field,
    value,
    changed,
    locale,
    idPrefix,
    issueText,
    forceFullWidth,
    controlId,
    transientSecret,
    customControl,
    onChange,
  } = props
  const disabled = field.disabled || props.disabled === true
  const controlField = disabled && !field.disabled ? { ...field, disabled: true } : field
  const controlSeat = useRef<HTMLDivElement>(null)
  const resolved = primitive(field)
  const resolution = resolveFormPresenter(descriptor(field))
  const labelId = `cxf-label-${encodeURIComponent(idPrefix)}-${field.path.map(encodeURIComponent).join('-')}`
  const resolvedControlId = controlId ?? `cxm-config-${idPrefix}-${field.path.join('-')}`
  useLayoutEffect(() => {
    const controls = controlSeat.current?.querySelectorAll<HTMLElement>(
      'input,textarea,[role="switch"],[role="slider"]',
    )
    controls?.forEach((control, index) => {
      control.id = index === 0 ? resolvedControlId : `${resolvedControlId}-${index}`
      control.setAttribute('aria-labelledby', `${labelId}-text`)
      control.setAttribute(
        'aria-describedby',
        `${field.description === undefined ? '' : `${resolvedControlId}-help `}${resolvedControlId}-error`,
      )
      control.setAttribute('aria-required', String(field.required))
      control.setAttribute('aria-invalid', String(issueText !== undefined))
    })
  }, [field.description, field.required, issueText, labelId, resolvedControlId, resolved, value])
  return (
    <div
      className="cxf-item"
      data-config-path={field.path.join('.')}
      data-host-form-primitive={resolved}
      data-full-width={String(forceFullWidth === true || fullWidth(resolved))}
      data-control-layout={resolution.layout}
      data-primitive={resolved}
      data-presenter={field.presenter?.kind ?? 'auto'}
      data-invalid={String(issueText !== undefined)}
    >
      <div className="cxf-label-row" id={labelId}>
        {props.fieldActions === 'static'
          ? <FieldLabel field={controlField} labelId={`${labelId}-text`} mode="static" />
          : (
            <FieldLabel
              field={controlField}
              labelId={`${labelId}-text`}
              mode="menu"
              changed={changed}
              locale={locale}
              onUseDefault={() => {
                if (!disabled) props.onUseDefault()
              }}
              onRollback={() => {
                if (!disabled) props.onRollback()
              }}
              onCopyPath={props.onCopyPath}
            />
          )}
        {field.required
          ? <span className="cxf-required" aria-label={managerCopy(locale, 'form.required')}>*</span>
          : null}
      </div>
      <div ref={controlSeat} className="cxf-control-seat" role="group" aria-labelledby={labelId}>
        {customControl === undefined || resolved === 'sensitive-unavailable'
          ? (
            <Control
              field={controlField}
              resolved={resolved}
              value={value}
              onChange={onChange}
              controlId={resolvedControlId}
              locale={locale}
              {...(transientSecret === undefined ? {} : { transientSecret })}
            />
          )
          : (
            <ConfigControl
              {...customControl}
              field={field}
              blocked={disabled}
              value={value}
              resolved={resolved}
              onChange={onChange}
              controlId={resolvedControlId}
              locale={locale}
            />
          )}
      </div>
      {field.description === undefined
        ? null
        : <p id={`${resolvedControlId}-help`} className="cxf-help">{field.description}</p>}
      {issueText === undefined
        ? <p className="cxf-error" id={`${resolvedControlId}-error`} role="alert" hidden />
        : <p className="cxf-error" id={`${resolvedControlId}-error`} role="alert">{issueText}</p>}
    </div>
  )
}

export function HostForm({ model, plugin }: { readonly model: ManagerModel; readonly plugin: ManagerPluginSnapshot }) {
  const shell = useRef<HTMLDivElement>(null)
  const [committedValues, setCommittedValues] = useState<ReadonlyMap<string, unknown>>(() => new Map())
  const fields = useMemo(() =>
    plugin.configuration.fields.map(field =>
      committedValues.has(pathKey(field))
        ? { ...field, value: committedValues.get(pathKey(field)) as CordisXJsonValue }
        : field
    ), [committedValues, plugin.configuration.fields])
  const [draftOperations, setDraftOperations] = useState<ReadonlyMap<string, ConfigMutationOperation>>(() => new Map())
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string>()
  const [formState, setFormState] = useState<'pristine' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error'>(
    'pristine',
  )
  const locale = model.snapshot().localization.locale
  const submission = useRef(0)
  const submitting = useRef(false)
  useEffect(() => {
    submission.current += 1
    submitting.current = false
    setSaving(false)
    setCommittedValues(new Map())
    setDraftOperations(new Map())
    setFormState('pristine')
    setMessage(undefined)
    return () => {
      submission.current += 1
    }
  }, [plugin.id, plugin.configuration.revision])
  const groups = useMemo(() => {
    const result = new Map<string, { title?: string; description?: string; fields: CordisXConfigFieldSnapshot[] }>()
    for (const field of fields) {
      const id = field.group?.id ?? 'general'
      const current = result.get(id)
        ?? {
          ...(field.group?.title === undefined ? {} : { title: field.group.title }),
          ...(field.group?.description === undefined ? {} : { description: field.group.description }),
          fields: [],
        }
      current.fields.push(field)
      result.set(id, current)
    }
    return [...result.entries()]
  }, [fields])
  const formDraft = useMemo(() => {
    const next = new FormDraft(Object.fromEntries(fields.map(field => [pathKey(field), field.value])))
    for (const operation of draftOperations.values()) {
      if (operation.op === 'unset') next.unset(operation.path)
      else next.set(operation.path, operation.value)
    }
    return next
  }, [draftOperations, fields])
  const operations = [...draftOperations.values()]
  const change = (field: CordisXConfigFieldSnapshot, operation: ConfigMutationOperation) =>
    flushSync(() => {
      setFormState('dirty')
      setMessage(undefined)
      setDraftOperations(current => {
        const next = new Map(current)
        next.set(pathKey(field), operation)
        return next
      })
    })
  const rollback = (field: CordisXConfigFieldSnapshot) =>
    setDraftOperations(current => {
      const next = new Map(current)
      next.delete(pathKey(field))
      return next
    })
  return (
    <div ref={shell} className="cxf-react-form-shell" data-plugin-config-form={plugin.id} data-state={formState}>
      <Form
        className="cxf-react-form"
        onSubmit={event => {
          event.e?.preventDefault()
          if (
            model.updatePluginConfig === undefined || !plugin.configuration.writable || operations.length === 0
            || submitting.current || formState === 'saved'
          ) return
          const invalid = fields.find(field =>
            !field.disabled && primitive(field) !== 'sensitive-unavailable'
            && hostFormValidationIssueText(field, formDraft.value(field.path, field.defaultValue), locale) !== undefined
          )
          if (invalid !== undefined) {
            setFormState('error')
            setMessage(managerCopy(locale, 'form.fix-invalid-fields'))
            shell.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
            return
          }
          const currentSubmission = ++submission.current
          submitting.current = true
          setSaving(true)
          setFormState('saving')
          setMessage(undefined)
          void model.updatePluginConfig(plugin.id, plugin.configuration.revision, operations)
            .then(() => {
              if (submission.current !== currentSubmission) return
              setCommittedValues(
                new Map(fields.map(field => [pathKey(field), formDraft.value(field.path, field.defaultValue)])),
              )
              setDraftOperations(new Map())
              setFormState('saved')
              setMessage(managerCopy(locale, 'form.configuration-saved'))
            })
            .catch(error => {
              if (submission.current !== currentSubmission) return
              const text = error instanceof Error ? error.message : String(error)
              const conflict = /conflict|revision/iu.test(text)
              setFormState(conflict ? 'conflict' : 'error')
              setMessage(conflict ? managerCopy(locale, 'form.conflict-retained') : text)
            })
            .finally(() => {
              if (submission.current !== currentSubmission) return
              submitting.current = false
              setSaving(false)
            })
        }}
      >
        <HostFormPageStack
          key={`${plugin.id}:${plugin.configuration.revision}`}
          resetKey={plugin.configuration.revision}
        >
          <div className="cxf-form-body">
            {groups.map(([id, group]) => (
              <section key={id} className="cxf-section">
                {group.title === undefined && group.description === undefined
                  ? null
                  : (
                    <header className="cxf-section-heading">
                      {group.title === undefined ? null : <h3>{group.title}</h3>}
                      {group.description === undefined ? null : <p>{group.description}</p>}
                    </header>
                  )}
                <div className="cxf-form-grid">
                  {group.fields.map(field => {
                    const value = formDraft.value(field.path, field.defaultValue)
                    const changed = formDraft.isDirty(field.path)
                    const issueText = hostFormValidationIssueText(field, value, locale)
                    return (
                      <HostFieldRow
                        key={pathKey(field)}
                        field={field}
                        disabled={saving}
                        value={value}
                        changed={changed}
                        locale={locale}
                        idPrefix={plugin.id}
                        controlId={`cxm-config-${plugin.id}-${fields.indexOf(field)}`}
                        customControl={{ model, pluginId: plugin.id }}
                        {...(issueText === undefined ? {} : { issueText })}
                        onUseDefault={() => {
                          if (field.hasDefault === true) change(field, { op: 'unset', path: field.path })
                        }}
                        onRollback={() => rollback(field)}
                        onCopyPath={() => {
                          const clipboard = window.navigator.clipboard
                          if (typeof clipboard?.writeText !== 'function') {
                            setMessage(managerCopy(locale, 'form.path-copy-unavailable'))
                            return
                          }
                          void clipboard.writeText(field.path.join('.')).then(() =>
                            setMessage(managerCopy(locale, 'form.path-copied'))
                          ).catch(() => setMessage(managerCopy(locale, 'form.path-copy-unavailable')))
                        }}
                        onChange={next =>
                          change(
                            field,
                            next === undefined
                              ? { op: 'unset', path: field.path }
                              : { op: 'set', path: field.path, value: next as CordisXJsonValue },
                          )}
                      />
                    )
                  })}
                </div>
              </section>
            ))}
            {message === undefined
              ? null
              : (
                <div
                  className="cxr-notice cxf-alert"
                  data-tone={formState === 'saved' ? 'info' : 'error'}
                  role="status"
                >
                  {message}
                </div>
              )}
          </div>
          <div className="cxf-form-actions">
            <div className="cxf-status" data-state={formState} role="status">
              {operations.length === 0 || formState === 'saved'
                ? ''
                : formState === 'saving'
                ? managerCopy(locale, 'form.saving')
                : `${managerCopy(locale, 'form.dirty-prefix')} · ${managerCopy(locale, 'form.apply-live')}`}
            </div>
            <div className="cxf-form-action-buttons">
              <Button
                tag="button"
                type="reset"
                variant="outline"
                icon={<HostSurfaceIcon token="host:reset" />}
                disabled={saving || operations.length === 0 || formState === 'saved'}
                onClick={() => {
                  setDraftOperations(new Map())
                  setFormState('pristine')
                  setMessage(undefined)
                }}
              >
                {managerCopy(locale, 'form.undo-changes')}
              </Button>
              <Button
                tag="button"
                type="submit"
                theme="primary"
                icon={<HostSurfaceIcon token="host:save" />}
                loading={saving}
                disabled={saving || !plugin.configuration.writable || operations.length === 0 || formState === 'saved'}
              >
                {managerCopy(locale, 'form.save-configuration')}
              </Button>
            </div>
          </div>
        </HostFormPageStack>
      </Form>
    </div>
  )
}
