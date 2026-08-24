import type { CordisXConfigFieldSnapshot, CordisXJsonScalar } from '../contracts.js'
import {
  createTDesignButton,
  createTDesignElement,
  createTDesignPortal,
  createTDesignSelect,
  setTDesignProps,
  TDESIGN_SCOPED_TOKEN_CSS,
  type TDesignButtonElement,
  type TDesignElement,
  type TDesignSelectElement,
  type TDesignSelectOption,
} from './tdesign-form.js'
import { managerCopy, productLocale } from './ui-copy.js'

export type HostFormPrimitive =
  | 'input' | 'textarea' | 'number-input' | 'select' | 'checkbox' | 'switch'
  | 'radio' | 'slider' | 'path-input' | 'json-textarea'
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

export type HostConfigApplyMode = 'live' | 'restart' | 'plugin-restart' | 'service-restart' | 'app-restart'
export type HostConfigApplyPhase = 'dirty' | 'saving' | 'saved'

/**
 * User-facing projection for configuration apply semantics. `restart` is the
 * legacy protocol spelling and is normalized to the precise plugin restart
 * behavior. The v2 values remain generic Host projections and introduce no
 * product-specific service fields.
 */
export function hostConfigApplyMessage(mode: HostConfigApplyMode, phase: HostConfigApplyPhase, locale = 'zh-CN'): string {
  if (phase === 'saving') return managerCopy(locale, 'form.saving')
  const action = mode === 'live' ? managerCopy(locale, 'form.apply-live')
    : mode === 'service-restart' ? managerCopy(locale, 'form.apply-service-restart')
      : mode === 'app-restart' ? managerCopy(locale, 'form.apply-app-restart')
        : managerCopy(locale, 'form.apply-plugin-restart')
  return phase === 'saved' ? action : `${managerCopy(locale, 'form.dirty-prefix')} · ${action}`
}

const SENSITIVE_ROLES = new Set(['secret', 'credential', 'credential-ref', 'permission', 'capability'])
const KNOWN_ROLES = new Set([
  'checkbox', 'switch', 'radio', 'slider', 'textarea', 'multiline', 'path', 'file', 'directory',
  'duration', 'url',
])

export const HOST_FORM_STYLES = `${TDESIGN_SCOPED_TOKEN_CSS}\n${String.raw`
  .cxf-scope {
    --td-brand-color: var(--cx-primary);
    --td-brand-color-hover: var(--cx-text);
    --td-brand-color-focus: color-mix(in srgb, var(--cx-focus) 26%, transparent);
    --td-text-color-primary: var(--cx-text);
    --td-text-color-secondary: var(--cx-muted);
    --td-text-color-placeholder: color-mix(in srgb, var(--cx-muted) 78%, transparent);
    --td-text-color-disabled: color-mix(in srgb, var(--cx-muted) 65%, transparent);
    --td-bg-color-container: var(--cx-surface);
    --td-bg-color-container-hover: var(--cx-hover);
    --td-bg-color-container-active: var(--cx-pressed);
    --td-bg-color-container-select: var(--cx-pressed);
    --td-bg-color-secondarycontainer: var(--cx-surface-raised);
    --td-bg-color-secondarycontainer-hover: var(--cx-hover);
    --td-bg-color-secondarycontainer-active: var(--cx-pressed);
    --td-bg-color-component: var(--cx-surface-raised);
    --td-bg-color-specialcomponent: var(--cx-surface-raised);
    --td-bg-color-component-hover: var(--cx-hover);
    --td-bg-color-component-active: var(--cx-pressed);
    --td-bg-color-component-disabled: color-mix(in srgb, var(--cx-surface-raised) 70%, var(--cx-muted));
    --td-border-level-2-color: var(--cx-border);
    --td-error-color: var(--cx-danger);
    --td-warning-color: var(--cx-warning, var(--cx-primary));
    --td-success-color: var(--cx-success, var(--cx-primary));
    --td-radius-default: .5rem;
    --td-comp-size-m: 2rem;
    --td-comp-paddingLR-s: .625rem;
    color: var(--td-text-color-primary);
    color-scheme: light;
    font: inherit;
  }
  .cxf-scope[data-cordisx-app-theme="dark"], [data-cordisx-app-theme="dark"] .cxf-scope { color-scheme: dark; }
  .cxf-form { display: grid; gap: 1.35rem; inline-size: 100%; min-inline-size: 0; margin: 0; padding-block: .25rem 1rem; }
  .cxf-section { display: grid; gap: .55rem; min-inline-size: 0; }
  .cxf-section-heading { padding-inline: .25rem; }
  .cxf-section-title { margin: 0; color: var(--cx-text); font-size: .96rem; line-height: 1.35; font-weight: 650; }
  .cxf-section-description { margin: .2rem 0 0; color: var(--cx-muted); font-size: .78rem; line-height: 1.5; overflow-wrap: anywhere; }
  .cxf-tdesign-control { display: inline-block; box-sizing: border-box; min-inline-size: 0; max-inline-size: 100%; color: var(--cx-text); font: inherit; outline: none; }
  t-input.cxf-tdesign-control, t-textarea.cxf-tdesign-control, t-input-number.cxf-tdesign-control, t-select.cxf-tdesign-control { inline-size: 100%; }
  .cxf-form-grid { display: grid; overflow: clip; border: 1px solid var(--cx-border); border-radius: .8rem; background: color-mix(in srgb, var(--cx-surface-raised) 86%, var(--cx-surface)); box-shadow: 0 1px 2px color-mix(in srgb, var(--cx-shadow) 18%, transparent); }
  .cxf-item { display: grid; grid-template-columns: minmax(0, 1fr) minmax(13rem, min(44%, 25rem)); grid-template-areas: "label control" "help control" "error error"; align-items: center; gap: .25rem 1.25rem; min-inline-size: 0; padding: .9rem 1rem; }
  .cxf-item + .cxf-item { border-top: 1px solid var(--cx-border); }
  .cxf-item[data-full-width="true"] { grid-template-columns: minmax(0, 1fr); grid-template-areas: "label" "help" "control" "error"; align-items: start; }
  .cxf-label-row { grid-area: label; display: flex; align-items: baseline; gap: .35rem; min-inline-size: 0; }
  .cxf-label { color: var(--td-text-color-primary); font-weight: 600; overflow-wrap: anywhere; }
  .cxf-required { color: var(--td-error-color); font-weight: 700; }
  .cxf-control-seat { grid-area: control; min-inline-size: 0; justify-self: stretch; }
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
  .cxf-help, .cxf-error { margin: 0; overflow-wrap: anywhere; font-size: .78rem; line-height: 1.45; }
  .cxf-help { grid-area: help; }
  .cxf-error { grid-area: error; }
  .cxf-help { color: var(--td-text-color-secondary); }
  .cxf-error { color: var(--td-error-color); }
  .cxf-error[hidden] { display: none; }
  .cxf-item[data-invalid="true"] .cxf-control { border-color: var(--td-error-color); }
  .cxf-custom-seat { min-block-size: 2rem; }
  .cxf-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: .5rem; }
  .cxf-form-footer { position: sticky; inset-block-end: -.25rem; z-index: 2; min-block-size: 2.75rem; padding: .6rem .75rem; border: 1px solid var(--cx-border); border-radius: .75rem; background: color-mix(in srgb, var(--cx-surface) 94%, transparent); box-shadow: 0 -8px 20px color-mix(in srgb, var(--cx-shadow) 10%, transparent); backdrop-filter: blur(14px); }
  .cxf-field-actions { margin-block-start: .5rem; }
  .cxf-status { margin-inline-end: auto; color: var(--td-text-color-secondary); font-size: .82em; }
  .cxf-status[data-state="dirty"] { color: var(--td-brand-color); }
  .cxf-status[data-state="saved"] { color: var(--td-success-color); }
  .cxf-button {
    display: inline-flex; align-items: center; justify-content: center; gap: .375rem; min-block-size: 2rem;
    border: 1px solid var(--td-border-level-2-color); border-radius: var(--td-radius-default);
    padding: .375rem .75rem; background: var(--td-bg-color-specialcomponent); color: var(--td-text-color-primary);
    font: inherit; line-height: 1.25; cursor: pointer;
  }
  .cxf-button:hover:not(:disabled) { border-color: var(--td-brand-color); background: var(--td-bg-color-component-hover); }
  .cxf-button[data-variant="primary"] { border-color: var(--td-brand-color); background: var(--td-brand-color); color: var(--cx-primary-text); }
  .cxf-button[data-tone="danger"] { color: var(--td-error-color); }
  .cxf-button[aria-disabled="true"], .cxf-button:disabled { cursor: default; opacity: var(--cx-disabled); }
  .cxf-alert { border: 1px solid var(--td-border-level-2-color); border-radius: var(--td-radius-default); padding: .625rem .75rem; background: var(--td-bg-color-specialcomponent); color: var(--td-text-color-secondary); overflow-wrap: anywhere; }
  .cxf-alert[data-tone="error"] { border-color: color-mix(in srgb, var(--td-error-color) 55%, transparent); color: var(--td-error-color); }
  .cxf-alert[data-tone="warning"] { border-color: color-mix(in srgb, var(--td-warning-color) 55%, transparent); color: var(--td-warning-color); }
  .cxf-empty { padding: 1.25rem; text-align: center; color: var(--td-text-color-secondary); }
  .cxf-note { margin: 0; padding-inline: .25rem; color: var(--cx-muted); font-size: .78rem; line-height: 1.5; }
  .cxf-loading { display: inline-flex; align-items: center; gap: .5rem; color: var(--td-text-color-secondary); }
  @media (max-width: 760px) { .cxf-item { grid-template-columns: minmax(0, 1fr); grid-template-areas: "label" "help" "control" "error"; align-items: start; gap: .35rem; } .cxf-form { inline-size: 100%; } }
  @media (forced-colors: active) { .cxf-control:focus-visible, .cxf-button:focus-visible, .cxf-choice input:focus-visible, .cxf-tdesign-control:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; } }
  @media (prefers-reduced-motion: reduce) { .cxf-scope .cxf-control, .cxf-scope .cxf-button, .cxf-scope .cxf-switch::after { transition: none; } }
`}`

function sensitive(field: CordisXConfigFieldSnapshot): boolean {
  return field.role !== undefined && SENSITIVE_ROLES.has(field.role)
}

function jsonLike(field: CordisXConfigFieldSnapshot): boolean {
  return ['object', 'array', 'tuple', 'dict', 'intersect'].includes(field.type)
    || (field.value !== null && typeof field.value === 'object')
}

export function selectHostFormPrimitive(field: CordisXConfigFieldSnapshot): HostFormPrimitive {
  if (sensitive(field)) return 'sensitive-unavailable'
  // The public config snapshot describes only scalar choices. Do not infer a
  // multi-select from an array value: that would let a plugin smuggle an
  // unbounded option model into a Host control.
  if (field.role === 'multi-select') return 'unsupported'
  if (field.choices !== undefined) return field.role === 'radio' ? 'radio' : 'select'
  if (field.type === 'boolean') return field.role === 'switch' ? 'switch' : 'checkbox'
  if (field.type === 'number' || field.type === 'natural') return field.role === 'slider' ? 'slider' : 'number-input'
  if (field.type === 'string') {
    if (field.role === 'date' || field.role === 'time' || field.role === 'color') return 'unsupported'
    if (field.role === 'textarea' || field.role === 'multiline') return 'textarea'
    if (field.role === 'path' || field.role === 'file' || field.role === 'directory') return 'path-input'
    return 'input'
  }
  if (jsonLike(field)) return 'json-textarea'
  return 'unsupported'
}

export function hostFormDiagnostic(field: CordisXConfigFieldSnapshot): HostFormDiagnostic | undefined {
  const primitive = selectHostFormPrimitive(field)
  if (primitive === 'unsupported' && ['date', 'time', 'color', 'multi-select'].includes(field.role ?? '')) return {
    code: 'unsupported-schema-role', fieldPath: field.path,
    detail: `unsupported schema role ${field.role}; no native control fallback is permitted`,
  }
  if (primitive === 'unsupported') return {
    code: 'unsupported-schema-field', fieldPath: field.path, detail: `unsupported Schemastery field type: ${field.type}`,
  }
  if (field.role !== undefined && !SENSITIVE_ROLES.has(field.role) && !KNOWN_ROLES.has(field.role)) return {
    code: 'unsupported-schema-role', fieldPath: field.path, detail: `unknown role ${field.role}; used ${primitive}`,
  }
  return undefined
}

export function validateHostFormValue(field: CordisXConfigFieldSnapshot, value: unknown, locale = 'zh-CN'): string | undefined {
  if (field.required && (value === undefined || value === null || value === '')) return managerCopy(locale, 'form.required')
  if (value === undefined || value === null || value === '') return undefined
  if (field.choices !== undefined && !field.choices.some(choice => Object.is(choice.value, value))) return managerCopy(locale, 'form.choice-invalid')
  if (field.type === 'number' || field.type === 'natural') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return managerCopy(locale, 'form.number-invalid')
    if (field.type === 'natural' && (!Number.isInteger(value) || value < 0)) return managerCopy(locale, 'form.natural-invalid')
    if (field.min !== undefined && value < field.min) return productLocale(locale) === 'zh-CN' ? `不能小于 ${field.min}` : `Must be at least ${field.min}`
    if (field.max !== undefined && value > field.max) return productLocale(locale) === 'zh-CN' ? `不能大于 ${field.max}` : `Must be at most ${field.max}`
    if (field.step !== undefined && field.step > 0) {
      const origin = field.min ?? 0
      const quotient = (value - origin) / field.step
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) return productLocale(locale) === 'zh-CN'
        ? `请按 ${field.step} 的步长输入` : `Use increments of ${field.step}`
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
  private readonly portalHost: HTMLElement

  constructor(
    private readonly document: Document,
    portalParent?: HTMLElement,
    private readonly localeProvider: () => string = () => document.documentElement.lang || 'zh-CN',
  ) {
    this.portalHost = createTDesignPortal(document, portalParent)
  }

  private locale(): string {
    return this.localeProvider()
  }

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

  section(title: string, description?: string): { readonly root: HTMLElement; readonly content: HTMLElement } {
    const root = this.document.createElement('section')
    root.className = 'cxf-section'
    const heading = this.document.createElement('div')
    heading.className = 'cxf-section-heading'
    const titleNode = this.document.createElement('h3')
    titleNode.className = 'cxf-section-title'
    titleNode.textContent = title
    heading.append(titleNode)
    if (description !== undefined) {
      const copy = this.document.createElement('p')
      copy.className = 'cxf-section-description'
      copy.textContent = description
      heading.append(copy)
    }
    const content = this.document.createElement('div')
    content.className = 'cxf-form-grid'
    root.append(heading, content)
    return { root, content }
  }

  select<Value>(
    label: string,
    options: readonly TDesignSelectOption<Value>[],
    value: Value | undefined,
    onChange: (value: Value | undefined) => void,
    config: { readonly id?: string; readonly disabled?: boolean; readonly readonly?: boolean; readonly clearable?: boolean } = {},
  ): TDesignSelectElement<Value> {
    return createTDesignSelect(this.document, this.portalHost, options, {
      label,
      onChange,
      ...(value === undefined ? {} : { value }),
      ...config,
    })
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
      root: this.alert(managerCopy(this.locale(), 'form.sensitive-unavailable'), 'warning'),
      primitive,
    }
    if (primitive === 'unsupported') return {
      root: this.alert(managerCopy(this.locale(), 'form.unsupported'), 'warning'), primitive, ...(diagnostic === undefined ? {} : { diagnostic }),
    }
    if (primitive === 'select') {
      const select = createTDesignSelect<CordisXJsonScalar>(this.document, this.portalHost, field.choices!, {
        id,
        label: field.label ?? field.path.at(-1) ?? managerCopy(this.locale(), 'form.select-placeholder'),
        value: field.value as CordisXJsonScalar,
        disabled: field.disabled,
        onChange: value => onDraft(value, validateHostFormValue(field, value, this.locale())),
      })
      setCommonControlState(select, field, id)
      return { root: select, focusTarget: select, primitive, ...(diagnostic === undefined ? {} : { diagnostic }) }
    }
    if (primitive === 'radio') {
      const group = this.document.createElement('div')
      group.className = 'cxf-radio-group'
      group.setAttribute('role', 'radiogroup')
      setCommonControlState(group, field, id)
      // The official individual t-radio/t-checkbox elements look up their
      // group injection unconditionally. Use the official group components
      // rather than synthetic wrappers so a standalone Host field remains
      // safe in an Omi document without an enclosing TDesign form provider.
      const radios = createTDesignElement(this.document, 't-radio-group', 'radio')
      radios.id = id
      radios.tabIndex = field.disabled ? -1 : 0
      setTDesignProps(radios, {
        value: field.value,
        options: field.choices!.map(choice => ({ label: choice.label, value: choice.value, disabled: field.disabled })),
        disabled: field.disabled,
        onChange: (value: CordisXJsonScalar | undefined) => onDraft(value),
      })
      group.append(radios)
      return { root: group, focusTarget: radios, primitive, ...(diagnostic === undefined ? {} : { diagnostic }) }
    }
    if (primitive === 'checkbox') {
      const control = createTDesignElement(this.document, 't-checkbox-group', primitive)
      setCommonControlState(control, field, id)
      control.tabIndex = field.disabled ? -1 : 0
      control.setAttribute('role', 'checkbox')
      control.setAttribute('aria-checked', String(field.value === true))
      setTDesignProps(control, {
        value: field.value === true ? [true] : [],
        options: [{ label: '', value: true, disabled: field.disabled }],
        disabled: field.disabled,
        onChange: (value: readonly boolean[]) => {
          const checked = value.includes(true)
          control.setAttribute('aria-checked', String(checked))
          onDraft(checked)
        },
      })
      return { root: control, focusTarget: control, primitive, ...(diagnostic === undefined ? {} : { diagnostic }) }
    }
    if (primitive === 'switch') {
      const control = createTDesignElement(this.document, 't-switch', primitive)
      setCommonControlState(control, field, id)
      control.tabIndex = field.disabled ? -1 : 0
      control.setAttribute('role', 'switch')
      control.setAttribute('aria-checked', String(field.value === true))
      setTDesignProps(control, {
        value: field.value === true,
        disabled: field.disabled,
        label: [managerCopy(this.locale(), 'form.switch-on'), managerCopy(this.locale(), 'form.switch-off')],
        onChange: (value: boolean) => {
          control.setAttribute('aria-checked', String(value))
          onDraft(value)
        },
      })
      return { root: control, focusTarget: control, primitive, ...(diagnostic === undefined ? {} : { diagnostic }) }
    }
    const tag = primitive === 'textarea' || primitive === 'json-textarea' ? 't-textarea'
      : primitive === 'number-input' ? 't-input-number'
        : primitive === 'slider' ? 't-slider'
          : 't-input'
    const input = createTDesignElement(this.document, tag, primitive)
    input.classList.toggle('cxf-textarea', primitive === 'textarea' || primitive === 'json-textarea')
    input.classList.toggle('cxf-json', primitive === 'json-textarea')
    input.tabIndex = field.disabled ? -1 : 0
    setCommonControlState(input, field, id)
    if (primitive === 'slider') {
      const value = typeof field.value === 'number' ? field.value : field.min ?? 0
      input.setAttribute('role', 'slider')
      input.setAttribute('aria-valuenow', String(value))
      input.setAttribute('aria-valuemin', String(field.min ?? 0))
      input.setAttribute('aria-valuemax', String(field.max ?? 100))
      setTDesignProps(input, {
        value,
        min: field.min ?? 0,
        max: field.max ?? 100,
        step: field.step ?? 1,
        disabled: field.disabled,
        onChange: (next: number) => {
          input.setAttribute('aria-valuenow', String(next))
          onDraft(next, validateHostFormValue(field, next, this.locale()))
        },
      })
    } else if (primitive === 'number-input') {
      setTDesignProps(input, {
        value: typeof field.value === 'number' ? field.value : undefined,
        defaultValue: typeof field.value === 'number' ? field.value : undefined,
        min: field.min,
        max: field.max,
        step: field.step,
        disabled: field.disabled,
        onChange: (next: number | undefined) => onDraft(next, validateHostFormValue(field, next, this.locale())),
      })
    } else {
      const initial = primitive === 'json-textarea' ? JSON.stringify(field.value, null, 2) : String(field.value ?? '')
      setTDesignProps(input, {
        value: initial,
        defaultValue: initial,
        disabled: field.disabled,
        placeholder: primitive === 'path-input' ? '/absolute/path' : undefined,
        autosize: primitive === 'textarea' || primitive === 'json-textarea' ? { minRows: 4, maxRows: 12 } : undefined,
        onChange: (next: string) => {
          if (primitive !== 'json-textarea') {
            onDraft(next, validateHostFormValue(field, next, this.locale()))
            return
          }
          try {
            const value = JSON.parse(next) as unknown
            onDraft(value, validateHostFormValue(field, value, this.locale()))
          } catch {
            onDraft(undefined, managerCopy(this.locale(), 'form.json-invalid'))
          }
        },
      })
    }
    return { root: input, focusTarget: input, primitive, ...(diagnostic === undefined ? {} : { diagnostic }) }
  }

  button(label: string, options: { readonly type?: 'button' | 'submit'; readonly variant?: 'default' | 'primary'; readonly tone?: 'default' | 'danger' } = {}): TDesignButtonElement {
    const button = createTDesignButton(this.document, label, options)
    button.className = 'cxf-button cxf-tdesign-control'
    button.dataset.variant = options.variant ?? 'default'
    button.dataset.tone = options.tone ?? 'default'
    return button
  }

  alert(message: string, tone: 'info' | 'warning' | 'error' = 'info'): HTMLElement {
    const alert = createTDesignElement(this.document, 't-alert', 'alert')
    alert.className = 'cxf-alert cxf-tdesign-control'
    alert.dataset.tone = tone
    alert.setAttribute('role', tone === 'error' ? 'alert' : 'status')
    alert.textContent = message
    setTDesignProps(alert, { message, theme: tone === 'info' ? 'info' : tone })
    return alert
  }

  empty(message: string): HTMLDivElement {
    const empty = this.document.createElement('div')
    empty.className = 'cxf-empty'
    empty.textContent = message
    return empty
  }

  note(message: string): HTMLParagraphElement {
    const note = this.document.createElement('p')
    note.className = 'cxf-note'
    note.textContent = message
    return note
  }

  loading(message: string): HTMLElement {
    const loading = createTDesignElement(this.document, 't-loading', 'loading')
    loading.className = 'cxf-loading cxf-tdesign-control'
    loading.setAttribute('role', 'status')
    loading.setAttribute('aria-busy', 'true')
    loading.textContent = message
    setTDesignProps(loading, { loading: true, text: message, content: message, size: 'small', showOverlay: false })
    return loading
  }
}
