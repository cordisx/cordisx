import { type FormDescriptor, resolveFormPresenter } from '@cordisx/schemastery-ui'
import type { CordisXConfigFieldSnapshot } from '../contracts.js'
import { HOST_ICON_16PX_CSS } from './icons.js'
import { TDESIGN_SCOPED_TOKEN_CSS, type TDesignButtonElement } from './tdesign-form.js'
import { managerCopy, productLocale } from './ui-copy.js'

export type HostFormPrimitive =
  | 'input'
  | 'textarea'
  | 'number-input'
  | 'select'
  | 'checkbox'
  | 'switch'
  | 'radio'
  | 'slider'
  | 'path-input'
  | 'json-textarea'
  | 'date-picker'
  | 'time-picker'
  | 'color-picker'
  | 'multi-select'
  | 'tag-input'
  | 'object-array'
  | 'sensitive-unavailable'
  | 'unsupported'

/**
 * Host layout policy is deliberately derived from the resolved primitive, not
 * from a plugin's field name or page-specific CSS. Full controls consume the
 * control column; intrinsic controls keep their natural working width and are
 * aligned to its trailing edge.
 */
export type HostFormControlLayout = 'fill' | 'compact'

export interface HostFormDiagnostic {
  readonly code: 'unsupported-schema-role' | 'unsupported-schema-field' | 'unsupported-presenter'
  readonly fieldPath: readonly string[]
  readonly detail: string
}

export interface HostFormControl {
  readonly root: HTMLElement
  readonly focusTarget?: HTMLElement
  readonly primitive: HostFormPrimitive
  readonly diagnostic?: HostFormDiagnostic
  dispose?(): void
}

export interface HostTransientSecretControl extends HostFormControl {
  clear(): void
}

export interface HostFormItem {
  readonly root: HTMLDivElement
  readonly control: HTMLDivElement
  readonly labelRow: HTMLDivElement
  readonly label: HTMLLabelElement
  readonly help?: HTMLParagraphElement
  readonly error: HTMLParagraphElement
  setError(message?: string): void
}

export interface HostFormFieldActionMenu {
  readonly trigger: TDesignButtonElement
  dispose(): void
}

export type HostConfigApplyMode = 'live' | 'restart' | 'plugin-restart' | 'service-restart' | 'app-restart'
export type HostConfigApplyPhase = 'dirty' | 'saving' | 'saved'

/**
 * User-facing projection for configuration apply semantics. `restart` is the
 * legacy protocol spelling and is normalized to the precise plugin restart
 * behavior. The v2 values remain generic Host projections and introduce no
 * product-specific service fields.
 */
export function hostConfigApplyMessage(
  mode: HostConfigApplyMode,
  phase: HostConfigApplyPhase,
  locale = 'zh-CN',
): string {
  if (phase === 'saving') return managerCopy(locale, 'form.saving')
  const action = mode === 'live'
    ? managerCopy(locale, 'form.apply-live')
    : mode === 'service-restart'
    ? managerCopy(locale, 'form.apply-service-restart')
    : mode === 'app-restart'
    ? managerCopy(locale, 'form.apply-app-restart')
    : managerCopy(locale, 'form.apply-plugin-restart')
  return phase === 'saved' ? action : `${managerCopy(locale, 'form.dirty-prefix')} · ${action}`
}

const SENSITIVE_ROLES = new Set(['secret', 'credential', 'credential-ref', 'permission', 'capability'])
const KNOWN_ROLES = new Set([
  'checkbox',
  'switch',
  'radio',
  'slider',
  'textarea',
  'multiline',
  'path',
  'file',
  'directory',
  'duration',
  'url',
  'date',
  'datetime',
  'time',
  'color',
  'multi-select',
  'code',
  'json',
])

export const HOST_FORM_STYLES = `${TDESIGN_SCOPED_TOKEN_CSS}\n${HOST_ICON_16PX_CSS}\n${String.raw`
  .cxf-scope {
    --td-brand-color: var(--cx-primary);
    --td-brand-color-hover: color-mix(in srgb, var(--cx-primary) 88%, var(--cx-text));
    --td-brand-color-active: color-mix(in srgb, var(--cx-primary) 78%, var(--cx-text));
    --td-brand-color-disabled: color-mix(in srgb, var(--cx-primary) 45%, var(--cx-surface));
    --td-brand-color-light: color-mix(in srgb, var(--cx-primary) 12%, var(--cx-surface));
    --td-brand-color-light-hover: color-mix(in srgb, var(--cx-primary) 20%, var(--cx-surface));
    --td-brand-color-focus: color-mix(in srgb, var(--cx-focus) 26%, transparent);
    --td-text-color-primary: var(--cx-text);
    --td-text-color-secondary: var(--cx-muted);
    --td-text-color-placeholder: color-mix(in srgb, var(--cx-muted) 78%, transparent);
    --td-text-color-disabled: color-mix(in srgb, var(--cx-text) 68%, var(--cx-surface));
    --td-text-color-anti: var(--cx-primary-text);
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
  t-input.cxf-tdesign-control, t-textarea.cxf-tdesign-control, t-input-number.cxf-tdesign-control, t-select.cxf-tdesign-control, t-date-picker.cxf-tdesign-control, t-tag-input.cxf-tdesign-control { inline-size: 100%; }
  .cxf-form-grid { display: grid; overflow: clip; border: 1px solid var(--cx-border); border-radius: .8rem; background: color-mix(in srgb, var(--cx-surface-raised) 86%, var(--cx-surface)); box-shadow: 0 1px 2px color-mix(in srgb, var(--cx-shadow) 18%, transparent); }
  .cxf-item { display: grid; grid-template-columns: minmax(0, 1fr) minmax(13rem, min(44%, 25rem)); grid-template-areas: "label control" "help control" "error error"; align-items: center; gap: .25rem 1.25rem; min-inline-size: 0; padding: .9rem 1rem; }
  .cxf-item + .cxf-item { border-top: 1px solid var(--cx-border); }
  .cxf-item[data-full-width="true"] { grid-template-columns: minmax(0, 1fr); grid-template-areas: "label" "help" "control" "error"; align-items: start; }
  .cxf-label-row { grid-area: label; display: flex; align-items: center; gap: .35rem; min-inline-size: 0; }
  .cxf-label { display: inline-flex; min-block-size: 1.5rem; align-items: center; gap: .35rem; line-height: 1.5rem; }
  .cxf-required { display: inline-flex; min-block-size: 1.5rem; align-items: center; line-height: 1.5rem; }
  .cxf-field-menu-trigger { flex: 0 0 auto; color: var(--td-text-color-secondary); background: transparent; }
  .cxf-field-menu-trigger.cxf-button[data-density="icon"] { inline-size: 1.5rem; block-size: 1.5rem; }
  .cxf-field-menu-trigger:hover:not(:disabled), .cxf-field-menu-trigger[aria-expanded="true"] { background: transparent; color: var(--td-text-color-primary); }
  .cxf-form-icon { flex: 0 0 auto; inline-size: 1rem; block-size: 1rem; color: var(--td-text-color-secondary); }
  .cxf-section-title > .cordisx-host-icon { margin-inline-end: .4rem; vertical-align: -.14em; color: var(--td-text-color-secondary); }
  .cxf-label { color: var(--td-text-color-primary); font-weight: 600; overflow-wrap: anywhere; }
  .cxf-required { color: var(--td-error-color); font-weight: 700; }
  .cxf-control-seat { grid-area: control; min-inline-size: 0; justify-self: stretch; }
  .cxf-item[data-control-layout="compact"] .cxf-control-seat { box-sizing: border-box; inline-size: auto; max-inline-size: 100%; justify-self: end; }
  .cxf-item[data-primitive="slider"] .cxf-control-seat { inline-size: auto; justify-self: stretch; }
  .cxf-item[data-control-layout="compact"] .cxf-tdesign-control { inline-size: auto; max-inline-size: 100%; }
  .cxf-item[data-control-layout="compact"] t-input-number.cxf-tdesign-control { inline-size: 7.25rem; }
  .cxf-item[data-control-layout="compact"] t-checkbox-group.cxf-tdesign-control,
  .cxf-item[data-control-layout="compact"] t-switch.cxf-tdesign-control,
  .cxf-item[data-control-layout="compact"] t-radio-group.cxf-tdesign-control { inline-size: fit-content; max-inline-size: 100%; }
  t-select.cxf-tdesign-control { border: 0; border-radius: 0; padding: 0; background: transparent; }
  t-select.cxf-tdesign-control::part(suffix), t-select.cxf-tdesign-control::part(t-select__right-icon) { display: inline-grid; align-self: center; place-items: center; block-size: 100%; }
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
  .cxf-item[data-control-layout="compact"] .cxf-radio-group { inline-size: fit-content; max-inline-size: 100%; justify-content: flex-end; }
  .cxf-item[data-control-layout="compact"] .cxf-radio-group > t-radio-group { inline-size: fit-content; max-inline-size: 100%; }
  .cxf-choice { display: inline-flex; align-items: center; gap: .4rem; min-block-size: 2rem; }
  .cxf-choice input { margin: 0; accent-color: var(--td-brand-color); }
  .cxf-slider-control { display: grid; grid-template-columns: minmax(0, 1fr) minmax(5.25rem, 6.5rem); gap: .65rem; align-items: center; inline-size: 100%; }
  .cxf-item[data-control-layout="compact"] .cxf-slider-control { inline-size: 100%; }
  .cxf-slider-control > t-slider { display: block; min-inline-size: 0; overflow: visible; --td-component-stroke: var(--cx-border); --td-brand-color: var(--cx-primary); }
  .cxf-slider-control > t-input-number { min-inline-size: 0; }
  .cxf-array-editor { display: grid; gap: .5rem; inline-size: 100%; }
  .cxf-array-editor-toolbar, .cxf-array-row, .cxf-array-row-actions { display: flex; align-items: center; gap: .45rem; }
  .cxf-array-editor-toolbar { justify-content: flex-end; }
  .cxf-array-row { justify-content: space-between; min-block-size: 2.25rem; padding: .45rem .6rem; border: 1px solid var(--td-border-level-2-color); border-radius: var(--td-radius-default); background: var(--td-bg-color-specialcomponent); }
  .cxf-array-row-drag-handle { display: inline-flex; flex: 0 0 1.5rem; align-items: center; justify-content: center; color: var(--td-text-color-secondary); cursor: grab; }
  .cxf-array-row-action-up .cxf-form-icon { transform: rotate(90deg); }
  .cxf-array-row-action-down .cxf-form-icon { transform: rotate(-90deg); }
  .cxf-array-row-summary { min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--td-text-color-secondary); }
  .cxf-array-editor-dialog { --cxf-manager-dialog-gap: .85rem; --cxf-manager-dialog-padding: 1rem; position: fixed; inset: 10vh max(1rem, calc((100vw - 42rem) / 2)) auto; z-index: 1; display: grid; gap: var(--cxf-manager-dialog-gap); max-block-size: min(80vh, calc(100vh - 2rem)); overflow: auto; box-sizing: border-box; padding: var(--cxf-manager-dialog-padding); border: 1px solid var(--cx-border); border-radius: .8rem; background: var(--cx-surface); color: var(--cx-text); box-shadow: 0 24px 80px var(--cx-shadow); font: inherit; }
  .cxf-array-editor-dialog-head { display: flex; align-items: center; justify-content: space-between; gap: .75rem; }
  .cxf-array-editor-dialog-fields { display: grid; gap: .8rem; }
  .cxf-array-editor-dialog-field { display: grid; gap: .3rem; }
  .cxf-color-control { display: grid; grid-template-columns: minmax(0, 1fr) 2.25rem; gap: .5rem; align-items: center; inline-size: 100%; }
  .cxf-datetime-control { display: grid; grid-template-columns: minmax(0, 1fr) minmax(8rem, 10rem); gap: .5rem; align-items: center; inline-size: 100%; }
  .cxf-color-picker { appearance: none; inline-size: 2.25rem; block-size: 2rem; margin: 0; border: 1px solid var(--td-border-level-2-color); border-radius: var(--td-radius-default); padding: .2rem; background: var(--td-bg-color-specialcomponent); cursor: pointer; }
  .cxf-color-picker::-webkit-color-swatch-wrapper { padding: 0; }
  .cxf-color-picker::-webkit-color-swatch { border: 0; border-radius: calc(var(--td-radius-default) - .15rem); }
  .cxf-color-picker:focus-visible { outline: 2px solid var(--td-brand-color-focus); outline-offset: 2px; }
  .cxf-color-picker:disabled { cursor: not-allowed; opacity: var(--cx-disabled); }
  .cxf-time-select { inline-size: 100%; max-inline-size: none; }
  .cxf-help, .cxf-error { margin: 0; overflow-wrap: anywhere; font-size: .78rem; line-height: 1.45; }
  .cxf-help { grid-area: help; }
  .cxf-error { grid-area: error; }
  .cxf-help { color: var(--td-text-color-secondary); }
  .cxf-error { color: var(--td-error-color); }
  .cxf-error[hidden] { display: none; }
  .cxf-item[data-invalid="true"] .cxf-control { border-color: var(--td-error-color); }
  .cxf-custom-seat { min-block-size: 2rem; }
  .cxf-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: .5rem; }
  .cxf-form-footer { position: sticky; inset-block-start: 0; z-index: 3; min-block-size: 2rem; margin: 0; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; backdrop-filter: none; }
  .cxf-status { margin-inline-end: auto; color: var(--td-text-color-secondary); font-size: .82em; }
  .cxf-status[data-state="dirty"] { color: var(--td-brand-color); }
  .cxf-status[data-state="saved"] { color: var(--td-success-color); }
  .cxf-button { display: inline-block; min-block-size: 0; min-inline-size: 0; margin: 0; color: var(--td-text-color-primary); font: inherit; line-height: 1; cursor: pointer; }
  .cxf-button[data-density="icon"] { inline-size: 2rem; block-size: 2rem; }
  .cxf-button .cxf-form-icon { inline-size: 1rem; block-size: 1rem; }
  .cxf-button[data-tone="danger"] { color: var(--td-error-color); }
  .cxf-button[aria-disabled="true"], .cxf-button:disabled { cursor: default; opacity: var(--cx-disabled); }
  .cxf-alert { border: 1px solid var(--td-border-level-2-color); border-radius: var(--td-radius-default); padding: .625rem .75rem; background: var(--td-bg-color-specialcomponent); color: var(--td-text-color-secondary); overflow-wrap: anywhere; }
  .cxf-alert[data-tone="error"] { border-color: color-mix(in srgb, var(--td-error-color) 55%, transparent); color: var(--td-error-color); }
  .cxf-alert[data-tone="warning"] { border-color: color-mix(in srgb, var(--td-warning-color) 55%, transparent); color: var(--td-warning-color); }
  .cxf-empty { padding: 1.25rem; text-align: center; color: var(--td-text-color-secondary); }
  .cxf-note { margin: 0; padding-inline: .25rem; color: var(--cx-muted); font-size: .78rem; line-height: 1.5; }
  .cxf-loading { display: inline-flex; align-items: center; gap: .5rem; color: var(--td-text-color-secondary); }
  @media (max-width: 760px) { .cxf-item { grid-template-columns: minmax(0, 1fr); grid-template-areas: "label" "help" "control" "error"; align-items: start; gap: .35rem; } .cxf-form { inline-size: 100%; } .cxf-slider-control { grid-template-columns: minmax(0, 1fr) 5.25rem; } .cxf-datetime-control { grid-template-columns: minmax(0, 1fr); } .cxf-item[data-control-layout="compact"] .cxf-slider-control { inline-size: 100%; } }
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
  const presented = hostPresenterPrimitive(field)
  if (presented !== undefined) return presented
  if (field.type === 'array') {
    if (field.choices !== undefined && field.role === 'multi-select') return 'multi-select'
    if (field.arrayItemType !== undefined && field.max !== undefined && field.max <= 64) return 'tag-input'
    if (field.arrayItemSchema !== undefined) return 'object-array'
    if (jsonLike(field)) return 'json-textarea'
    return 'unsupported'
  }
  if (field.choices !== undefined) return field.role === 'radio' ? 'radio' : 'select'
  if (field.type === 'boolean') return field.role === 'switch' ? 'switch' : 'checkbox'
  if (field.type === 'number' || field.type === 'natural') return field.role === 'slider' ? 'slider' : 'number-input'
  if (field.type === 'string') {
    if (field.role === 'date' || field.role === 'datetime') return 'date-picker'
    if (field.role === 'time') return 'time-picker'
    if (field.role === 'color') return 'color-picker'
    if (field.role === 'textarea' || field.role === 'multiline' || field.role === 'code' || field.role === 'json') {
      return 'textarea'
    }
    if (field.role === 'path' || field.role === 'file' || field.role === 'directory') return 'path-input'
    return 'input'
  }
  if (jsonLike(field)) return 'json-textarea'
  return 'unsupported'
}

function presenterDescriptor(field: CordisXConfigFieldSnapshot): FormDescriptor {
  return {
    path: field.path,
    type: field.type as FormDescriptor['type'],
    ...(field.role === undefined ? {} : { role: field.role }),
    ...(field.choices === undefined ? {} : { choices: field.choices }),
    ...(field.arrayItemType === undefined ? {} : { itemType: field.arrayItemType }),
    ...(field.arrayItemSchema === undefined ? {} : { item: { path: [...field.path, '*'], type: 'object' } }),
    ...(field.presenter === undefined ? {} : { presentation: field.presenter }),
  }
}

/**
 * The only configurable renderer choice is a closed, versioned protocol token.
 * Unsupported or incompatible entries deliberately fall through to the
 * schema-derived Host primitive; no plugin receives a rendering escape hatch.
 */
export function hostPresenterPrimitive(field: CordisXConfigFieldSnapshot): HostFormPrimitive | undefined {
  if (field.presenter === undefined) return undefined
  const resolution = resolveFormPresenter(presenterDescriptor(field))
  return resolution.diagnostic === undefined ? resolution.primitive as HostFormPrimitive : undefined
}

/**
 * The catalog-level layout classification intentionally has no labels, paths,
 * groups, or page knowledge. New compact presenter kinds extend this set once
 * in the Host adapter rather than adding a field-specific Manager override.
 */
export function hostFormControlLayoutForPrimitive(primitive: HostFormPrimitive): HostFormControlLayout {
  switch (primitive) {
    case 'number-input':
    case 'slider':
    case 'checkbox':
    case 'switch':
    case 'radio':
      return 'compact'
    default:
      return 'fill'
  }
}

export function hostFormControlLayout(field: CordisXConfigFieldSnapshot): HostFormControlLayout {
  return hostFormControlLayoutForPrimitive(selectHostFormPrimitive(field))
}

export function hostFormDiagnostic(field: CordisXConfigFieldSnapshot): HostFormDiagnostic | undefined {
  const primitive = selectHostFormPrimitive(field)
  if (field.presenter !== undefined && hostPresenterPrimitive(field) === undefined) {
    return {
      code: 'unsupported-presenter',
      fieldPath: field.path,
      detail: `incompatible Host form presenter: ${field.presenter.kind}`,
    }
  }
  if (primitive === 'unsupported') {
    return {
      code: 'unsupported-schema-field',
      fieldPath: field.path,
      detail: `unsupported Schemastery field type: ${field.type}`,
    }
  }
  if (field.role !== undefined && !SENSITIVE_ROLES.has(field.role) && !KNOWN_ROLES.has(field.role)) {
    return {
      code: 'unsupported-schema-role',
      fieldPath: field.path,
      detail: `unknown role ${field.role}; used ${primitive}`,
    }
  }
  return undefined
}

export function validateHostFormValue(
  field: CordisXConfigFieldSnapshot,
  value: unknown,
  locale = 'zh-CN',
): string | undefined {
  if (
    field.required
    && (value === undefined || value === null || value === '' || Array.isArray(value) && value.length === 0)
  ) return managerCopy(locale, 'form.required')
  if (value === undefined || value === null || value === '') return undefined
  if (
    field.choices !== undefined && !Array.isArray(value)
    && !field.choices.some(choice => Object.is(choice.value, value))
  ) return managerCopy(locale, 'form.choice-invalid')
  if (field.type === 'array') {
    if (!Array.isArray(value)) return managerCopy(locale, 'form.choice-invalid')
    if (field.min !== undefined && value.length < field.min) {
      return productLocale(locale) === 'zh-CN'
        ? `至少选择 ${field.min} 项`
        : `Choose at least ${field.min}`
    }
    if (field.max !== undefined && value.length > field.max) {
      return productLocale(locale) === 'zh-CN'
        ? `最多选择 ${field.max} 项`
        : `Choose at most ${field.max}`
    }
    if (
      field.choices !== undefined && value.some(item => !field.choices!.some(choice => Object.is(choice.value, item)))
    ) return managerCopy(locale, 'form.choice-invalid')
  }
  if (field.role === 'date' && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value))) {
    return productLocale(locale) === 'zh-CN' ? '请输入有效日期' : 'Enter a valid date'
  }
  if (
    field.role === 'datetime'
    && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} [0-2]\d:[0-5]\d:[0-5]\d$/u.test(value))
  ) return productLocale(locale) === 'zh-CN' ? '请输入有效日期和时间' : 'Enter a valid date and time'
  if (field.role === 'time' && (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value))) {
    return productLocale(locale) === 'zh-CN' ? '请输入有效时间' : 'Enter a valid time'
  }
  if (field.role === 'color' && (typeof value !== 'string' || !/^#[\da-fA-F]{6}$/u.test(value))) {
    return productLocale(locale) === 'zh-CN' ? '请输入有效 HEX 颜色' : 'Enter a valid HEX color'
  }
  if (field.type === 'number' || field.type === 'natural') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return managerCopy(locale, 'form.number-invalid')
    if (field.type === 'natural' && (!Number.isInteger(value) || value < 0)) {
      return managerCopy(locale, 'form.natural-invalid')
    }
    if (field.min !== undefined && value < field.min) {
      return productLocale(locale) === 'zh-CN'
        ? `不能小于 ${field.min}`
        : `Must be at least ${field.min}`
    }
    if (field.max !== undefined && value > field.max) {
      return productLocale(locale) === 'zh-CN'
        ? `不能大于 ${field.max}`
        : `Must be at most ${field.max}`
    }
    if (field.step !== undefined && field.step > 0) {
      const origin = field.min ?? 0
      const quotient = (value - origin) / field.step
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
        return productLocale(locale) === 'zh-CN'
          ? `请按 ${field.step} 的步长输入`
          : `Use increments of ${field.step}`
      }
    }
  }
  return undefined
}
