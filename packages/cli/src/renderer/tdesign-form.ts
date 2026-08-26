import {
  installTDesignWebComponents,
  TDESIGN_PORTAL_CSS,
  TDESIGN_SCOPED_TOKEN_CSS,
  TDESIGN_WEB_COMPONENTS_VERSION,
} from './vendor/tdesign-web-components-1.2.10.js'
import { HOST_ICON_16PX_CSS } from './icons.js'

export { TDESIGN_SCOPED_TOKEN_CSS, TDESIGN_WEB_COMPONENTS_VERSION }

export interface TDesignElement extends HTMLElement {
  disabled?: boolean
  readonly?: boolean
  value?: unknown
  checked?: boolean
  update?: () => void
  updateProps?: (props: Readonly<Record<string, unknown>>) => void
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

function normalizeTDesignProps(props: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const change = props.onChange
  if (typeof change !== 'function') return props
  return {
    ...props,
    onChange: (payload: unknown, ...rest: readonly unknown[]) => (change as (value: unknown, ...args: readonly unknown[]) => unknown)(unwrapTDesignChangeValue(payload), ...rest),
  }
}

const HOST_TDESIGN_TOKENS = Object.freeze({
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
} satisfies Readonly<Record<string, string>>)

function ensureInstalled(document: Document): void {
  if (installed || !canInstall(document)) return
  installTDesignWebComponents()
  installed = true
}

export function setTDesignProps(element: TDesignElement, props: Readonly<Record<string, unknown>>): void {
  const normalizedProps = normalizeTDesignProps(props)
  for (const [name, value] of Object.entries(normalizedProps)) element[name] = value
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
    .cxf-tdesign-listbox t-option { display: block; min-inline-size: 0; }
    .cxf-tdesign-listbox t-option[data-active="true"] { outline: 2px solid var(--cx-focus); outline-offset: -2px; border-radius: .35rem; }
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

function deepElements(root: Document | ShadowRoot | Element, selector: string): HTMLElement[] {
  const found: HTMLElement[] = []
  for (const element of root.querySelectorAll<HTMLElement>(selector)) found.push(element)
  for (const element of root.querySelectorAll<HTMLElement>('*')) {
    if (element.shadowRoot !== null) found.push(...deepElements(element.shadowRoot, selector))
  }
  return found
}

function scheduleAccessibilityPatch(document: Document, callback: () => void): void {
  callback()
  document.defaultView?.queueMicrotask(callback)
  if (typeof document.defaultView?.requestAnimationFrame === 'function') {
    document.defaultView.requestAnimationFrame(callback)
  }
}

export function createTDesignSelect<Value>(
  document: Document,
  portalHost: HTMLElement,
  options: readonly TDesignSelectOption<Value>[],
  config: {
    readonly id?: string
    readonly label: string
    readonly placeholder?: string
    readonly value?: Value
    readonly disabled?: boolean
    readonly readonly?: boolean
    readonly clearable?: boolean
    readonly onChange: (value: Value | undefined) => void
  },
): TDesignSelectElement<Value> {
  const element = createTDesignElement(document, 't-select', 'select') as TDesignSelectElement<Value>
  let selected = config.value
  let expanded = false
  let active = Math.max(0, options.findIndex(option => Object.is(option.value, selected)))
  let typeahead = ''
  let typeaheadTimer: number | undefined
  const listboxId = `${config.id ?? `cxf-select-${Math.random().toString(36).slice(2)}`}-listbox`
  const portal = tdesignPortalContainer(portalHost)
  const listbox = document.createElement('div')
  listbox.className = 'cxf-tdesign-listbox'
  listbox.id = listboxId
  listbox.hidden = true
  listbox.setAttribute('role', 'listbox')
  listbox.setAttribute('aria-label', config.label)
  listbox.dataset.tdesignSelectPopup = 'true'
  portal.append(listbox)
  element.id = config.id ?? ''
  element.setAttribute('role', 'combobox')
  element.setAttribute('aria-label', config.label)
  element.setAttribute('aria-haspopup', 'listbox')
  element.setAttribute('aria-controls', listboxId)
  element.setAttribute('aria-expanded', 'false')
  element.tabIndex = config.disabled || config.readonly ? -1 : 0

  const patchAccessibility = (): void => {
    element.setAttribute('aria-expanded', String(expanded))
    element.setAttribute('aria-disabled', String(config.disabled === true))
    if (config.readonly) element.setAttribute('aria-readonly', 'true')
    const internalInputs = element.shadowRoot === null ? [] : deepElements(element.shadowRoot, 'input')
    for (const input of internalInputs) {
      input.setAttribute('aria-hidden', 'true')
      input.tabIndex = -1
    }
    const renderedOptions = [...listbox.querySelectorAll<HTMLElement>('t-option')]
    renderedOptions.forEach((option, index) => {
      option.id = `${listboxId}-option-${index}`
      option.setAttribute('role', 'option')
      option.setAttribute('aria-selected', String(Object.is(options[index]?.value, selected)))
      option.setAttribute('aria-disabled', String(options[index]?.disabled === true))
    })
    listbox.setAttribute('aria-busy', String(element.getAttribute('aria-busy') === 'true'))
    if (expanded && renderedOptions[active] !== undefined) element.setAttribute('aria-activedescendant', renderedOptions[active]!.id)
    else element.removeAttribute('aria-activedescendant')
  }

  const positionListbox = (): void => {
    if (!expanded || !element.isConnected) return
    const rect = element.getBoundingClientRect()
    const view = document.defaultView
    if (view === null || rect.width === 0 || rect.height === 0) return
    const gutter = 8
    const below = view.innerHeight - rect.bottom - gutter
    const above = rect.top - gutter
    const openAbove = below < Math.min(240, listbox.scrollHeight) && above > below
    const width = Math.min(Math.max(rect.width, 176), view.innerWidth - gutter * 2)
    const left = Math.min(Math.max(gutter, rect.left), Math.max(gutter, view.innerWidth - width - gutter))
    listbox.style.inlineSize = `${width}px`
    listbox.style.maxBlockSize = `${Math.max(96, Math.min(288, (openAbove ? above : below) - gutter))}px`
    listbox.style.insetInlineStart = `${left}px`
    listbox.style.insetBlockStart = openAbove
      ? `${Math.max(gutter, rect.top - Math.min(listbox.scrollHeight, Math.max(96, above - gutter)) - 4)}px`
      : `${Math.min(view.innerHeight - gutter, rect.bottom + 4)}px`
    listbox.dataset.placement = openAbove ? 'top' : 'bottom'
  }

  const choose = (index: number): void => {
    if (!enabledAt(index)) return
    selected = options[index]!.value
    active = index
    expanded = false
    config.onChange(selected)
    update()
    element.focus()
  }

  options.forEach((option, index) => {
    const rendered = createTDesignElement(document, 't-option', 'option')
    rendered.id = `${listboxId}-option-${index}`
    rendered.setAttribute('role', 'option')
    rendered.tabIndex = -1
    rendered.textContent = option.label
    setTDesignProps(rendered, {
      label: option.label,
      content: option.label,
      value: String(index),
      disabled: option.disabled === true,
      selected: Object.is(option.value, selected),
    })
    rendered.addEventListener('click', event => {
      event.preventDefault()
      choose(index)
    })
    listbox.append(rendered)
  })

  const update = (): void => {
    setTDesignProps(element, {
      options: options.map(option => ({ label: option.label, value: option.value, disabled: option.disabled === true })),
      value: selected,
      placeholder: config.placeholder,
      disabled: config.disabled === true,
      clearable: config.clearable === true,
      // TDesign owns the control and every option. The Host owns popup policy and
      // mounts the official options in its isolated portal so it can guarantee
      // app-theme projection, edge avoidance, focus restoration and generation cleanup.
      popupVisible: false,
      popupProps: {
        attach: () => tdesignPortalContainer(portalHost),
        placement: 'bottom-left',
        destroyOnClose: true,
      },
      onChange: (value: Value | undefined) => {
        selected = value
        expanded = false
        config.onChange(value)
        update()
      },
      onClear: () => {
        selected = undefined
        expanded = false
        config.onChange(undefined)
        update()
      },
      onPopupVisibleChange: (visible: boolean) => {
        if (config.readonly || config.disabled) return
        // The official component asks to open its popup on pointer activation.
        // Its popup stays disabled because the Host portal owns policy; false is
        // therefore an implementation echo, not a request to close the Host list.
        if (!visible) return
        // The official control can report the same open request after the
        // Host keyboard handler has already opened the isolated popup. Keep
        // this callback idempotent so ArrowDown cannot immediately close it.
        expanded = true
        update()
      },
    })
    element.dataset.selectedValue = selected === undefined ? '' : JSON.stringify(selected)
    element.dataset.popupVisible = String(expanded)
    listbox.hidden = !expanded
    ;[...listbox.querySelectorAll<TDesignElement>('t-option')].forEach((option, index) => {
      const isSelected = Object.is(options[index]?.value, selected)
      option.dataset.active = String(index === active)
      option.setAttribute('aria-selected', String(isSelected))
      setTDesignProps(option, { selected: isSelected })
    })
    if (expanded) {
      document.defaultView?.requestAnimationFrame(() => {
        positionListbox()
        listbox.querySelector<HTMLElement>('t-option[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' })
      })
    }
    scheduleAccessibilityPatch(document, patchAccessibility)
  }

  const enabledAt = (index: number): boolean => options[index] !== undefined && options[index]?.disabled !== true
  const seek = (start: number, direction: 1 | -1): number => {
    for (let offset = 0; offset < options.length; offset += 1) {
      const index = (start + direction * offset + options.length) % options.length
      if (enabledAt(index)) return index
    }
    return active
  }
  let disposed = false
  let observer: MutationObserver | undefined
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    document.removeEventListener('pointerdown', closeFromOutside, true)
    document.defaultView?.removeEventListener('resize', positionListbox)
    document.defaultView?.removeEventListener('scroll', positionListbox, true)
    if (typeaheadTimer !== undefined) document.defaultView?.clearTimeout(typeaheadTimer)
    listbox.remove()
    observer?.disconnect()
  }
  const closeFromOutside = (event: Event): void => {
    if (!element.isConnected) {
      dispose()
      return
    }
    if (!expanded) return
    const path = event.composedPath()
    if (path.includes(element) || path.includes(listbox)) return
    expanded = false
    update()
  }
  document.addEventListener('pointerdown', closeFromOutside, true)
  document.defaultView?.addEventListener('resize', positionListbox)
  document.defaultView?.addEventListener('scroll', positionListbox, true)
  let connectedOnce = false
  observer = document.defaultView === null ? undefined : new document.defaultView.MutationObserver(() => {
    if (element.isConnected) {
      connectedOnce = true
      return
    }
    if (!connectedOnce) return
    dispose()
  })
  observer?.observe(document.documentElement, { childList: true, subtree: true })
  document.defaultView?.queueMicrotask(() => { if (element.isConnected) connectedOnce = true })
  const abandonIfNeverMounted = (): void => {
    if (!element.isConnected && !connectedOnce) dispose()
  }
  if (typeof document.defaultView?.requestAnimationFrame === 'function') {
    document.defaultView.requestAnimationFrame(abandonIfNeverMounted)
  } else {
    document.defaultView?.setTimeout(abandonIfNeverMounted, 0)
  }
  element.addEventListener('keydown', event => {
    if (config.disabled || config.readonly) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      expanded = true
      active = seek(active + (event.key === 'ArrowDown' ? 1 : -1), event.key === 'ArrowDown' ? 1 : -1)
      update()
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      expanded = true
      active = seek(event.key === 'Home' ? 0 : options.length - 1, event.key === 'Home' ? 1 : -1)
      update()
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (!expanded) {
        expanded = true
        update()
      } else if (enabledAt(active)) {
        choose(active)
      }
      return
    }
    if (event.key === 'Escape' && expanded) {
      event.preventDefault()
      event.stopPropagation()
      expanded = false
      update()
      element.focus()
      return
    }
    if ((event.key === 'Backspace' || event.key === 'Delete') && config.clearable && selected !== undefined) {
      event.preventDefault()
      selected = undefined
      config.onChange(undefined)
      update()
      return
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      typeahead += event.key.toLocaleLowerCase()
      if (typeaheadTimer !== undefined) document.defaultView?.clearTimeout(typeaheadTimer)
      typeaheadTimer = document.defaultView?.setTimeout(() => { typeahead = '' }, 650)
      const match = options.findIndex(option => !option.disabled && option.label.toLocaleLowerCase().startsWith(typeahead))
      if (match >= 0) {
        event.preventDefault()
        expanded = true
        active = match
        update()
      }
    }
  })
  Object.defineProperty(element, 'selectedValue', { get: () => selected })
  element.setSelectedValue = (value: Value | undefined, notify = false): void => {
    selected = value
    if (notify) config.onChange(value)
    update()
  }
  element.setBusy = (busy: boolean): void => {
    setTDesignProps(element, { disabled: busy || config.disabled === true, loading: busy })
    element.setAttribute('aria-busy', String(busy))
  }
  element.dispose = dispose
  update()
  return element
}

/**
 * Host-owned multi-select policy around the official TDesign Select and Option
 * elements. TDesign owns the visible input/tag chrome; the Host owns its
 * portal, focus restoration, generation cleanup, and accessible listbox.
 */
export function createTDesignMultiSelect<Value>(
  document: Document,
  portalHost: HTMLElement,
  options: readonly TDesignSelectOption<Value>[],
  config: {
    readonly id?: string
    readonly label: string
    readonly placeholder?: string
    readonly value?: readonly Value[]
    readonly disabled?: boolean
    readonly readonly?: boolean
    readonly clearable?: boolean
    readonly onChange: (value: readonly Value[]) => void
  },
): TDesignMultiSelectElement<Value> {
  const element = createTDesignElement(document, 't-select', 'multi-select') as TDesignMultiSelectElement<Value>
  let selected = [...(config.value ?? [])]
  let expanded = false
  let active = Math.max(0, options.findIndex(option => selected.some(value => Object.is(value, option.value))))
  let typeahead = ''
  let typeaheadTimer: number | undefined
  const listboxId = `${config.id ?? `cxf-multi-select-${Math.random().toString(36).slice(2)}`}-listbox`
  const portal = tdesignPortalContainer(portalHost)
  const listbox = document.createElement('div')
  listbox.className = 'cxf-tdesign-listbox'
  listbox.id = listboxId
  listbox.hidden = true
  listbox.setAttribute('role', 'listbox')
  listbox.setAttribute('aria-label', config.label)
  listbox.setAttribute('aria-multiselectable', 'true')
  listbox.dataset.tdesignSelectPopup = 'true'
  portal.append(listbox)
  element.id = config.id ?? ''
  element.setAttribute('role', 'combobox')
  element.setAttribute('aria-label', config.label)
  element.setAttribute('aria-haspopup', 'listbox')
  element.setAttribute('aria-controls', listboxId)
  element.tabIndex = config.disabled || config.readonly ? -1 : 0

  const selectedAt = (index: number): boolean => selected.some(value => Object.is(value, options[index]?.value))
  const enabledAt = (index: number): boolean => options[index] !== undefined && options[index]?.disabled !== true
  const seek = (start: number, direction: 1 | -1): number => {
    for (let offset = 0; offset < options.length; offset += 1) {
      const index = (start + direction * offset + options.length) % options.length
      if (enabledAt(index)) return index
    }
    return active
  }
  const positionListbox = (): void => {
    if (!expanded || !element.isConnected) return
    const rect = element.getBoundingClientRect()
    const view = document.defaultView
    if (view === null || rect.width === 0 || rect.height === 0) return
    const gutter = 8
    const below = view.innerHeight - rect.bottom - gutter
    const above = rect.top - gutter
    const openAbove = below < Math.min(240, listbox.scrollHeight) && above > below
    const width = Math.min(Math.max(rect.width, 176), view.innerWidth - gutter * 2)
    listbox.style.inlineSize = `${width}px`
    listbox.style.maxBlockSize = `${Math.max(96, Math.min(288, (openAbove ? above : below) - gutter))}px`
    listbox.style.insetInlineStart = `${Math.min(Math.max(gutter, rect.left), Math.max(gutter, view.innerWidth - width - gutter))}px`
    listbox.style.insetBlockStart = openAbove
      ? `${Math.max(gutter, rect.top - Math.min(listbox.scrollHeight, Math.max(96, above - gutter)) - 4)}px`
      : `${Math.min(view.innerHeight - gutter, rect.bottom + 4)}px`
    listbox.dataset.placement = openAbove ? 'top' : 'bottom'
  }
  const patchAccessibility = (): void => {
    element.setAttribute('aria-expanded', String(expanded))
    element.setAttribute('aria-disabled', String(config.disabled === true))
    if (config.readonly) element.setAttribute('aria-readonly', 'true')
    for (const input of element.shadowRoot === null ? [] : deepElements(element.shadowRoot, 'input')) {
      input.setAttribute('aria-hidden', 'true')
      input.tabIndex = -1
    }
    const rendered = [...listbox.querySelectorAll<HTMLElement>('t-option')]
    rendered.forEach((option, index) => {
      option.id = `${listboxId}-option-${index}`
      option.setAttribute('role', 'option')
      option.setAttribute('aria-selected', String(selectedAt(index)))
      option.setAttribute('aria-disabled', String(options[index]?.disabled === true))
    })
    if (expanded && rendered[active] !== undefined) element.setAttribute('aria-activedescendant', rendered[active]!.id)
    else element.removeAttribute('aria-activedescendant')
  }
  const update = (): void => {
    setTDesignProps(element, {
      options: options.map(option => ({ label: option.label, value: option.value, disabled: option.disabled === true })),
      value: selected,
      multiple: true,
      placeholder: config.placeholder,
      disabled: config.disabled === true,
      clearable: config.clearable === true,
      popupVisible: false,
      popupProps: { attach: () => tdesignPortalContainer(portalHost), placement: 'bottom-left', destroyOnClose: true },
      onChange: (next: readonly Value[]) => {
        selected = [...next]
        config.onChange(selected)
        update()
      },
      onClear: () => { selected = []; config.onChange(selected); update() },
      onPopupVisibleChange: (visible: boolean) => {
        if (!config.readonly && !config.disabled && visible) { expanded = true; update() }
      },
    })
    element.dataset.selectedValues = JSON.stringify(selected)
    element.dataset.popupVisible = String(expanded)
    listbox.hidden = !expanded
    ;[...listbox.querySelectorAll<TDesignElement>('t-option')].forEach((option, index) => {
      const isSelected = selectedAt(index)
      option.dataset.active = String(index === active)
      option.setAttribute('aria-selected', String(isSelected))
      setTDesignProps(option, { selected: isSelected, multiple: true })
    })
    if (expanded) document.defaultView?.requestAnimationFrame(() => {
      positionListbox()
      listbox.querySelector<HTMLElement>('t-option[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' })
    })
    scheduleAccessibilityPatch(document, patchAccessibility)
  }
  const choose = (index: number): void => {
    if (!enabledAt(index)) return
    const value = options[index]!.value
    selected = selectedAt(index) ? selected.filter(item => !Object.is(item, value)) : [...selected, value]
    active = index
    config.onChange(selected)
    update()
  }
  options.forEach((option, index) => {
    const rendered = createTDesignElement(document, 't-option', 'option')
    rendered.id = `${listboxId}-option-${index}`
    rendered.setAttribute('role', 'option')
    rendered.tabIndex = -1
    rendered.textContent = option.label
    setTDesignProps(rendered, { label: option.label, content: option.label, value: String(index), disabled: option.disabled === true, selected: selectedAt(index), multiple: true })
    rendered.addEventListener('click', event => { event.preventDefault(); choose(index) })
    listbox.append(rendered)
  })
  let disposed = false
  let observer: MutationObserver | undefined
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    document.removeEventListener('pointerdown', closeFromOutside, true)
    document.defaultView?.removeEventListener('resize', positionListbox)
    document.defaultView?.removeEventListener('scroll', positionListbox, true)
    if (typeaheadTimer !== undefined) document.defaultView?.clearTimeout(typeaheadTimer)
    observer?.disconnect()
    listbox.remove()
  }
  const closeFromOutside = (event: Event): void => {
    if (!element.isConnected) { dispose(); return }
    if (!expanded) return
    const path = event.composedPath()
    if (path.includes(element) || path.includes(listbox)) return
    expanded = false
    update()
  }
  document.addEventListener('pointerdown', closeFromOutside, true)
  document.defaultView?.addEventListener('resize', positionListbox)
  document.defaultView?.addEventListener('scroll', positionListbox, true)
  let connectedOnce = false
  observer = document.defaultView === null ? undefined : new document.defaultView.MutationObserver(() => {
    if (element.isConnected) { connectedOnce = true; return }
    if (connectedOnce) dispose()
  })
  observer?.observe(document.documentElement, { childList: true, subtree: true })
  const abandon = (): void => { if (!element.isConnected && !connectedOnce) dispose() }
  if (typeof document.defaultView?.requestAnimationFrame === 'function') document.defaultView.requestAnimationFrame(abandon)
  else document.defaultView?.setTimeout(abandon, 0)
  element.addEventListener('keydown', event => {
    if (config.disabled || config.readonly) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); expanded = true
      active = seek(active + (event.key === 'ArrowDown' ? 1 : -1), event.key === 'ArrowDown' ? 1 : -1); update(); return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); expanded = true
      active = seek(event.key === 'Home' ? 0 : options.length - 1, event.key === 'Home' ? 1 : -1); update(); return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); if (!expanded) { expanded = true; update() } else choose(active); return
    }
    if (event.key === 'Escape' && expanded) { event.preventDefault(); expanded = false; update(); element.focus(); return }
    if ((event.key === 'Backspace' || event.key === 'Delete') && config.clearable && selected.length > 0) {
      event.preventDefault(); selected = []; config.onChange(selected); update(); return
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      typeahead += event.key.toLocaleLowerCase()
      if (typeaheadTimer !== undefined) document.defaultView?.clearTimeout(typeaheadTimer)
      typeaheadTimer = document.defaultView?.setTimeout(() => { typeahead = '' }, 650)
      const match = options.findIndex(option => !option.disabled && option.label.toLocaleLowerCase().startsWith(typeahead))
      if (match >= 0) { event.preventDefault(); expanded = true; active = match; update() }
    }
  })
  Object.defineProperty(element, 'selectedValues', { get: () => selected })
  element.setSelectedValues = (value: readonly Value[], notify = false): void => { selected = [...value]; if (notify) config.onChange(selected); update() }
  element.setBusy = (busy: boolean): void => { setTDesignProps(element, { disabled: busy || config.disabled === true, loading: busy }); element.setAttribute('aria-busy', String(busy)) }
  element.dispose = dispose
  update()
  return element
}

/** Official TDesign TagInput for finite primitive arrays; no ad-hoc chip DOM. */
export function createTDesignTagInput<Value extends string | number>(
  document: Document,
  config: {
    readonly id?: string
    readonly label: string
    readonly placeholder?: string
    readonly value?: readonly Value[]
    readonly max?: number
    readonly disabled?: boolean
    readonly readonly?: boolean
    readonly onChange: (value: readonly Value[]) => void
  },
): TDesignTagInputElement<Value> {
  const element = createTDesignElement(document, 't-tag-input', 'tag-input') as TDesignTagInputElement<Value>
  let values = [...(config.value ?? [])]
  element.id = config.id ?? ''
  element.setAttribute('role', 'group')
  element.setAttribute('aria-label', config.label)
  element.tabIndex = config.disabled || config.readonly ? -1 : 0
  const update = (): void => {
    setTDesignProps(element, {
      value: values,
      defaultValue: values,
      max: config.max,
      placeholder: config.placeholder,
      disabled: config.disabled === true,
      readonly: config.readonly === true,
      onChange: (next: readonly Value[]) => {
        values = config.max === undefined ? [...next] : [...next].slice(0, config.max)
        config.onChange(values)
        update()
      },
    })
    element.dataset.tagValues = JSON.stringify(values)
  }
  Object.defineProperty(element, 'values', { get: () => values })
  element.setValues = (value: readonly Value[], notify = false): void => { values = [...value]; if (notify) config.onChange(values); update() }
  update()
  return element
}

export function createTDesignButton(
  document: Document,
  label: string,
  options: TDesignButtonOptions = {},
): TDesignButtonElement {
  const element = createTDesignElement(document, 't-button', 'button') as TDesignButtonElement
  element.type = options.type ?? 'button'
  element.setAttribute('type', element.type)
  element.disabled = false
  element.tabIndex = 0
  const iconOnly = options.density === 'icon'
  element.textContent = iconOnly ? '' : label
  element.setAttribute('aria-label', label)
  element.setAttribute('title', label)
  const buttonProps = {
    content: iconOnly ? '' : label,
    theme: options.tone === 'danger' ? 'danger' : options.variant === 'primary' ? 'primary' : 'default',
    variant: options.variant === 'primary' ? 'base' : options.variant === 'text' ? 'text' : 'outline',
    size: iconOnly ? 'small' : 'medium',
    shape: iconOnly ? 'square' : 'rectangle',
    type: element.type,
  }
  // TDesign's Omi component normalizes its initial button props from
  // attributes. Unlike input values these are finite string enums, so reflect
  // them before connection as well as through the typed Host adapter. Without
  // this, an icon action can fall back to the library's primary/base default
  // and render a bright, padded rectangle in dark mode.
  for (const [name, value] of Object.entries(buttonProps)) {
    if (name !== 'content') element.setAttribute(name, String(value))
  }
  setTDesignProps(element, buttonProps)
  if (element.type === 'submit') element.addEventListener('click', event => {
    event.preventDefault()
    element.closest('form')?.requestSubmit()
  })
  return element
}

export function setTDesignDisabled(element: TDesignElement, disabled: boolean): void {
  setTDesignProps(element, { disabled })
  element.setAttribute('aria-disabled', String(disabled))
}

export function setTDesignText(element: TDesignElement, text: string): void {
  element.textContent = text
  setTDesignProps(element, { content: text })
}
