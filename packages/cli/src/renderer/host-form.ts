import type { CordisXConfigFieldSnapshot, CordisXConfigFormIcon, CordisXJsonScalar } from '../contracts.js'
import { resolveFormPresenter, type FormDescriptor } from '@cordisx/schemastery-ui'
import {
  bindTDesignTextInput,
  bindTDesignTextareaRows,
  createTDesignButton,
  createTDesignElement,
  createTDesignMultiSelect,
  createTDesignPortal,
  createTDesignSelect,
  createTDesignTagInput,
  setTDesignProps,
  tdesignPortalContainer,
  TDESIGN_SCOPED_TOKEN_CSS,
  type TDesignButtonElement,
  type TDesignElement,
  type TDesignMultiSelectElement,
  type TDesignSelectElement,
  type TDesignSelectOption,
} from './tdesign-form.js'
import { createHostSurfaceIcon, HOST_ICON_16PX_CSS } from './icons.js'
import { managerCopy, productLocale } from './ui-copy.js'

export type HostFormPrimitive =
  | 'input' | 'textarea' | 'number-input' | 'select' | 'checkbox' | 'switch'
  | 'radio' | 'slider' | 'path-input' | 'json-textarea'
  | 'date-picker' | 'time-picker' | 'color-picker' | 'multi-select' | 'tag-input'
  | 'object-array' | 'sensitive-unavailable' | 'unsupported'

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
  'duration', 'url', 'date', 'datetime', 'time', 'color', 'multi-select', 'code', 'json',
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
  .cxf-item[data-control-layout="compact"] .cxf-control-seat { box-sizing: border-box; inline-size: auto; max-inline-size: 100%; padding-inline-end: var(--td-comp-paddingLR-s); justify-self: end; }
  .cxf-item[data-primitive="slider"] .cxf-control-seat { inline-size: auto; padding-inline-end: var(--td-comp-paddingLR-s); justify-self: stretch; }
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
    if (field.role === 'textarea' || field.role === 'multiline' || field.role === 'code' || field.role === 'json') return 'textarea'
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
function hostFormControlLayoutForPrimitive(primitive: HostFormPrimitive): HostFormControlLayout {
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
  if (field.presenter !== undefined && hostPresenterPrimitive(field) === undefined) return {
    code: 'unsupported-presenter', fieldPath: field.path, detail: `incompatible Host form presenter: ${field.presenter.kind}`,
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
  if (field.required && (value === undefined || value === null || value === '' || Array.isArray(value) && value.length === 0)) return managerCopy(locale, 'form.required')
  if (value === undefined || value === null || value === '') return undefined
  if (field.choices !== undefined && !Array.isArray(value) && !field.choices.some(choice => Object.is(choice.value, value))) return managerCopy(locale, 'form.choice-invalid')
  if (field.type === 'array') {
    if (!Array.isArray(value)) return managerCopy(locale, 'form.choice-invalid')
    if (field.min !== undefined && value.length < field.min) return productLocale(locale) === 'zh-CN' ? `至少选择 ${field.min} 项` : `Choose at least ${field.min}`
    if (field.max !== undefined && value.length > field.max) return productLocale(locale) === 'zh-CN' ? `最多选择 ${field.max} 项` : `Choose at most ${field.max}`
    if (field.choices !== undefined && value.some(item => !field.choices!.some(choice => Object.is(choice.value, item)))) return managerCopy(locale, 'form.choice-invalid')
  }
  if (field.role === 'date' && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value))) return productLocale(locale) === 'zh-CN' ? '请输入有效日期' : 'Enter a valid date'
  if (field.role === 'datetime' && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} [0-2]\d:[0-5]\d:[0-5]\d$/u.test(value))) return productLocale(locale) === 'zh-CN' ? '请输入有效日期和时间' : 'Enter a valid date and time'
  if (field.role === 'time' && (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value))) return productLocale(locale) === 'zh-CN' ? '请输入有效时间' : 'Enter a valid time'
  if (field.role === 'color' && (typeof value !== 'string' || !/^#[\da-fA-F]{6}$/u.test(value))) return productLocale(locale) === 'zh-CN' ? '请输入有效 HEX 颜色' : 'Enter a valid HEX color'
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

  /** Host-private one-shot secret input. Its value is never part of a Config snapshot. */
  transientSecret(id: string, onDraft: (value: string) => void): HostTransientSecretControl {
    const input = createTDesignElement(this.document, 't-input', 'input')
    input.id = id
    input.tabIndex = 0
    input.dataset.hostTransientSecret = 'true'
    input.setAttribute('autocomplete', 'new-password')
    const emit = (value: string): void => onDraft(value)
    const apply = (value: string): void => {
      setTDesignProps(input, {
        value,
        defaultValue: value,
        type: 'password',
        placeholder: managerCopy(this.locale(), 'form.text-placeholder'),
        onChange: emit,
      })
    }
    apply('')
    const dispose = bindTDesignTextInput(input, emit)
    return { root: input, focusTarget: input, primitive: 'input', clear: () => apply(''), dispose }
  }

  section(title?: string, description?: string, icon?: CordisXConfigFormIcon): { readonly root: HTMLElement; readonly content: HTMLElement } {
    const root = this.document.createElement('section')
    root.className = 'cxf-section'
    if (title !== undefined) {
      const heading = this.document.createElement('div')
      heading.className = 'cxf-section-heading'
      const titleNode = this.document.createElement('h3')
      titleNode.className = 'cxf-section-title'
      if (icon !== undefined) {
        const glyph = createHostSurfaceIcon(this.document, icon)
        glyph.classList.add('cxf-form-icon')
        titleNode.append(glyph)
      }
      titleNode.append(this.document.createTextNode(title))
      heading.append(titleNode)
      if (description !== undefined) {
        const copy = this.document.createElement('p')
        copy.className = 'cxf-section-description'
        copy.textContent = description
        heading.append(copy)
      }
      root.append(heading)
    }
    const content = this.document.createElement('div')
    content.className = 'cxf-form-grid'
    root.append(content)
    return { root, content }
  }

  select<Value>(
    label: string,
    options: readonly TDesignSelectOption<Value>[],
    value: Value | undefined,
    onChange: (value: Value | undefined) => void,
    config: { readonly id?: string; readonly disabled?: boolean; readonly readonly?: boolean; readonly clearable?: boolean; readonly placeholder?: string } = {},
  ): TDesignSelectElement<Value> {
    return createTDesignSelect(this.document, this.portalHost, options, {
      label,
      placeholder: config.placeholder ?? managerCopy(this.locale(), 'form.select-placeholder'),
      onChange,
      ...(value === undefined ? {} : { value }),
      ...config,
    })
  }

  item(options: { readonly id: string; readonly label: string; readonly help?: string; readonly required?: boolean; readonly fullWidth?: boolean; readonly icon?: CordisXConfigFormIcon }): HostFormItem {
    const root = this.document.createElement('div')
    root.className = 'cxf-item'
    root.dataset.fullWidth = String(options.fullWidth === true)
    const labelRow = this.document.createElement('div')
    labelRow.className = 'cxf-label-row'
    const label = this.document.createElement('label')
    label.className = 'cxf-label'
    label.id = `${options.id}-label`
    label.htmlFor = options.id
    if (options.icon !== undefined) {
      const glyph = createHostSurfaceIcon(this.document, options.icon)
      glyph.classList.add('cxf-form-icon')
      label.append(glyph)
    }
    label.append(this.document.createTextNode(options.label))
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
      root, control, labelRow, label, ...(help === undefined ? {} : { help }), error,
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

  /**
   * A Host-owned, portalled per-field menu. Plugins supply neither its DOM nor
   * its actions: callers only provide structured callbacks and availability.
   */
  fieldActionMenu(options: {
    readonly label: string
    readonly icon?: CordisXConfigFormIcon
    readonly canUseDefault: () => boolean
    readonly hasFieldDraft: () => boolean
    readonly useDefault: () => void
    readonly rollback: () => void
    readonly copyPath: () => Promise<boolean>
  }): HostFormFieldActionMenu {
    const locale = this.locale()
    const trigger = this.button(managerCopy(locale, 'form.field-actions'), { icon: options.icon ?? 'host:settings', density: 'icon', variant: 'text' })
    trigger.classList.add('cxf-field-menu-trigger')
    trigger.dataset.hostFormAction = 'field-actions'
    trigger.setAttribute('aria-haspopup', 'menu')
    trigger.setAttribute('aria-expanded', 'false')
    const menu = this.document.createElement('div')
    menu.className = 'cxf-field-menu'
    menu.hidden = true
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', options.label)
    const menuId = `cxf-field-menu-${Math.random().toString(36).slice(2)}`
    menu.id = menuId
    trigger.setAttribute('aria-controls', menuId)
    const status = this.document.createElement('div')
    status.className = 'cxf-field-menu-status'
    status.hidden = true
    status.setAttribute('role', 'status')
    const item = (label: string, icon: CordisXConfigFormIcon, disabled: boolean, handler: () => void | Promise<void>): HTMLButtonElement => {
      const button = this.document.createElement('button')
      button.className = 'cxf-field-menu-item'
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      button.disabled = disabled
      const glyph = createHostSurfaceIcon(this.document, icon)
      glyph.classList.add('cxf-form-icon')
      glyph.setAttribute('aria-hidden', 'true')
      button.append(glyph, this.document.createTextNode(label))
      button.addEventListener('click', () => { void handler() })
      return button
    }
    let visible = false
    let disposed = false
    const update = (): void => {
      const defaultAvailable = options.canUseDefault()
      useDefault.disabled = !defaultAvailable
      useDefault.title = defaultAvailable ? '' : managerCopy(this.locale(), 'form.use-default-unavailable')
      rollback.disabled = !options.hasFieldDraft()
    }
    const close = (restoreFocus: boolean): void => {
      if (!visible) return
      visible = false
      menu.hidden = true
      trigger.setAttribute('aria-expanded', 'false')
      if (restoreFocus && trigger.isConnected) trigger.focus()
    }
    const position = (): void => {
      if (!visible) return
      const view = this.document.defaultView
      if (view === null) return
      const rect = trigger.getBoundingClientRect()
      const gutter = 8
      const width = Math.min(Math.max(208, menu.offsetWidth || 208), view.innerWidth - gutter * 2)
      const above = rect.top > view.innerHeight - rect.bottom && rect.top > (menu.offsetHeight || 120)
      menu.style.inlineSize = `${width}px`
      menu.style.insetInlineStart = `${Math.max(gutter, Math.min(rect.left, view.innerWidth - width - gutter))}px`
      menu.style.insetBlockStart = `${above ? Math.max(gutter, rect.top - (menu.offsetHeight || 120) - 4) : Math.min(view.innerHeight - gutter, rect.bottom + 4)}px`
    }
    const open = (): void => {
      if (disposed) return
      update()
      visible = true
      menu.hidden = false
      trigger.setAttribute('aria-expanded', 'true')
      this.document.defaultView?.requestAnimationFrame(position)
    }
    const useDefault = item(managerCopy(locale, 'form.use-default'), 'host:reset', false, () => {
      options.useDefault()
      close(true)
    })
    const rollback = item(managerCopy(locale, 'form.rollback-field'), 'host:reset', false, () => {
      options.rollback()
      close(true)
    })
    const copyPath = item(managerCopy(locale, 'form.copy-path'), 'host:files', false, async () => {
      const copied = await options.copyPath()
      status.hidden = false
      status.textContent = managerCopy(this.locale(), copied ? 'form.path-copied' : 'form.path-copy-unavailable')
      this.document.defaultView?.setTimeout(() => { status.hidden = true }, 1800)
    })
    menu.append(useDefault, rollback, copyPath, status)
    tdesignPortalContainer(this.portalHost).append(menu)
    const onPointerDown = (event: Event): void => {
      if (!visible) return
      const path = event.composedPath()
      if (path.includes(trigger) || path.includes(menu)) return
      close(true)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!visible) return
      const enabled = [useDefault, rollback, copyPath].filter(button => !button.disabled)
      // A menu lives in the Host portal Shadow root, so document.activeElement
      // is the portal host rather than the focused menu button. The composed
      // path is the stable cross-root focus identity for navigation/Enter.
      const focusedItem = event.composedPath().find(node => node === useDefault || node === rollback || node === copyPath) as HTMLButtonElement | undefined
      const current = focusedItem === undefined ? -1 : enabled.indexOf(focusedItem)
      if (event.key === 'Escape') {
        event.preventDefault()
        close(true)
      } else if (event.key === 'Enter' && focusedItem !== undefined && !focusedItem.disabled) {
        // Native buttons normally activate on Enter too. Keeping this at the
        // Host menu boundary makes the documented keyboard contract stable
        // across ordinary and Shadow-DOM focus paths.
        event.preventDefault()
        focusedItem.click()
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length
        enabled[next]?.focus()
      }
    }
    const onTrigger = (): void => { visible ? close(false) : open() }
    trigger.addEventListener('click', onTrigger)
    this.document.addEventListener('pointerdown', onPointerDown, true)
    this.document.addEventListener('keydown', onKeyDown, true)
    this.document.defaultView?.addEventListener('resize', position)
    this.document.defaultView?.addEventListener('scroll', position, true)
    return {
      trigger,
      dispose: (): void => {
        if (disposed) return
        disposed = true
        close(false)
        trigger.removeEventListener('click', onTrigger)
        this.document.removeEventListener('pointerdown', onPointerDown, true)
        this.document.removeEventListener('keydown', onKeyDown, true)
        this.document.defaultView?.removeEventListener('resize', position)
        this.document.defaultView?.removeEventListener('scroll', position, true)
        menu.remove()
      },
    }
  }

  connect(item: HostFormItem, control: HostFormControl): void {
    item.root.dataset.controlLayout = hostFormControlLayoutForPrimitive(control.primitive)
    const describedBy = [item.help?.id, item.error.id].filter(Boolean).join(' ')
    const target = control.primitive === 'radio' ? control.root : control.focusTarget ?? control.root
    target.setAttribute('aria-describedby', describedBy)
    if (control.primitive === 'radio') {
      item.label.removeAttribute('for')
      control.root.setAttribute('aria-labelledby', item.label.id)
    }
  }

  private objectArrayControl(field: CordisXConfigFieldSnapshot, id: string, onDraft: (value: unknown, issue?: string) => void): HostFormControl {
    const root = this.document.createElement('div')
    root.className = 'cxf-array-editor'
    root.dataset.hostFormPrimitive = 'object-array'
    root.dataset.presenter = field.presenter?.kind ?? 'array.object-auto'
    const values = Array.isArray(field.value) ? field.value.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item)) : []
    const ids = values.map(() => `cxf-array-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`)
    const limit = field.max ?? 64
    const schema = field.arrayItemSchema
    const canReorder = field.presenter?.options?.allowReorder !== false
    let connectedOnce = root.isConnected
    let dismissActiveDialog: (() => void) | undefined
    const observer = this.document.defaultView === null ? undefined : new this.document.defaultView.MutationObserver(() => {
      if (root.isConnected) { connectedOnce = true; return }
      if (connectedOnce) { dismissActiveDialog?.(); observer?.disconnect() }
    })
    observer?.observe(this.document.documentElement, { childList: true, subtree: true })
    const emit = (next: readonly Record<string, unknown>[]): void => onDraft(next, validateHostFormValue(field, next, this.locale()))
    const summary = (value: Record<string, unknown>): string => schema?.fields?.map(({ key, schema }) => `${schema.label ?? key}: ${String(value[key] ?? '')}`).join(' · ') || managerCopy(this.locale(), 'form.array-item')
    const render = (): void => {
      root.replaceChildren()
      const toolbar = this.document.createElement('div')
      toolbar.className = 'cxf-array-editor-toolbar'
      const add = this.button(managerCopy(this.locale(), 'form.add-item'), { icon: 'host:save' })
      add.disabled = field.disabled || values.length >= limit
      add.addEventListener('click', () => {
        const item = Object.fromEntries((schema?.fields ?? []).map(({ key, schema }) => [key, schema.type === 'boolean' ? false : schema.type === 'number' || schema.type === 'natural' ? schema.min ?? 0 : '']))
        values.push(item); ids.push(`cxf-array-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`); emit(values); render(); open(values.length - 1)
      })
      toolbar.append(add); root.append(toolbar)
      values.forEach((value, index) => {
        const row = this.document.createElement('div'); row.className = 'cxf-array-row'; row.dataset.hostArrayItemId = ids[index]!
        const handle = this.document.createElement('span'); handle.className = 'cxf-array-row-drag-handle'; handle.dataset.hostArrayDragHandle = 'true'; handle.setAttribute('role', 'img'); handle.setAttribute('aria-label', managerCopy(this.locale(), 'form.reorder-handle')); handle.setAttribute('title', managerCopy(this.locale(), 'form.reorder-handle'))
        const handleIcon = createHostSurfaceIcon(this.document, 'host:more'); handleIcon.classList.add('cxf-form-icon'); handleIcon.setAttribute('aria-hidden', 'true'); handle.append(handleIcon)
        const text = this.document.createElement('span'); text.className = 'cxf-array-row-summary'; text.textContent = summary(value)
        const actions = this.document.createElement('div'); actions.className = 'cxf-array-row-actions'
        const edit = this.button(managerCopy(this.locale(), 'form.edit-item'), { density: 'icon', icon: 'host:settings' }); edit.disabled = field.disabled; edit.addEventListener('click', () => open(index))
        const duplicate = this.button(managerCopy(this.locale(), 'form.duplicate-item'), { density: 'icon', icon: 'host:files' }); duplicate.disabled = field.disabled || values.length >= limit; duplicate.addEventListener('click', () => { values.splice(index + 1, 0, structuredClone(value)); ids.splice(index + 1, 0, `cxf-array-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`); emit(values); render() })
        const moveUp = this.button(managerCopy(this.locale(), 'form.move-item-up'), { density: 'icon', icon: 'host:back' }); moveUp.classList.add('cxf-array-row-action-up'); moveUp.disabled = field.disabled || !canReorder || index === 0; moveUp.addEventListener('click', () => { [values[index - 1], values[index]] = [values[index]!, values[index - 1]!]; [ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!]; emit(values); render() })
        const moveDown = this.button(managerCopy(this.locale(), 'form.move-item-down'), { density: 'icon', icon: 'host:back' }); moveDown.classList.add('cxf-array-row-action-down'); moveDown.disabled = field.disabled || !canReorder || index === values.length - 1; moveDown.addEventListener('click', () => { [values[index + 1], values[index]] = [values[index]!, values[index + 1]!]; [ids[index + 1], ids[index]] = [ids[index]!, ids[index + 1]!]; emit(values); render() })
        const remove = this.button(managerCopy(this.locale(), 'form.delete-item'), { density: 'icon', tone: 'danger', icon: 'host:reset' }); remove.disabled = field.disabled || values.length <= (field.min ?? 0); remove.addEventListener('click', () => { values.splice(index, 1); ids.splice(index, 1); emit(values); render() })
        actions.append(edit, duplicate, moveUp, moveDown, remove); row.append(handle, text, actions); root.append(row)
      })
    }
    const open = (index: number): void => {
      dismissActiveDialog?.()
      const host = tdesignPortalContainer(this.portalHost)
      const rowId = ids[index]!
      const restore = root.querySelector<HTMLElement>(`[data-host-array-item-id="${rowId}"] button`)
      const dialog = this.document.createElement('section'); dialog.className = 'cxf-array-editor-dialog'; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.tabIndex = -1
      const head = this.document.createElement('div'); head.className = 'cxf-array-editor-dialog-head'
      const title = this.document.createElement('strong'); title.id = `${id}-${rowId}-title`; title.textContent = field.label ?? managerCopy(this.locale(), 'form.edit-item'); dialog.setAttribute('aria-labelledby', title.id)
      const close = this.button(managerCopy(this.locale(), 'form.close'), { density: 'icon', icon: 'host:reset' }); close.setAttribute('aria-label', managerCopy(this.locale(), 'form.close'))
      let dismissed = false
      const dismiss = () => {
        if (dismissed) return
        dismissed = true
        this.document.removeEventListener('pointerdown', onPointerDown, true)
        dialog.removeEventListener('keydown', onKey)
        dialog.remove()
        if (dismissActiveDialog === dismiss) dismissActiveDialog = undefined
        restore?.focus()
      }
      close.addEventListener('click', dismiss); head.append(title, close); dialog.append(head)
      const fields = this.document.createElement('div'); fields.className = 'cxf-array-editor-dialog-fields'; dialog.append(fields)
      for (const child of schema?.fields ?? []) {
        const slot = this.document.createElement('div'); slot.className = 'cxf-array-editor-dialog-field'
        const label = this.document.createElement('label'); label.textContent = child.schema.label ?? child.key
        const childField: CordisXConfigFieldSnapshot = { namespace: field.namespace, path: [...field.path, rowId, child.key], type: child.schema.type, ...(child.schema.role === undefined ? {} : { role: child.schema.role }), ...(child.schema.choices === undefined ? {} : { choices: child.schema.choices }), ...(child.schema.presenter === undefined ? {} : { presenter: child.schema.presenter }), ...(child.schema.item === undefined ? {} : { arrayItemSchema: child.schema.item }), value: values[index]![child.key], disabled: field.disabled || child.schema.disabled, required: child.schema.required, ...(child.schema.min === undefined ? {} : { min: child.schema.min }), ...(child.schema.max === undefined ? {} : { max: child.schema.max }), ...(child.schema.step === undefined ? {} : { step: child.schema.step }), ...(child.schema.arrayItemType === undefined ? {} : { arrayItemType: child.schema.arrayItemType }) }
        const control = this.control(childField, `${id}-${rowId}-${child.key}`, next => { values[index] = { ...values[index], [child.key]: next }; emit(values); render() })
        label.htmlFor = `${id}-${rowId}-${child.key}`; slot.append(label, control.root); fields.append(slot)
      }
      const focusable = (): HTMLElement[] => [...dialog.querySelectorAll<HTMLElement>('button, [tabindex]:not([tabindex="-1"])')].filter(element => !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true')
      const onKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape') { event.preventDefault(); dismiss(); return }
        if (event.key !== 'Tab') return
        const items = focusable(); if (items.length === 0) return
        const active = this.document.activeElement
        const current = items.indexOf(active as HTMLElement)
        if (event.shiftKey && (current <= 0 || active === dialog)) { event.preventDefault(); items.at(-1)?.focus() }
        else if (!event.shiftKey && current === items.length - 1) { event.preventDefault(); items[0]?.focus() }
      }
      const onPointerDown = (event: Event) => { if (!event.composedPath().includes(dialog)) dismiss() }
      dialog.addEventListener('keydown', onKey); this.document.addEventListener('pointerdown', onPointerDown, true); host.append(dialog); dismissActiveDialog = dismiss; close.focus()
    }
    render()
    return {
      root, focusTarget: root, primitive: 'object-array',
      dispose: () => { dismissActiveDialog?.(); observer?.disconnect() },
    }
  }

  control(
    field: CordisXConfigFieldSnapshot,
    id: string,
    onDraft: (value: unknown, issue?: string) => void,
    options: { readonly placeholder?: string; readonly textareaRows?: number } = {},
  ): HostFormControl {
    const primitive = selectHostFormPrimitive(field)
    const diagnostic = hostFormDiagnostic(field)
    if (primitive === 'sensitive-unavailable') return {
      root: this.alert(managerCopy(this.locale(), 'form.sensitive-unavailable'), 'warning'),
      primitive,
    }
    if (primitive === 'unsupported') return {
      root: this.alert(managerCopy(this.locale(), 'form.unsupported'), 'warning'), primitive, ...(diagnostic === undefined ? {} : { diagnostic }),
    }
    if (primitive === 'multi-select') {
      const select = createTDesignMultiSelect<CordisXJsonScalar>(this.document, this.portalHost, field.choices!, {
        id,
        label: field.label ?? field.path.at(-1) ?? managerCopy(this.locale(), 'form.select-placeholder'),
        placeholder: managerCopy(this.locale(), 'form.select-placeholder'),
        value: Array.isArray(field.value) ? field.value as CordisXJsonScalar[] : [],
        disabled: field.disabled,
        clearable: true,
        onChange: value => onDraft(value, validateHostFormValue(field, value, this.locale())),
      })
      setCommonControlState(select, field, id)
      return { root: select, focusTarget: select, primitive, ...(diagnostic === undefined ? {} : { diagnostic }) }
    }
    if (primitive === 'tag-input') {
      const value = Array.isArray(field.value) ? field.value.filter((item): item is string | number => typeof item === 'string' || typeof item === 'number') : []
      const tags = createTDesignTagInput(this.document, {
        id,
        label: field.label ?? field.path.at(-1) ?? managerCopy(this.locale(), 'form.text-placeholder'),
        placeholder: managerCopy(this.locale(), 'form.text-placeholder'),
        value,
        ...(field.max === undefined ? {} : { max: field.max }),
        disabled: field.disabled,
        onChange: next => {
          const normalized = field.arrayItemType === 'string' ? next.map(String)
            : next.map(Number).filter(Number.isFinite)
          onDraft(normalized, validateHostFormValue(field, normalized, this.locale()))
        },
      })
      setCommonControlState(tags, field, id)
      return { root: tags, focusTarget: tags, primitive, ...(diagnostic === undefined ? {} : { diagnostic }) }
    }
    if (primitive === 'date-picker') {
      const date = createTDesignElement(this.document, 't-date-picker', primitive)
      date.tabIndex = field.disabled ? -1 : 0
      setCommonControlState(date, field, id)
      const dateTime = field.role === 'datetime'
      const initial = typeof field.value === 'string' ? field.value : undefined
      if (dateTime) {
        const root = this.document.createElement('div')
        root.className = 'cxf-datetime-control'
        root.dataset.hostFormComposite = 'datetime'
        const dateValue = initial?.slice(0, 10)
        const initialTime = /^\d{4}-\d{2}-\d{2} ([0-2]\d:[0-5]\d)(?::[0-5]\d)?$/u.exec(initial ?? '')?.[1] ?? '00:00'
        const options: TDesignSelectOption<string>[] = []
        for (let hour = 0; hour < 24; hour += 1) for (let minute = 0; minute < 60; minute += 15) {
          const value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
          options.push({ label: value, value })
        }
        let selectedDate = dateValue ?? ''
        let selectedTime = initialTime
        const emit = () => onDraft(selectedDate === '' ? '' : `${selectedDate} ${selectedTime}:00`, validateHostFormValue(field, selectedDate === '' ? '' : `${selectedDate} ${selectedTime}:00`, this.locale()))
        setTDesignProps(date, {
          value: dateValue, defaultValue: dateValue,
          placeholder: productLocale(this.locale()) === 'zh-CN' ? '选择日期' : 'Select date',
          format: 'YYYY-MM-DD', disabled: field.disabled,
          popupProps: { attach: () => this.portalHost },
          onChange: (value: string | undefined) => { selectedDate = value ?? ''; emit() },
        })
        const time = createTDesignSelect(this.document, this.portalHost, options, {
          id: `${id}-time`, label: field.label ?? field.path.at(-1) ?? 'Time',
          placeholder: productLocale(this.locale()) === 'zh-CN' ? '选择时间' : 'Select time', value: selectedTime,
          disabled: field.disabled, clearable: false,
          onChange: value => { selectedTime = value ?? selectedTime; emit() },
        })
        time.classList.add('cxf-time-select')
        root.append(date, time)
        return { root, focusTarget: date, primitive, ...(diagnostic === undefined ? {} : { diagnostic }) }
      }
      setTDesignProps(date, {
        value: initial,
        defaultValue: initial,
        placeholder: productLocale(this.locale()) === 'zh-CN' ? '选择日期' : 'Select date',
        format: 'YYYY-MM-DD',
        disabled: field.disabled,
        popupProps: { attach: () => this.portalHost },
        onChange: (value: string | undefined) => onDraft(value, validateHostFormValue(field, value, this.locale())),
      })
      return { root: date, focusTarget: date, primitive, ...(diagnostic === undefined ? {} : { diagnostic }) }
    }
    if (primitive === 'time-picker') {
      const options: TDesignSelectOption<string>[] = []
      for (let hour = 0; hour < 24; hour += 1) for (let minute = 0; minute < 60; minute += 15) {
        const value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
        options.push({ label: value, value })
      }
      const time = createTDesignSelect(this.document, this.portalHost, options, {
        id, label: field.label ?? field.path.at(-1) ?? 'Time',
        placeholder: productLocale(this.locale()) === 'zh-CN' ? '选择时间' : 'Select time',
        value: typeof field.value === 'string' ? field.value : undefined,
        disabled: field.disabled,
        clearable: true,
        onChange: value => onDraft(value, validateHostFormValue(field, value, this.locale())),
      })
      time.classList.add('cxf-time-select')
      setCommonControlState(time, field, id)
      time.dataset.hostFormPrimitive = primitive
      return { root: time, focusTarget: time, primitive, ...(diagnostic === undefined ? {} : { diagnostic }) }
    }
    if (primitive === 'color-picker') {
      const root = this.document.createElement('div')
      root.className = 'cxf-color-control'
      // This is a semantic pair (a Host-owned platform color picker and an
      // editable TDesign HEX input), not a second field shell. The browser
      // picker is only the platform color well; the value, validation, draft
      // and all Host state continue to flow through the one TDesign input.
      root.dataset.hostFormComposite = primitive
      const current = typeof field.value === 'string' ? field.value.toUpperCase() : ''
      const hex = createTDesignElement(this.document, 't-input', primitive)
      hex.id = id
      hex.tabIndex = field.disabled ? -1 : 0
      const picker = this.document.createElement('input')
      picker.className = 'cxf-color-picker'
      picker.type = 'color'
      picker.value = /^#[\dA-F]{6}$/u.test(current) ? current : '#000000'
      picker.disabled = field.disabled
      picker.setAttribute('aria-label', productLocale(this.locale()) === 'zh-CN' ? '选择颜色' : 'Choose color')
      picker.addEventListener('input', () => {
        const next = picker.value.toUpperCase()
        hex.setAttribute('value', next)
        setTDesignProps(hex, { value: next, defaultValue: next })
        onDraft(next, validateHostFormValue(field, next, this.locale()))
      })
      setTDesignProps(hex, {
        value: current, defaultValue: current, disabled: field.disabled, placeholder: '#RRGGBB',
        onChange: (next: string) => {
          const normalized = next.trim().toUpperCase()
          if (/^#[\dA-F]{6}$/u.test(normalized)) picker.value = normalized
          onDraft(normalized, validateHostFormValue(field, normalized, this.locale()))
        },
      })
      root.append(hex, picker)
      return { root, focusTarget: hex, primitive, ...(diagnostic === undefined ? {} : { diagnostic }) }
    }
    if (primitive === 'select') {
      const select = createTDesignSelect<CordisXJsonScalar>(this.document, this.portalHost, field.choices!, {
        id,
        label: field.label ?? field.path.at(-1) ?? managerCopy(this.locale(), 'form.select-placeholder'),
        placeholder: managerCopy(this.locale(), 'form.select-placeholder'),
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
      const segmented = field.presenter?.kind === 'choice.segmented'
      group.dataset.enumPresentation = segmented ? 'segmented' : 'radio'
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
        variant: segmented ? 'primary-filled' : 'outline',
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
      // t-switch parses a declarative `value` as its String arm before its
      // Boolean arm. Give it an explicit, typed wire pair so its first render
      // remains in sync with the Host Boolean rather than falling back to off.
      const switchValue = field.value === true ? 'true' : 'false'
      control.setAttribute('value', switchValue)
      control.setAttribute('default-value', switchValue)
      control.setAttribute('custom-value', '["true","false"]')
      setTDesignProps(control, {
        value: switchValue,
        defaultValue: switchValue,
        customValue: ['true', 'false'],
        disabled: field.disabled,
        label: [managerCopy(this.locale(), 'form.switch-on'), managerCopy(this.locale(), 'form.switch-off')],
        onChange: (value: boolean | string) => {
          const checked = value === true || value === 'true'
          control.setAttribute('aria-checked', String(checked))
          onDraft(checked)
        },
      })
      return { root: control, focusTarget: control, primitive, ...(diagnostic === undefined ? {} : { diagnostic }) }
    }
    if (primitive === 'slider') {
      const root = this.document.createElement('div')
      root.className = 'cxf-slider-control'
      root.dataset.hostFormComposite = primitive
      const value = typeof field.value === 'number' ? field.value : field.min ?? 0
      const slider = createTDesignElement(this.document, 't-slider', primitive)
      const numeric = createTDesignElement(this.document, 't-input-number', primitive)
      slider.tabIndex = field.disabled ? -1 : 0
      numeric.tabIndex = field.disabled ? -1 : 0
      slider.setAttribute('role', 'slider')
      slider.setAttribute('aria-valuenow', String(value))
      slider.setAttribute('aria-valuemin', String(field.min ?? 0))
      slider.setAttribute('aria-valuemax', String(field.max ?? 100))
      if (field.required) slider.setAttribute('aria-required', 'true')
      if (field.disabled) slider.setAttribute('aria-disabled', 'true')
      const apply = (next: number | undefined): void => {
        const resolved = next ?? value
        slider.setAttribute('aria-valuenow', String(resolved))
        setTDesignProps(slider, { value: resolved, defaultValue: resolved })
        setTDesignProps(numeric, { value: resolved, defaultValue: resolved })
        onDraft(resolved, validateHostFormValue(field, resolved, this.locale()))
      }
      setTDesignProps(slider, {
        value, defaultValue: value, min: field.min ?? 0, max: field.max ?? 100, step: field.step ?? 1, disabled: field.disabled,
        label: true, tooltipProps: { placement: 'top' },
        onChange: (next: number) => apply(next),
      })
      setTDesignProps(numeric, {
        value, defaultValue: value, min: field.min, max: field.max, step: field.step, disabled: field.disabled,
        placeholder: managerCopy(this.locale(), 'form.text-placeholder'),
        onChange: (next: number | undefined) => apply(next),
      })
      root.append(slider, numeric)
      return { root, focusTarget: slider, primitive, ...(diagnostic === undefined ? {} : { diagnostic }) }
    }
    if (primitive === 'object-array') return this.objectArrayControl(field, id, onDraft)
    const tag = primitive === 'textarea' || primitive === 'json-textarea' ? 't-textarea'
      : primitive === 'number-input' ? 't-input-number'
        : 't-input'
    const input = createTDesignElement(this.document, tag, primitive)
    input.classList.toggle('cxf-textarea', primitive === 'textarea' || primitive === 'json-textarea')
    input.classList.toggle('cxf-json', primitive === 'json-textarea')
    input.tabIndex = field.disabled ? -1 : 0
    setCommonControlState(input, field, id)
    if (primitive === 'number-input') {
      setTDesignProps(input, {
        value: typeof field.value === 'number' ? field.value : undefined,
        defaultValue: typeof field.value === 'number' ? field.value : undefined,
        placeholder: managerCopy(this.locale(), 'form.text-placeholder'),
        min: field.min,
        max: field.max,
        step: field.step,
        disabled: field.disabled,
        onChange: (next: number | undefined) => onDraft(next, validateHostFormValue(field, next, this.locale())),
      })
    } else {
      const initial = primitive === 'json-textarea' ? JSON.stringify(field.value, null, 2) : String(field.value ?? '')
      const emit = (next: string): void => {
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
      }
      setTDesignProps(input, {
        value: initial,
        defaultValue: initial,
        disabled: field.disabled,
        placeholder: options.placeholder ?? (primitive === 'path-input' ? '/absolute/path' : managerCopy(this.locale(), 'form.text-placeholder')),
        autosize: primitive === 'textarea' || primitive === 'json-textarea'
          ? { minRows: options.textareaRows ?? 4, maxRows: 12 }
          : undefined,
        onChange: emit,
      })
      const disposeText = bindTDesignTextInput(input, emit)
      const disposeRows = primitive === 'textarea' || primitive === 'json-textarea'
        ? bindTDesignTextareaRows(input, options.textareaRows ?? 4)
        : undefined
      return {
        root: input,
        focusTarget: input,
        primitive,
        dispose: () => { disposeText(); disposeRows?.() },
        ...(diagnostic === undefined ? {} : { diagnostic }),
      }
    }
    return { root: input, focusTarget: input, primitive, ...(diagnostic === undefined ? {} : { diagnostic }) }
  }

  button(label: string, options: {
    readonly type?: 'button' | 'submit'
    readonly variant?: 'default' | 'primary' | 'text'
    readonly tone?: 'default' | 'danger'
    /** Internal Host actions may use bundled navigation glyphs outside schema icons. */
    readonly icon?: string
    readonly density?: 'icon' | 'icon-label'
    readonly action?: 'restore-default' | 'undo' | 'save'
  } = {}): TDesignButtonElement {
    const button = createTDesignButton(this.document, label, options)
    button.className = 'cxf-button cxf-tdesign-control'
    button.dataset.variant = options.variant ?? 'default'
    button.dataset.tone = options.tone ?? 'default'
    button.dataset.density = options.density ?? 'icon-label'
    if (options.action !== undefined) button.dataset.hostFormAction = options.action
    const icon = options.icon ?? (options.action === 'save' ? 'host:save' : options.action === undefined ? undefined : 'host:reset')
    if (icon !== undefined) {
      button.dataset.hostFormActionIcon = icon
      // The icon remains Host-owned and decorative. TDesign keeps the button
      // chrome and keyboard behavior; no plugin SVG or component instance is
      // projected into the control.
      const glyph = createHostSurfaceIcon(this.document, icon)
      glyph.classList.add('cxf-form-icon')
      glyph.setAttribute('slot', 'icon')
      button.append(glyph)
    }
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
