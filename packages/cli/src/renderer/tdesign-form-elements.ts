import { HOST_ICON_16PX_CSS } from './icons.js'
import {
  installTDesignWebComponents,
  TDESIGN_PORTAL_CSS,
  TDESIGN_SCOPED_TOKEN_CSS,
  TDESIGN_WEB_COMPONENTS_VERSION,
} from './vendor/tdesign-web-components-1.2.10.js'

export { TDESIGN_SCOPED_TOKEN_CSS, TDESIGN_WEB_COMPONENTS_VERSION }

export interface TDesignElement extends HTMLElement {
  disabled?: boolean
  readonly?: boolean
  value?: unknown
  checked?: boolean
  update?: () => void
  updateProps?: (props: Readonly<Record<string, unknown>>) => void
  /** Omi uses this lifecycle hook to synchronize controlled component state. */
  receiveProps?: (
    nextProps: Readonly<Record<string, unknown>>,
    previousProps: Readonly<Record<string, unknown>>,
  ) => unknown
  props?: Record<string, unknown>
  [key: string]: unknown
}

export interface TDesignButtonElement extends TDesignElement {
  disabled: boolean
  type: 'button' | 'submit'
}

export interface TDesignButtonOptions {
  readonly type?: 'button' | 'submit'
  readonly variant?: 'default' | 'primary' | 'text'
  readonly tone?: 'default' | 'danger'
  /** Compact actions retain an accessible label but render only their icon. */
  readonly density?: 'icon' | 'icon-label'
}

export interface TDesignSelectOption<Value> {
  readonly label: string
  readonly value: Value
  readonly disabled?: boolean
  /** Optional Host-owned application artwork used by branded selectors. */
  readonly iconUri?: string
  /** App-theme dark variant; defaults to iconUri when the artwork is invariant. */
  readonly darkIconUri?: string
  /** Optical artwork size inside the fixed option icon seat. */
  readonly iconSize?: number
}

export interface TDesignSelectElement<Value> extends TDesignElement {
  readonly selectedValue: Value | undefined
  setSelectedValue(value: Value | undefined, notify?: boolean): void
  setBusy(busy: boolean): void
  dispose(): void
}

export interface TDesignMultiSelectElement<Value> extends TDesignElement {
  readonly selectedValues: readonly Value[]
  setSelectedValues(value: readonly Value[], notify?: boolean): void
  setBusy(busy: boolean): void
  dispose(): void
}

export interface TDesignTagInputElement<Value> extends TDesignElement {
  readonly values: readonly Value[]
  setValues(value: readonly Value[], notify?: boolean): void
}

function canInstall(document: Document): boolean {
  const view = document.defaultView
  return view !== null
    && !/jsdom/iu.test(view.navigator.userAgent)
    && view.customElements !== undefined
    && typeof view.CSSStyleSheet?.prototype.replaceSync === 'function'
}

let installed = false

/**
 * TDesign Web Components invoke `onChange` with their browser CustomEvent,
 * while a few test doubles and keyboard helpers invoke it with the value
 * directly. Keep that library-specific wire shape at one Host boundary so a
 * Config draft can never stringify an event to "[object CustomEvent]".
 */
export function unwrapTDesignChangeValue<Value>(payload: unknown): Value | undefined {
  if (payload !== null && typeof payload === 'object') {
    const detail = (payload as { readonly detail?: unknown }).detail
    if (detail !== null && typeof detail === 'object' && Object.hasOwn(detail, 'value')) {
      return (detail as { readonly value?: Value }).value
    }
    if (detail !== undefined) return detail as Value
    if (Object.hasOwn(payload, 'value')) return (payload as { readonly value?: Value }).value
    const target = (payload as { readonly target?: unknown }).target
    // Native Event targets expose `value` through HTMLElement's prototype,
    // while TDesign's CustomEvent payload keeps it in `detail`. Accept both
    // official browser shapes before a draft observes the event object.
    if (target !== null && typeof target === 'object' && 'value' in target) {
      return (target as { readonly value?: Value }).value
    }
    const currentTarget = (payload as { readonly currentTarget?: unknown }).currentTarget
    if (currentTarget !== null && typeof currentTarget === 'object' && 'value' in currentTarget) {
      return (currentTarget as { readonly value?: Value }).value
    }
  }
  return payload as Value | undefined
}

function normalizeTDesignProps(
  element: TDesignElement,
  props: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const change = props.onChange
  if (typeof change !== 'function') return props
  return {
    ...props,
    onChange: (payload: unknown, ...rest: readonly unknown[]) => {
      const value = unwrapTDesignChangeValue(payload)
      // TDesign Input is controlled whenever Host passes `value`: its native
      // input invokes this callback and then immediately re-renders from the
      // component props. Mirror the normalized value before returning so that
      // render cannot restore the previous field value while Manager records
      // the draft. Textarea emits the same value through CustomEvent.detail.
      if (Object.hasOwn(props, 'value')) {
        // `element.props.value = value` is insufficient for the real Omi
        // components: their visible Shadow DOM keeps a separate `innerValue`
        // that only advances during `receiveProps(next, previous)`. Preserve a
        // genuine old-props snapshot, then invoke that supported lifecycle
        // before mutating the live prop bag. This is the same seam Omi uses
        // when a parent re-renders a controlled custom element.
        const liveProps = element.props
        const previousProps = liveProps === undefined ? undefined : { ...liveProps }
        const nextProps = previousProps === undefined ? undefined : { ...previousProps, value }
        element.value = value
        if (nextProps !== undefined && previousProps !== undefined && liveProps !== undefined) {
          element.receiveProps?.(nextProps, previousProps)
          Object.assign(liveProps, nextProps)
          element.update?.()
        }
      }
      return (change as (value: unknown, ...args: readonly unknown[]) => unknown)(value, ...rest)
    },
  }
}

const HOST_TDESIGN_TOKENS = Object.freeze(
  {
    '--td-brand-color': 'var(--cx-primary)',
    '--td-brand-color-hover': 'color-mix(in srgb, var(--cx-primary) 88%, var(--cx-text))',
    '--td-brand-color-active': 'color-mix(in srgb, var(--cx-primary) 78%, var(--cx-text))',
    '--td-brand-color-disabled': 'color-mix(in srgb, var(--cx-primary) 45%, var(--cx-surface))',
    '--td-brand-color-light': 'color-mix(in srgb, var(--cx-primary) 12%, var(--cx-surface))',
    '--td-brand-color-light-hover': 'color-mix(in srgb, var(--cx-primary) 20%, var(--cx-surface))',
    '--td-brand-color-focus': 'color-mix(in srgb, var(--cx-focus) 26%, transparent)',
    '--td-text-color-primary': 'var(--cx-text)',
    '--td-text-color-secondary': 'var(--cx-muted)',
    '--td-text-color-placeholder': 'color-mix(in srgb, var(--cx-muted) 78%, transparent)',
    '--td-text-color-disabled': 'color-mix(in srgb, var(--cx-text) 68%, var(--cx-surface))',
    '--td-text-color-anti': 'var(--cx-primary-text)',
    '--td-bg-color-container': 'var(--cx-surface)',
    '--td-bg-color-container-hover': 'var(--cx-hover)',
    '--td-bg-color-container-active': 'var(--cx-pressed)',
    '--td-bg-color-container-select': 'var(--cx-pressed)',
    '--td-bg-color-secondarycontainer': 'var(--cx-surface-raised)',
    '--td-bg-color-secondarycontainer-hover': 'var(--cx-hover)',
    '--td-bg-color-secondarycontainer-active': 'var(--cx-pressed)',
    '--td-bg-color-component': 'var(--cx-surface-raised)',
    '--td-bg-color-specialcomponent': 'var(--cx-surface-raised)',
    '--td-bg-color-component-hover': 'var(--cx-hover)',
    '--td-bg-color-component-active': 'var(--cx-pressed)',
    '--td-bg-color-component-disabled': 'color-mix(in srgb, var(--cx-surface-raised) 70%, var(--cx-muted))',
    '--td-border-level-2-color': 'var(--cx-border)',
    '--td-error-color': 'var(--cx-danger)',
    '--td-warning-color': 'var(--cx-warning, var(--cx-primary))',
    '--td-success-color': 'var(--cx-success, var(--cx-primary))',
  } satisfies Readonly<Record<string, string>>,
)

function ensureInstalled(document: Document): void {
  if (installed || !canInstall(document)) return
  installTDesignWebComponents()
  installed = true
}

export function setTDesignProps(element: TDesignElement, props: Readonly<Record<string, unknown>>): void {
  const normalizedProps = normalizeTDesignProps(element, props)
  for (const [name, value] of Object.entries(normalizedProps)) {
    let owner: object | null = element
    let descriptor: PropertyDescriptor | undefined
    while (owner !== null && descriptor === undefined) {
      descriptor = Object.getOwnPropertyDescriptor(owner, name)
      owner = Object.getPrototypeOf(owner) as object | null
    }
    // Some official TDesign custom elements expose props such as `theme`
    // through getter-only accessors backed by `element.props`. Assigning the
    // public property throws in strict mode before the component can mount.
    // Skip only that direct write; the typed props/updateProps path below is
    // the component's supported mutation seam.
    if (descriptor?.set !== undefined || descriptor?.writable === true || descriptor === undefined) {
      element[name] = value
    }
  }
  // Omi custom elements read their initial props from attributes when they
  // connect. Host controls are configured before insertion, so a property-only
  // scalar may be replaced by the component default during its first render.
  // Reapply the typed props once it is connected: serializing a Boolean to an
  // attribute is not safe here because TDesign's `value` accepts String first,
  // which turns true into the literal string "true" and makes a switch appear
  // off. Placeholder is the sole user-facing scalar that must also be an
  // attribute for the component's first locale-sensitive paint.
  if (Object.hasOwn(normalizedProps, 'placeholder')) {
    const placeholder = normalizedProps.placeholder
    if (typeof placeholder === 'string') element.setAttribute('placeholder', placeholder)
    else element.removeAttribute('placeholder')
  }
  if (element.props !== undefined) Object.assign(element.props, normalizedProps)
  element.update?.()
  const restoreTypedProps = () => {
    if (!element.isConnected) return
    if (typeof element.updateProps === 'function') {
      element.updateProps(normalizedProps)
      return
    }
    if (element.props !== undefined) Object.assign(element.props, normalizedProps)
    element.update?.()
  }
  queueMicrotask(restoreTypedProps)
  // TDesign schedules its own first prop normalization in a microtask. Run one
  // bounded task after it so Boolean/number values stay typed on the visible
  // first frame instead of being reset to the component default.
  setTimeout(restoreTypedProps, 0)
}

/**
 * Omi may recreate its internal native input while upgrading a pre-connected
 * custom element. Listen inside the stable ShadowRoot so Host drafts still
 * receive real typing even when the library drops a pre-upgrade callback prop.
 */
export function bindTDesignTextInput(element: TDesignElement, onChange: (value: string) => void): () => void {
  let attached: ShadowRoot | undefined
  let disposed = false
  const receive = (event: Event): void => {
    const value = unwrapTDesignChangeValue<string>(event)
    if (typeof value !== 'string') return
    onChange(value)
    // The pinned Omi wrapper can re-render from its stale controlled prop at
    // the end of this same input dispatch. Restore only the live native value
    // in a microtask; never serialize drafts (especially credentials) into a
    // host attribute or DOM text.
    const target = event.target as HTMLInputElement | HTMLTextAreaElement | null
    queueMicrotask(() => {
      if (disposed) return
      if (target !== null && 'value' in target) target.value = value
      const current = element.shadowRoot?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')
      if (current !== null && current !== undefined) current.value = value
    })
  }
  const attach = (): void => {
    if (disposed || element.shadowRoot === null || element.shadowRoot === attached) return
    attached?.removeEventListener('input', receive, true)
    attached = element.shadowRoot
    attached.addEventListener('input', receive, true)
  }
  queueMicrotask(attach)
  if (typeof element.ownerDocument.defaultView?.requestAnimationFrame === 'function') {
    element.ownerDocument.defaultView.requestAnimationFrame(attach)
  }
  element.ownerDocument.defaultView?.setTimeout(attach, 0)
  return () => {
    disposed = true
    attached?.removeEventListener('input', receive, true)
  }
}

/**
 * TDesign 1.2 can drop the object-valued `autosize` prop while upgrading a
 * pre-connected textarea. Keep the real native textarea visibly multiline as
 * a bounded Host layout policy; typing still flows through the normal bridge.
 */
export function bindTDesignTextareaRows(element: TDesignElement, rows: number): () => void {
  let native: HTMLTextAreaElement | undefined
  let observer: MutationObserver | undefined
  let disposed = false
  const minimum = `${rows * 22 + 12}px`
  const apply = (): void => {
    if (disposed) return
    const next = element.shadowRoot?.querySelector<HTMLTextAreaElement>('textarea') ?? undefined
    if (next === undefined) return
    if (next !== native) {
      observer?.disconnect()
      native = next
      const view = element.ownerDocument.defaultView
      observer = view === null ? undefined : new view.MutationObserver(apply)
      observer?.observe(native, { attributes: true, attributeFilter: ['style', 'rows'] })
    }
    if (native.rows !== rows) native.rows = rows
    if (
      native.style.getPropertyValue('min-height') !== minimum
      || native.style.getPropertyPriority('min-height') !== 'important'
    ) {
      native.style.setProperty('min-height', minimum, 'important')
    }
  }
  queueMicrotask(apply)
  if (typeof element.ownerDocument.defaultView?.requestAnimationFrame === 'function') {
    element.ownerDocument.defaultView.requestAnimationFrame(apply)
  }
  element.ownerDocument.defaultView?.setTimeout(apply, 0)
  return () => {
    disposed = true
    observer?.disconnect()
    native = undefined
  }
}

export function createTDesignElement(document: Document, tag: string, primitive: string): TDesignElement {
  ensureInstalled(document)
  const element = document.createElement(tag) as TDesignElement
  element.dataset.tdesignComponent = tag.slice(2)
  element.dataset.tdesignVersion = TDESIGN_WEB_COMPONENTS_VERSION
  element.dataset.hostFormPrimitive = primitive
  element.classList.add('cxf-tdesign-control')
  // Official components render their visible chrome inside their own shadow
  // roots. Forward Host semantic variables on every custom-element host so a
  // live App-theme change reaches inline controls and portaled options alike.
  for (const [name, value] of Object.entries(HOST_TDESIGN_TOKENS)) element.style.setProperty(name, value)
  element.style.setProperty('color-scheme', 'inherit')
  return element
}

export function createTDesignPortal(document: Document, parent?: HTMLElement): HTMLElement {
  const owner = parent ?? document.body ?? document.documentElement
  const existing = [...owner.children].find(child => (
    child.nodeType === 1 && (child as HTMLElement).dataset.cxfTdesignPortalHost === 'true'
  )) as HTMLElement | undefined
  if (existing !== undefined) return existing
  const host = document.createElement('div')
  host.className = 'cxf-scope cxf-tdesign-portal-host'
  host.dataset.cxfTdesignPortalHost = 'true'
  host.dataset.tdesignVersion = TDESIGN_WEB_COMPONENTS_VERSION
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = `${TDESIGN_PORTAL_CSS}\n${HOST_ICON_16PX_CSS}\n
    :host { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; color: var(--cx-text); color-scheme: inherit; font: inherit; }
    .cxf-tdesign-portal { position: fixed; inset: 0; pointer-events: none; }
    .cxf-tdesign-portal > * { pointer-events: auto; }
    .cxf-tdesign-listbox {
      position: fixed; display: grid; box-sizing: border-box; max-block-size: min(18rem, calc(100vh - 1rem));
      overflow: auto; overscroll-behavior: contain; padding: .25rem; border: 1px solid var(--cx-border);
      border-radius: var(--td-radius-medium, .55rem); background: var(--td-bg-color-container, var(--cx-surface-raised));
      color: var(--td-text-color-primary, var(--cx-text)); box-shadow: var(--td-shadow-2, 0 10px 32px var(--cx-shadow));
      scrollbar-gutter: stable; outline: none;
    }
    .cxf-tdesign-listbox[hidden] { display: none; }
    .cxf-tdesign-listbox t-option { display: block; min-inline-size: 0; outline: none; }
    .cxf-tdesign-listbox t-option::part(t-select-option) {
      display: flex; align-items: center; box-sizing: border-box; min-block-size: 36px;
      border-radius: .35rem; outline: none;
    }
    .cxf-tdesign-listbox t-option[data-host-option-icon="true"]::part(t-select-option) {
      background-image: var(--cxf-option-icon-light); background-position: 10px center;
      background-repeat: no-repeat; background-size: var(--cxf-option-icon-size, 20px) var(--cxf-option-icon-size, 20px);
      padding-inline-start: 40px;
    }
    :host([data-cordisx-app-theme="dark"]) .cxf-tdesign-listbox t-option[data-host-option-icon="true"]::part(t-select-option),
    :host-context([data-cordisx-app-theme="dark"]) .cxf-tdesign-listbox t-option[data-host-option-icon="true"]::part(t-select-option) {
      background-image: var(--cxf-option-icon-dark, var(--cxf-option-icon-light));
    }
    .cxf-tdesign-listbox t-option[aria-selected="true"]::part(t-select-option) {
      background-color: var(--td-bg-color-container-select, var(--cx-pressed));
    }
    .cxf-tdesign-listbox t-option:not([aria-selected="true"]):hover::part(t-select-option) {
      background-color: var(--td-bg-color-container-hover, var(--cx-hover));
    }
    .cxf-tdesign-listbox t-option[data-active="true"]::part(t-select-option) {
      box-shadow: inset 0 0 0 1px var(--td-brand-color, var(--cx-primary));
    }
    .t-popup { z-index: 2147483001; }
    .t-popup__content { max-inline-size: min(28rem, calc(100vw - 1.5rem)); color: var(--cx-text); }
    .cxf-field-menu {
      position: fixed; display: grid; min-inline-size: 160px; max-inline-size: min(240px, calc(100vw - 32px));
      padding: 5px; border: 1px solid var(--cx-border); border-radius: 10px;
      background: var(--td-bg-color-container, var(--cx-surface-raised)); color: var(--td-text-color-primary, var(--cx-text));
      box-shadow: var(--td-shadow-2, 0 14px 44px var(--cx-shadow)); outline: none;
      font: 13px/1.45 ui-sans-serif, system-ui, sans-serif;
    }
    .cxf-field-menu[hidden] { display: none; }
    .cxf-field-menu-item {
      display: flex; align-items: center; gap: 9px; inline-size: 100%; box-sizing: border-box;
      border: 0; border-radius: 7px; padding: 8px 9px; background: transparent; color: inherit; font: inherit;
      text-align: start; cursor: pointer;
    }
    .cxf-field-menu-item:hover:not(:disabled), .cxf-field-menu-item:focus-visible { background: var(--td-bg-color-container-hover, var(--cx-hover)); outline: none; }
    .cxf-field-menu-item:active:not(:disabled) { background: var(--td-bg-color-container-active, var(--cx-pressed)); }
    .cxf-field-menu-item:focus-visible { box-shadow: 0 0 0 2px var(--cx-focus); }
    .cxf-field-menu-item:disabled { color: var(--td-text-color-disabled, var(--cx-muted)); cursor: default; }
    .cxf-field-menu-item > .cordisx-host-icon { flex: 0 0 16px; }
    .cxf-field-menu-status { padding: .25rem .5rem; color: var(--td-text-color-secondary, var(--cx-muted)); font-size: .78rem; }
    .cxf-array-editor-dialog {
      position: fixed; inset: max(1rem, 10vh) max(1rem, calc((100vw - 42rem) / 2)) auto;
      display: grid; gap: .85rem; max-block-size: min(80vh, calc(100vh - 2rem)); overflow: auto;
      padding: 1rem; border: 1px solid var(--cx-border); border-radius: .8rem;
      background: var(--td-bg-color-container, var(--cx-surface)); color: var(--td-text-color-primary, var(--cx-text));
      box-shadow: var(--td-shadow-3, 0 14px 44px var(--cx-shadow)); outline: none;
    }
    .cxf-array-editor-dialog-head { display: flex; align-items: center; justify-content: space-between; gap: .75rem; }
    .cxf-array-editor-dialog-fields { display: grid; gap: .8rem; }
    .cxf-array-editor-dialog-field { display: grid; gap: .3rem; min-inline-size: 0; }
    .cxf-array-editor-dialog-field > label { color: var(--td-text-color-primary, var(--cx-text)); font-weight: 600; }
    .cxf-array-editor-dialog-field > .cxf-tdesign-control,
    .cxf-array-editor-dialog-field > .cxf-color-control,
    .cxf-array-editor-dialog-field > .cxf-slider-control { inline-size: 100%; min-inline-size: 0; }
  `
  const container = document.createElement('div')
  container.className = 'cxf-tdesign-portal'
  container.dataset.cxfTdesignPortal = 'true'
  shadow.append(style, container)
  owner.append(host)
  return host
}

export function tdesignPortalContainer(host: HTMLElement): HTMLElement {
  return host.shadowRoot!.querySelector<HTMLElement>('[data-cxf-tdesign-portal]')!
}
