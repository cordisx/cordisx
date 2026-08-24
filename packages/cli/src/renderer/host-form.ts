import type { CordisXConfigFieldSnapshot, CordisXJsonScalar } from '../contracts.js'

export type HostFormPrimitive =
  | 'input' | 'textarea' | 'number-input' | 'select' | 'checkbox' | 'switch'
  | 'radio' | 'slider' | 'date' | 'time' | 'path-input' | 'json-textarea'
  | 'sensitive-unavailable' | 'unsupported'

export interface HostFormDiagnostic {
  readonly code: 'unsupported-schema-role' | 'unsupported-schema-field'
  readonly fieldPath: readonly string[]
  readonly detail: string
}

export interface HostFormControl {
  readonly root: HTMLElement
  readonly focusTarget?: HTMLElement
  readonly primitive: HostFormPrimitive
  readonly diagnostic?: HostFormDiagnostic
}

export interface HostFormItem {
  readonly root: HTMLDivElement
  readonly control: HTMLDivElement
  readonly label: HTMLLabelElement
  readonly help?: HTMLParagraphElement
  readonly error: HTMLParagraphElement
  setError(message?: string): void
}

const SENSITIVE_ROLES = new Set(['secret', 'credential', 'credential-ref', 'permission', 'capability'])
const KNOWN_ROLES = new Set([
  'checkbox', 'switch', 'radio', 'slider', 'textarea', 'multiline', 'path', 'file', 'directory',
  'date', 'time', 'color', 'duration', 'url',
])

export const HOST_FORM_STYLES = String.raw`
  .cxf-scope {
    --td-brand-color: var(--cx-primary);
    --td-brand-color-hover: var(--cx-text);
    --td-brand-color-focus: color-mix(in srgb, var(--cx-focus) 26%, transparent);
    --td-text-color-primary: var(--cx-text);
    --td-text-color-secondary: var(--cx-muted);
    --td-text-color-placeholder: color-mix(in srgb, var(--cx-muted) 78%, transparent);
    --td-text-color-disabled: color-mix(in srgb, var(--cx-muted) 65%, transparent);
    --td-bg-color-container: var(--cx-surface);
    --td-bg-color-specialcomponent: var(--cx-surface-raised);
    --td-bg-color-component-hover: var(--cx-hover);
    --td-bg-color-component-disabled: color-mix(in srgb, var(--cx-surface-raised) 70%, var(--cx-muted));
    --td-border-level-2-color: var(--cx-border);
    --td-error-color: var(--cx-danger);
    --td-radius-default: .5rem;
    --td-comp-size-m: 2rem;
    --td-comp-paddingLR-s: .625rem;
    color: var(--td-text-color-primary);
    font: inherit;
  }
  .cxf-form { display: grid; gap: 1rem; min-inline-size: 0; }
  .cxf-form-grid { display: grid; grid-template-columns: repeat(2, minmax(14rem, 1fr)); gap: .875rem 1rem; }
  .cxf-item { display: grid; align-content: start; gap: .375rem; min-inline-size: 0; }
  .cxf-item[data-full-width="true"] { grid-column: 1 / -1; }
  .cxf-label-row { display: flex; align-items: baseline; gap: .35rem; min-inline-size: 0; }
  .cxf-label { color: var(--td-text-color-primary); font-weight: 600; overflow-wrap: anywhere; }
  .cxf-required { color: var(--td-error-color); font-weight: 700; }
  .cxf-control-seat { min-inline-size: 0; }
  .cxf-control {
    box-sizing: border-box; inline-size: 100%; min-block-size: var(--td-comp-size-m); margin: 0;
    border: 1px solid var(--td-border-level-2-color); border-radius: var(--td-radius-default);
    padding: .375rem var(--td-comp-paddingLR-s); background: var(--td-bg-color-specialcomponent);
    color: var(--td-text-color-primary); font: inherit; line-height: 1.35; outline: none;
    transition: border-color .16s ease, box-shadow .16s ease, background-color .16s ease;
  }
  .cxf-control:hover:not(:disabled):not([readonly]) { border-color: var(--td-brand-color); }
  .cxf-control:focus-visible, .cxf-button:focus-visible, .cxf-choice input:focus-visible {
    border-color: var(--td-brand-color); outline: 2px solid var(--td-brand-color-focus); outline-offset: 1px;
  }
  .cxf-control:disabled, .cxf-control[readonly] { color: var(--td-text-color-disabled); background: var(--td-bg-color-component-disabled); }
  .cxf-control:disabled { cursor: not-allowed; opacity: var(--cx-disabled); }
  .cxf-textarea { min-block-size: 6.5rem; resize: vertical; }
  .cxf-json { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
  .cxf-checkline { display: inline-flex; align-items: center; gap: .5rem; min-block-size: 2rem; color: var(--td-text-color-primary); }
  .cxf-checkline input { inline-size: 1rem; block-size: 1rem; margin: 0; accent-color: var(--td-brand-color); }
  .cxf-switch { appearance: none; inline-size: 2.25rem !important; block-size: 1.25rem !important; border: 0; border-radius: 999px; background: var(--td-border-level-2-color); position: relative; }
  .cxf-switch::after { content: ""; position: absolute; inset-block-start: .1875rem; inset-inline-start: .1875rem; inline-size: .875rem; block-size: .875rem; border-radius: 50%; background: var(--td-bg-color-container); transition: transform .16s ease; }
  .cxf-switch:checked { background: var(--td-brand-color); }
  .cxf-switch:checked::after { transform: translateX(1rem); }
  .cxf-scope:dir(rtl) .cxf-switch:checked::after { transform: translateX(-1rem); }
  .cxf-radio-group { display: flex; flex-wrap: wrap; gap: .5rem 1rem; padding-block: .25rem; }
  .cxf-choice { display: inline-flex; align-items: center; gap: .4rem; min-block-size: 2rem; }
  .cxf-choice input { margin: 0; accent-color: var(--td-brand-color); }
  .cxf-range { padding-inline: 0; accent-color: var(--td-brand-color); }
  .cxf-help, .cxf-error { margin: 0; overflow-wrap: anywhere; font-size: .82em; line-height: 1.45; }
  .cxf-help { color: var(--td-text-color-secondary); }
  .cxf-error { color: var(--td-error-color); }
  .cxf-error[hidden] { display: none; }
  .cxf-item[data-invalid="true"] .cxf-control { border-color: var(--td-error-color); }
  .cxf-custom-seat { min-block-size: 2rem; }
  .cxf-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: .5rem; grid-column: 1 / -1; }
  .cxf-status { margin-inline-end: auto; color: var(--td-text-color-secondary); font-size: .82em; }
  .cxf-status[data-state="dirty"] { color: var(--td-brand-color); }
  .cxf-status[data-state="saved"] { color: #52c41a; }
  .cxf-button {
    display: inline-flex; align-items: center; justify-content: center; gap: .375rem; min-block-size: 2rem;
    border: 1px solid var(--td-border-level-2-color); border-radius: var(--td-radius-default);
    padding: .375rem .75rem; background: var(--td-bg-color-specialcomponent); color: var(--td-text-color-primary);
    font: inherit; line-height: 1.25; cursor: pointer;
  }
  .cxf-button:hover:not(:disabled) { border-color: var(--td-brand-color); background: var(--td-bg-color-component-hover); }
  .cxf-button[data-variant="primary"] { border-color: var(--td-brand-color); background: var(--td-brand-color); color: var(--cx-primary-text); }
  .cxf-button[data-tone="danger"] { color: var(--td-error-color); }
  .cxf-button:disabled { cursor: default; opacity: var(--cx-disabled); }
  .cxf-alert { border: 1px solid var(--td-border-level-2-color); border-radius: var(--td-radius-default); padding: .625rem .75rem; background: var(--td-bg-color-specialcomponent); color: var(--td-text-color-secondary); overflow-wrap: anywhere; }
  .cxf-alert[data-tone="error"] { border-color: color-mix(in srgb, var(--td-error-color) 55%, transparent); color: var(--td-error-color); }
  .cxf-alert[data-tone="warning"] { border-color: #b88a2f; color: #e7bd6a; }
  .cxf-empty { padding: 1.25rem; text-align: center; color: var(--td-text-color-secondary); }
  .cxf-loading { display: inline-flex; align-items: center; gap: .5rem; color: var(--td-text-color-secondary); }
  .cxf-loading::before { content: ""; inline-size: .875rem; block-size: .875rem; border: 2px solid var(--td-border-level-2-color); border-block-start-color: var(--td-brand-color); border-radius: 50%; animation: cxf-spin .8s linear infinite; }
  @keyframes cxf-spin { to { transform: rotate(360deg); } }
  @media (max-width: 760px) { .cxf-form-grid { grid-template-columns: minmax(0, 1fr); } }
  @media (forced-colors: active) { .cxf-control:focus-visible, .cxf-button:focus-visible, .cxf-choice input:focus-visible { outline: 2px solid Highlight; } }
  @media (prefers-reduced-motion: reduce) { .cxf-scope .cxf-control, .cxf-scope .cxf-button, .cxf-scope .cxf-switch::after { transition: none; } .cxf-loading::before { animation-duration: 1.6s; } }
`

function sensitive(field: CordisXConfigFieldSnapshot): boolean {
  return field.role !== undefined && SENSITIVE_ROLES.has(field.role)
}

function jsonLike(field: CordisXConfigFieldSnapshot): boolean {
  return ['object', 'array', 'tuple', 'dict', 'intersect'].includes(field.type)
    || (field.value !== null && typeof field.value === 'object')
}

export function selectHostFormPrimitive(field: CordisXConfigFieldSnapshot): HostFormPrimitive {
  if (sensitive(field)) return 'sensitive-unavailable'
  if (field.choices !== undefined) return field.role === 'radio' ? 'radio' : 'select'
  if (field.type === 'boolean') return field.role === 'switch' ? 'switch' : 'checkbox'
  if (field.type === 'number' || field.type === 'natural') return field.role === 'slider' ? 'slider' : 'number-input'
  if (field.type === 'string') {
    if (field.role === 'textarea' || field.role === 'multiline') return 'textarea'
    if (field.role === 'path' || field.role === 'file' || field.role === 'directory') return 'path-input'
    if (field.role === 'date') return 'date'
    if (field.role === 'time') return 'time'
    return 'input'
  }
  if (jsonLike(field)) return 'json-textarea'
  return 'unsupported'
}

export function hostFormDiagnostic(field: CordisXConfigFieldSnapshot): HostFormDiagnostic | undefined {
  const primitive = selectHostFormPrimitive(field)
  if (primitive === 'unsupported') return {
    code: 'unsupported-schema-field', fieldPath: field.path, detail: `unsupported Schemastery field type: ${field.type}`,
  }
  if (field.role !== undefined && !SENSITIVE_ROLES.has(field.role) && !KNOWN_ROLES.has(field.role)) return {
    code: 'unsupported-schema-role', fieldPath: field.path, detail: `unknown role ${field.role}; used ${primitive}`,
  }
  return undefined
}

export function validateHostFormValue(field: CordisXConfigFieldSnapshot, value: unknown): string | undefined {
  if (field.required && (value === undefined || value === null || value === '')) return '此项为必填项'
  if (value === undefined || value === null || value === '') return undefined
  if (field.choices !== undefined && !field.choices.some(choice => Object.is(choice.value, value))) return '请选择列表中的有效值'
  if (field.type === 'number' || field.type === 'natural') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '请输入有效数字'
    if (field.type === 'natural' && (!Number.isInteger(value) || value < 0)) return '请输入非负整数'
    if (field.min !== undefined && value < field.min) return `不能小于 ${field.min}`
    if (field.max !== undefined && value > field.max) return `不能大于 ${field.max}`
    if (field.step !== undefined && field.step > 0) {
      const origin = field.min ?? 0
      const quotient = (value - origin) / field.step
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) return `请按 ${field.step} 的步长输入`
    }
  }
  return undefined
}

function setCommonControlState(element: HTMLElement, field: CordisXConfigFieldSnapshot, id: string): void {
  element.id = id
  element.dataset.hostFormPrimitive = selectHostFormPrimitive(field)
  if (field.required) element.setAttribute('aria-required', 'true')
  if (field.disabled) element.setAttribute('aria-disabled', 'true')
}

export class HostFormAdapter {
  constructor(private readonly document: Document) {}

  form(id?: string): HTMLFormElement {
    const form = this.document.createElement('form')
    form.className = 'cxf-scope cxf-form'
    if (id !== undefined) form.dataset.hostForm = id
    return form
  }

  grid(): HTMLDivElement {
    const grid = this.document.createElement('div')
    grid.className = 'cxf-form-grid'
    return grid
  }

  item(options: { readonly id: string; readonly label: string; readonly help?: string; readonly required?: boolean; readonly fullWidth?: boolean }): HostFormItem {
    const root = this.document.createElement('div')
    root.className = 'cxf-item'
    root.dataset.fullWidth = String(options.fullWidth === true)
    const labelRow = this.document.createElement('div')
    labelRow.className = 'cxf-label-row'
    const label = this.document.createElement('label')
    label.className = 'cxf-label'
    label.id = `${options.id}-label`
    label.htmlFor = options.id
    label.textContent = options.label
    labelRow.append(label)
    if (options.required) {
      const required = this.document.createElement('span')
      required.className = 'cxf-required'
      required.setAttribute('aria-hidden', 'true')
      required.textContent = '*'
      labelRow.append(required)
    }
    const control = this.document.createElement('div')
    control.className = 'cxf-control-seat'
    let help: HTMLParagraphElement | undefined
    if (options.help !== undefined) {
      help = this.document.createElement('p')
      help.className = 'cxf-help'
      help.id = `${options.id}-help`
      help.textContent = options.help
    }
    const error = this.document.createElement('p')
    error.className = 'cxf-error'
    error.id = `${options.id}-error`
    error.hidden = true
    root.append(labelRow, control)
    if (help !== undefined) root.append(help)
    root.append(error)
    return {
      root, control, label, ...(help === undefined ? {} : { help }), error,
      setError: (message?: string): void => {
        error.textContent = message ?? ''
        error.hidden = message === undefined || message === ''
        root.dataset.invalid = String(!error.hidden)
        const target = control.querySelector<HTMLElement>('[data-host-form-primitive]')
        if (target !== null) {
          if (error.hidden) target.removeAttribute('aria-invalid')
          else target.setAttribute('aria-invalid', 'true')
        }
      },
    }
  }

  connect(item: HostFormItem, control: HostFormControl): void {
    const describedBy = [item.help?.id, item.error.id].filter(Boolean).join(' ')
    const target = control.primitive === 'radio' ? control.root : control.focusTarget ?? control.root
    target.setAttribute('aria-describedby', describedBy)
    if (control.primitive === 'radio') {
      item.label.removeAttribute('for')
      control.root.setAttribute('aria-labelledby', item.label.id)
    }
  }

  control(field: CordisXConfigFieldSnapshot, id: string, onDraft: (value: unknown, issue?: string) => void): HostFormControl {
    const primitive = selectHostFormPrimitive(field)
    const diagnostic = hostFormDiagnostic(field)
    if (primitive === 'sensitive-unavailable') return {
      root: this.alert('敏感字段由 Host credential 边界保留；当前版本不会显示、写入或交给自定义 renderer。', 'warning'),
      primitive,
    }
    if (primitive === 'unsupported') return {
      root: this.alert('此设置的结构当前无法安全编辑。', 'warning'), primitive, ...(diagnostic === undefined ? {} : { diagnostic }),
    }
    if (primitive === 'select') {
      const select = this.document.createElement('select')
      select.className = 'cxf-control'
      setCommonControlState(select, field, id)
      select.disabled = field.disabled
      for (const choice of field.choices!) {
        const option = this.document.createElement('option')
        option.value = JSON.stringify(choice.value)
        option.textContent = choice.label
        option.selected = Object.is(choice.value, field.value)
        select.append(option)
      }
      select.addEventListener('change', () => onDraft(JSON.parse(select.value) as CordisXJsonScalar))
      return { root: select, focusTarget: select, primitive, ...(diagnostic === undefined ? {} : { diagnostic }) }
    }
    if (primitive === 'radio') {
      const group = this.document.createElement('div')
      group.className = 'cxf-radio-group'
      group.setAttribute('role', 'radiogroup')
      setCommonControlState(group, field, id)
      for (const [index, choice] of field.choices!.entries()) {
        const label = this.document.createElement('label')
        label.className = 'cxf-choice'
        const input = this.document.createElement('input')
        input.type = 'radio'
        input.name = id
        input.value = String(index)
        input.checked = Object.is(choice.value, field.value)
        input.disabled = field.disabled
        input.addEventListener('change', () => { if (input.checked) onDraft(choice.value) })
        label.append(input, this.document.createTextNode(choice.label))
        group.append(label)
      }
      const focusTarget = group.querySelector<HTMLInputElement>('input')
      return { root: group, ...(focusTarget === null ? {} : { focusTarget }), primitive, ...(diagnostic === undefined ? {} : { diagnostic }) }
    }
    if (primitive === 'checkbox' || primitive === 'switch') {
      const label = this.document.createElement('label')
      label.className = 'cxf-checkline'
      const input = this.document.createElement('input')
      input.type = 'checkbox'
      input.checked = field.value === true
      input.disabled = field.disabled
      if (primitive === 'switch') {
        input.className = 'cxf-switch'
        input.setAttribute('role', 'switch')
      }
      setCommonControlState(input, field, id)
      input.addEventListener('change', () => onDraft(input.checked))
      const state = this.document.createElement('span')
      state.textContent = field.value === true ? '已开启' : '已关闭'
      input.addEventListener('change', () => { state.textContent = input.checked ? '已开启' : '已关闭' })
      label.append(input, state)
      return { root: label, focusTarget: input, primitive, ...(diagnostic === undefined ? {} : { diagnostic }) }
    }
    const input = primitive === 'textarea' || primitive === 'json-textarea'
      ? this.document.createElement('textarea')
      : this.document.createElement('input')
    input.className = `cxf-control${primitive === 'textarea' || primitive === 'json-textarea' ? ' cxf-textarea' : ''}${primitive === 'json-textarea' ? ' cxf-json' : ''}${primitive === 'slider' ? ' cxf-range' : ''}`
    setCommonControlState(input, field, id)
    input.disabled = field.disabled
    if (input instanceof this.document.defaultView!.HTMLInputElement) {
      input.type = primitive === 'number-input' ? 'number'
        : primitive === 'slider' ? 'range'
          : primitive === 'date' ? 'date'
            : primitive === 'time' ? 'time'
              : field.role === 'color' ? 'color'
                : field.role === 'url' ? 'url'
                : 'text'
      if (field.min !== undefined) input.min = String(field.min)
      if (field.max !== undefined) input.max = String(field.max)
      if (field.step !== undefined) input.step = String(field.step)
      input.value = typeof field.value === 'number' || typeof field.value === 'string' ? String(field.value) : ''
      if (primitive === 'path-input') input.placeholder = '/absolute/path'
      input.addEventListener('input', () => {
        const value = primitive === 'number-input' || primitive === 'slider'
          ? input.value === '' ? undefined : Number(input.value)
          : input.value
        onDraft(value, validateHostFormValue(field, value))
      })
    } else {
      input.value = primitive === 'json-textarea' ? JSON.stringify(field.value, null, 2) : String(field.value ?? '')
      input.addEventListener('input', () => {
        if (primitive !== 'json-textarea') {
          onDraft(input.value, validateHostFormValue(field, input.value))
          return
        }
        try {
          const value = JSON.parse(input.value) as unknown
          onDraft(value, validateHostFormValue(field, value))
        } catch {
          onDraft(undefined, '请输入有效 JSON')
        }
      })
    }
    return { root: input, focusTarget: input, primitive, ...(diagnostic === undefined ? {} : { diagnostic }) }
  }

  button(label: string, options: { readonly type?: 'button' | 'submit'; readonly variant?: 'default' | 'primary'; readonly tone?: 'default' | 'danger' } = {}): HTMLButtonElement {
    const button = this.document.createElement('button')
    button.className = 'cxf-button'
    button.type = options.type ?? 'button'
    button.textContent = label
    button.dataset.variant = options.variant ?? 'default'
    button.dataset.tone = options.tone ?? 'default'
    return button
  }

  alert(message: string, tone: 'info' | 'warning' | 'error' = 'info'): HTMLDivElement {
    const alert = this.document.createElement('div')
    alert.className = 'cxf-alert'
    alert.dataset.tone = tone
    alert.setAttribute('role', tone === 'error' ? 'alert' : 'status')
    alert.textContent = message
    return alert
  }

  empty(message: string): HTMLDivElement {
    const empty = this.document.createElement('div')
    empty.className = 'cxf-empty'
    empty.textContent = message
    return empty
  }

  loading(message: string): HTMLDivElement {
    const loading = this.document.createElement('div')
    loading.className = 'cxf-loading'
    loading.setAttribute('role', 'status')
    loading.setAttribute('aria-busy', 'true')
    loading.textContent = message
    return loading
  }
}
