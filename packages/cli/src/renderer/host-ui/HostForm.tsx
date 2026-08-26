import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Button, Checkbox, ColorPicker, DatePicker, Dropdown, Form, Input, InputNumber,
  RadioGroup, Select, Slider, Switch, TagInput, Textarea, TimePicker,
  type DropdownOption,
} from 'tdesign-react'
import {
  FormDraft, resolveFormPresenter, validateFormValue,
  type FormDescriptor, type FormPrimitive,
} from '@cordisx/schemastery-ui'
import type { CordisXConfigFieldSnapshot, CordisXJsonValue } from '../../contracts.js'
import type { ManagerModel, ManagerPluginSnapshot } from '../manager.js'
import type { ConfigMutationOperation } from '../configuration.js'
import { managerCopy } from '../ui-copy.js'
import { ArrayEditor } from './ArrayEditor.js'
import { HostSurfaceIcon } from './HostSurfaceIcon.js'

export const HOST_FORM_REACT_STYLES = String.raw`
  .cxf-react-form { display: grid; gap: 1.35rem; width: 100%; min-width: 0; margin: 0; padding: 4px 0 16px; }
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
  .cxf-field-menu-trigger .t-icon { display: block; font-size: 15px; }
  .cxf-control-seat { grid-area: control; min-width: 0; justify-self: stretch; }
  .cxf-item[data-control-layout="compact"] .cxf-control-seat { width: auto; max-width: 100%; padding-right: 10px; justify-self: end; }
  .cxf-item[data-control-layout="compact"] .t-input-number { width: 116px; }
  .cxf-item[data-control-layout="compact"] .t-radio-group { width: fit-content; max-width: 100%; }
  .cxf-help, .cxf-error { margin: 0; overflow-wrap: anywhere; font-size: 11px; line-height: 1.45; }
  .cxf-help { grid-area: help; color: var(--cx-muted,#9ca5b5); }
  .cxf-error { grid-area: error; color: var(--cx-danger,#e34d59); }
  .cxf-control-seat .t-input-number, .cxf-control-seat .t-input-number__input, .cxf-control-seat .t-input-number .t-input { min-width: 0; max-width: 100%; }
  .cxf-control-seat > .t-date-picker, .cxf-control-seat > .t-time-picker { width: 100%; }
  .cxf-textarea textarea { min-height: 104px !important; resize: vertical; }
  .cxf-json textarea { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 12px; }
  .cxf-slider-control { display: grid; width: min(100%,368px); grid-template-columns: minmax(0,1fr) 104px; align-items: center; gap: 10px; }
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
  .cxf-array-dialog-fields { display: grid; gap: 12px; }
  .cxf-array-dialog-fields label { display: grid; gap: 5px; }
  .cxf-form-actions { display: flex; justify-content: flex-end; gap: 8px; }
  @media (max-width: 760px) {
    .cxf-item, .cxf-item[data-full-width="true"] { grid-template-columns: minmax(0,1fr); grid-template-areas: "label" "help" "control" "error"; align-items: start; gap: 5px; }
    .cxf-item[data-control-layout="compact"] .cxf-control-seat { padding-right: 0; justify-self: start; }
  }
`

const SENSITIVE_ROLES = new Set(['secret', 'credential', 'credential-ref', 'permission', 'capability'])

function pathKey(field: CordisXConfigFieldSnapshot): string { return field.path.join('.') }

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
  return ['textarea', 'json-textarea', 'path-input', 'tag-input', 'multi-select', 'object-array', 'unsupported', 'sensitive-unavailable'].includes(resolved)
}

function numericProps(field: Pick<CordisXConfigFieldSnapshot, 'min' | 'max' | 'step'>) {
  return {
    ...(field.min === undefined ? {} : { min: field.min }),
    ...(field.max === undefined ? {} : { max: field.max }),
    ...(field.step === undefined ? {} : { step: field.step }),
  }
}

function Control({ field, resolved, value, onChange, controlId, transientSecret }: {
  readonly field: CordisXConfigFieldSnapshot
  readonly resolved: ReturnType<typeof primitive>
  readonly value: unknown
  readonly onChange: (value: unknown) => void
  readonly controlId?: string
  readonly transientSecret?: boolean
}) {
  const choices = field.choices?.flatMap(choice => choice.value === null ? [] : [{ label: choice.label, value: choice.value }]) ?? []
  if (resolved === 'sensitive-unavailable') return <Input value="由 Host 凭据管理" disabled />
  if (resolved === 'unsupported') return <div className="cxr-notice">当前 Schemastery 字段无法安全编辑</div>
  if (resolved === 'object-array') return <ArrayEditor field={field} value={Array.isArray(value) ? value as Record<string, unknown>[] : []} onChange={onChange} />
  if (resolved === 'textarea') return <Textarea className="cxf-textarea" value={typeof value === 'string' ? value : ''} autosize={{ minRows: 5, maxRows: 14 }} disabled={field.disabled} onChange={onChange} />
  if (resolved === 'json-textarea') return <Textarea className="cxf-textarea cxf-json" value={typeof value === 'string' ? value : JSON.stringify(value, null, 2)} autosize={{ minRows: 5, maxRows: 18 }} disabled={field.disabled} onChange={text => { try { onChange(JSON.parse(text)) } catch { /* retain the last valid value */ } }} />
  if (resolved === 'checkbox') return <Checkbox checked={value === true} disabled={field.disabled} onChange={onChange} />
  if (resolved === 'switch') return <Switch value={value === true} disabled={field.disabled} onChange={onChange} />
  if (resolved === 'slider') return <div className="cxf-slider-control"><Slider value={typeof value === 'number' ? value : 0} {...numericProps(field)} disabled={field.disabled} onChange={onChange} /><InputNumber {...(typeof value === 'number' ? { value } : {})} {...numericProps(field)} disabled={field.disabled} onChange={onChange} /></div>
  if (resolved === 'number-input') return <InputNumber {...(typeof value === 'number' ? { value } : {})} {...numericProps(field)} disabled={field.disabled} onChange={onChange} />
  if (resolved === 'radio') return <RadioGroup {...(field.presenter?.kind === 'choice.segmented' ? { className: 'cxf-segmented' } : {})} variant={field.presenter?.kind === 'choice.segmented' ? 'primary-filled' : 'default-filled'} value={value as string | number | boolean} options={choices} disabled={field.disabled} onChange={onChange} />
  if (resolved === 'select') return <Select {...(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? { value } : {})} options={choices} disabled={field.disabled} clearable={!field.required} onChange={onChange} />
  if (resolved === 'multi-select') return <Select multiple value={Array.isArray(value) ? value as (string | number)[] : []} options={choices} disabled={field.disabled} onChange={onChange} />
  if (resolved === 'tag-input') return <TagInput value={Array.isArray(value) ? value.map(String) : []} disabled={field.disabled} onChange={onChange} />
  if (resolved === 'date-picker') return <DatePicker value={typeof value === 'string' ? value : ''} enableTimePicker={field.role === 'datetime'} format={field.role === 'datetime' ? 'YYYY-MM-DD HH:mm:ss' : 'YYYY-MM-DD'} disabled={field.disabled} onChange={onChange} />
  if (resolved === 'time-picker') return <TimePicker value={typeof value === 'string' ? value : ''} disabled={field.disabled} onChange={onChange} />
  if (resolved === 'color-picker') return <ColorPicker value={typeof value === 'string' ? value : ''} disabled={field.disabled} onChange={onChange} />
  return <Input {...(controlId === undefined ? {} : { id: controlId })} type={field.role === 'url' ? 'url' : field.role === 'password' ? 'password' : 'text'} value={typeof value === 'string' ? value : ''} disabled={field.disabled} {...(field.role === 'password' ? { autocomplete: 'new-password' } : {})} {...(transientSecret === true ? { 'data-channel-credential-capture': 'true' } : {})} onChange={onChange} />
}

function ConfigControl({ model, pluginId, field, value, resolved, onChange, controlId }: {
  readonly model: ManagerModel
  readonly pluginId: string
  readonly field: CordisXConfigFieldSnapshot
  readonly value: unknown
  readonly resolved: ReturnType<typeof primitive>
  readonly onChange: (value: unknown) => void
  readonly controlId: string
}) {
  const custom = useRef<HTMLDivElement>(null)
  const latestChange = useRef(onChange)
  latestChange.current = onChange
  const [customMounted, setCustomMounted] = useState(false)
  useEffect(() => {
    if (model.mountConfigRenderer === undefined || custom.current === null || field.disabled) return
    let disposed = false
    let mount: Awaited<ReturnType<NonNullable<ManagerModel['mountConfigRenderer']>>> | undefined
    void model.mountConfigRenderer(pluginId, { ...field, value }, custom.current, next => latestChange.current(next)).then(next => {
      if (disposed) { void next.dispose(); return }
      mount = next
      if (!next.mounted) return
      const focusable = custom.current?.querySelector<HTMLElement>('input,select,textarea,button,[tabindex]')
      if (focusable !== null && focusable !== undefined) {
        if (focusable.id === '') focusable.id = controlId
        focusable.dataset.hostFormPrimitive = 'custom'
        focusable.setAttribute('aria-describedby', `${controlId}-error`)
        if (field.required) focusable.setAttribute('aria-required', 'true')
      }
      setCustomMounted(true)
    }).catch(() => undefined)
    return () => { disposed = true; void mount?.dispose() }
  // The plugin renderer owns its draft after mounting; draft changes must not
  // tear down and recreate that renderer.
  }, [controlId, field.disabled, field.path, field.required, model, pluginId])
  return <>
    <div hidden={customMounted}><Control field={field} resolved={resolved} value={value} onChange={onChange} controlId={controlId} /></div>
    <div ref={custom} className="cxm-config-renderer cxf-custom-seat" hidden={!customMounted} />
  </>
}

function FieldLabel({ field, changed, locale, onUseDefault, onRollback, onCopyPath }: {
  readonly field: CordisXConfigFieldSnapshot
  readonly changed: boolean
  readonly locale: string
  readonly onUseDefault: () => void
  readonly onRollback: () => void
  readonly onCopyPath: () => void
}) {
  const options: DropdownOption[] = [
    { value: 'default', content: managerCopy(locale, 'form.use-default'), prefixIcon: <HostSurfaceIcon token="host:reset" />, disabled: field.hasDefault !== true },
    { value: 'rollback', content: managerCopy(locale, 'form.rollback-field'), prefixIcon: <HostSurfaceIcon token="host:reset" />, disabled: !changed },
    { value: 'copy', content: managerCopy(locale, 'form.copy-path'), prefixIcon: <HostSurfaceIcon token="host:files" /> },
  ]
  return <span className="cxf-field-label">
    <Dropdown trigger="click" placement="bottom-left" options={options} minColumnWidth={208} onClick={item => {
      if (item.value === 'default') onUseDefault()
      else if (item.value === 'rollback') onRollback()
      else if (item.value === 'copy') onCopyPath()
    }}>
      <Button type="button" shape="square" variant="text" className="cxf-field-menu-trigger" aria-label={managerCopy(locale, 'form.field-actions')} aria-haspopup="menu" data-host-form-action="field-actions" data-host-form-action-icon={field.icon ?? 'host:settings'} icon={<HostSurfaceIcon token={field.icon ?? 'host:settings'} />} />
    </Dropdown>
    <span className="cxf-field-label-text cxf-label">{field.label ?? field.path.at(-1)}</span>
  </span>
}

export interface HostFieldRowProps {
  readonly field: CordisXConfigFieldSnapshot
  readonly value: unknown
  readonly changed: boolean
  readonly locale: string
  readonly idPrefix: string
  readonly issueText?: string
  readonly forceFullWidth?: boolean
  readonly controlId?: string
  readonly transientSecret?: boolean
  readonly customControl?: { readonly model: ManagerModel; readonly pluginId: string }
  readonly onChange: (value: unknown) => void
  readonly onUseDefault: () => void
  readonly onRollback: () => void
  readonly onCopyPath: () => void
}

/** Shared React field row used by plugin configuration and Host-owned draft forms. */
export function HostFieldRow({ field, value, changed, locale, idPrefix, issueText, forceFullWidth, controlId, transientSecret, customControl, onChange, onUseDefault, onRollback, onCopyPath }: HostFieldRowProps) {
  const resolved = primitive(field)
  const resolution = resolveFormPresenter(descriptor(field))
  const labelId = `cxf-label-${encodeURIComponent(idPrefix)}-${field.path.map(encodeURIComponent).join('-')}`
  const resolvedControlId = controlId ?? `cxm-config-${idPrefix}-${field.path.join('-')}`
  return <div className="cxf-item" data-config-path={field.path.join('.')} data-host-form-primitive={resolved} data-full-width={String(forceFullWidth === true || fullWidth(resolved))} data-control-layout={resolution.layout} data-primitive={resolved} data-presenter={field.presenter?.kind ?? 'auto'} data-invalid={String(issueText !== undefined)}>
    <div className="cxf-label-row" id={labelId}>
      <FieldLabel field={field} changed={changed} locale={locale} onUseDefault={onUseDefault} onRollback={onRollback} onCopyPath={onCopyPath} />
      {field.required ? <span className="cxf-required" aria-label={managerCopy(locale, 'form.required')}>*</span> : null}
    </div>
    <div className="cxf-control-seat" role="group" aria-labelledby={labelId}>{customControl === undefined || resolved === 'sensitive-unavailable'
      ? <Control field={field} resolved={resolved} value={value} onChange={onChange} controlId={resolvedControlId} {...(transientSecret === undefined ? {} : { transientSecret })} />
      : <ConfigControl {...customControl} field={field} value={value} resolved={resolved} onChange={onChange} controlId={resolvedControlId} />}</div>
    {field.description === undefined ? null : <p className="cxf-help">{field.description}</p>}
    {issueText === undefined ? <p className="cxf-error" id={`${resolvedControlId}-error`} role="alert" hidden /> : <p className="cxf-error" id={`${resolvedControlId}-error`} role="alert">{issueText}</p>}
  </div>
}

export function HostForm({ model, plugin }: { readonly model: ManagerModel; readonly plugin: ManagerPluginSnapshot }) {
  const fields = plugin.configuration.fields
  const [draftOperations, setDraftOperations] = useState<ReadonlyMap<string, ConfigMutationOperation>>(() => new Map())
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string>()
  const [formState, setFormState] = useState<'pristine' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error'>('pristine')
  const locale = model.snapshot().localization.locale
  useEffect(() => { setDraftOperations(new Map()); setFormState('pristine'); setMessage(undefined) }, [plugin.configuration.revision])
  const groups = useMemo(() => {
    const result = new Map<string, { title: string; description?: string; fields: CordisXConfigFieldSnapshot[] }>()
    for (const field of fields) {
      const id = field.group?.id ?? 'general'
      const current = result.get(id) ?? { title: field.group?.title ?? '常规', ...(field.group?.description === undefined ? {} : { description: field.group.description }), fields: [] }
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
  const change = (field: CordisXConfigFieldSnapshot, operation: ConfigMutationOperation) => { setFormState('dirty'); setMessage(undefined); setDraftOperations(current => {
    const next = new Map(current); next.set(pathKey(field), operation); return next
  }) }
  const rollback = (field: CordisXConfigFieldSnapshot) => setDraftOperations(current => {
    const next = new Map(current); next.delete(pathKey(field)); return next
  })
  return <Form className="cxf-react-form" data-plugin-config-form={plugin.id} data-state={formState} onSubmit={event => {
    event.e?.preventDefault()
    if (model.updatePluginConfig === undefined || operations.length === 0) return
    setSaving(true); setFormState('saving'); setMessage(undefined)
    void model.updatePluginConfig(plugin.id, plugin.configuration.revision, operations)
      .then(() => { setFormState('saved'); setMessage(managerCopy(locale, 'form.configuration-saved')) })
      .catch(error => { const text = error instanceof Error ? error.message : String(error); const conflict = /conflict|revision/iu.test(text); setFormState(conflict ? 'conflict' : 'error'); setMessage(conflict ? managerCopy(locale, 'form.conflict-retained') : text) })
      .finally(() => setSaving(false))
  }}>
    {groups.map(([id, group]) => <section key={id} className="cxf-section">
      <header className="cxf-section-heading"><h3>{group.title}</h3>{group.description === undefined ? null : <p>{group.description}</p>}</header>
      <div className="cxf-form-grid">{group.fields.map((field, fieldIndex) => {
        const value = formDraft.value(field.path, field.defaultValue)
        const changed = formDraft.isDirty(field.path)
        const issue = validateFormValue(descriptor(field), value)[0]
        const issueText = issue?.code === 'required' ? managerCopy(locale, 'form.required')
          : issue?.code === 'choice' ? managerCopy(locale, 'form.choice-invalid')
            : issue?.code === 'number' ? managerCopy(locale, field.type === 'natural' ? 'form.natural-invalid' : 'form.number-invalid')
              : undefined
        return <HostFieldRow key={pathKey(field)} field={field} value={value} changed={changed} locale={locale} idPrefix={plugin.id} controlId={`cxm-config-${plugin.id}-${fieldIndex}`} customControl={{ model, pluginId: plugin.id }} {...(issueText === undefined ? {} : { issueText })} onUseDefault={() => { if (field.hasDefault === true) change(field, { op: 'unset', path: field.path }) }} onRollback={() => rollback(field)} onCopyPath={() => {
              const clipboard = window.navigator.clipboard
              if (typeof clipboard?.writeText !== 'function') { setMessage(managerCopy(locale, 'form.path-copy-unavailable')); return }
              void clipboard.writeText(field.path.join('.')).then(() => setMessage(managerCopy(locale, 'form.path-copied'))).catch(() => setMessage(managerCopy(locale, 'form.path-copy-unavailable')))
            }} onChange={next => change(field, next === undefined ? { op: 'unset', path: field.path } : { op: 'set', path: field.path, value: next as CordisXJsonValue })} />
      })}</div>
    </section>)}
    {message === undefined ? null : <div className="cxr-notice cxf-alert" data-tone={formState === 'saved' ? 'info' : 'error'} role="status">{message}</div>}
    <div className="cxf-status" data-state={formState} role="status">{operations.length === 0 ? '' : formState === 'saving' ? managerCopy(locale, 'form.saving') : `${managerCopy(locale, 'form.dirty-prefix')} · ${managerCopy(locale, 'form.apply-live')}`}</div>
    <div className="cxf-form-actions"><Button type="reset" variant="outline" disabled={saving || operations.length === 0} onClick={() => { setDraftOperations(new Map()); setFormState('pristine'); setMessage(undefined) }}>重置</Button><Button type="submit" theme="primary" loading={saving} disabled={!plugin.configuration.writable || operations.length === 0}>保存</Button></div>
  </Form>
}
