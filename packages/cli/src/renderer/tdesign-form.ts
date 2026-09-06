import {
  createTDesignElement,
  setTDesignProps,
  TDesignButtonElement,
  TDesignButtonOptions,
  TDesignElement,
  TDesignMultiSelectElement,
  tdesignPortalContainer,
  TDesignSelectElement,
  TDesignSelectOption,
  TDesignTagInputElement,
} from './tdesign-form-elements.js'
export * from './tdesign-form-elements.js'
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
  // The pinned Omi components restore typed props in a zero-delay task after
  // their first controlled update. Project Host-owned labels once more after
  // that task so the visible SelectInput cannot fall back to its prior label.
  document.defaultView?.setTimeout(callback, 0)
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
    if (expanded && renderedOptions[active] !== undefined) {
      element.setAttribute('aria-activedescendant', renderedOptions[active]!.id)
    } else element.removeAttribute('aria-activedescendant')
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
    if (option.iconUri !== undefined) {
      rendered.dataset.hostOptionIcon = 'true'
      rendered.style.setProperty('--cxf-option-icon-light', `url("${option.iconUri}")`)
      rendered.style.setProperty('--cxf-option-icon-dark', `url("${option.darkIconUri ?? option.iconUri}")`)
      rendered.style.setProperty('--cxf-option-icon-size', `${option.iconSize ?? 20}px`)
    }
    setTDesignProps(rendered, {
      label: option.label,
      content: option.label,
      value: String(index),
      disabled: option.disabled === true,
      selected: Object.is(option.value, selected),
    })
    rendered.addEventListener('pointerdown', event => {
      event.preventDefault()
      event.stopPropagation()
      choose(index)
    })
    rendered.addEventListener('click', event => {
      event.preventDefault()
      // Pointer selection commits before a nested TDesign option can consume
      // the later click. Keep click for keyboard/programmatic activation.
      if (!Object.is(options[index]?.value, selected)) choose(index)
    })
    listbox.append(rendered)
  })

  const projectSelectedOptionIcon = (): void => {
    const option = options.find(candidate => Object.is(candidate.value, selected))
    const input = element.shadowRoot === null
      ? undefined
      : deepElements(element.shadowRoot, 'input')[0] as HTMLInputElement | undefined
    // The pinned Select updates its selected value but can retain the previous
    // SelectInput display string after a Host-controlled option change. Keep
    // the visible label projected from the same selected option as the icon.
    if (input !== undefined) input.value = option?.label ?? ''
    if (option?.iconUri === undefined) {
      delete element.dataset.hostSelectedOptionIcon
      element.style.removeProperty('--cxf-select-value-icon-light')
      element.style.removeProperty('--cxf-select-value-icon-dark')
      element.style.removeProperty('--cxf-select-value-icon-size')
      input?.style.removeProperty('background-image')
      input?.style.removeProperty('background-position')
      input?.style.removeProperty('background-repeat')
      input?.style.removeProperty('background-size')
      input?.style.removeProperty('padding-inline-start')
      return
    }
    element.dataset.hostSelectedOptionIcon = 'true'
    element.style.setProperty('--cxf-select-value-icon-light', `url("${option.iconUri}")`)
    element.style.setProperty('--cxf-select-value-icon-dark', `url("${option.darkIconUri ?? option.iconUri}")`)
    element.style.setProperty('--cxf-select-value-icon-size', `${option.iconSize ?? 20}px`)
    if (input === undefined) return
    input.style.setProperty(
      'background-image',
      'var(--cxf-select-value-icon-current, var(--cxf-select-value-icon-light))',
    )
    input.style.setProperty('background-position', 'left center')
    input.style.setProperty('background-repeat', 'no-repeat')
    input.style.setProperty('background-size', 'var(--cxf-select-value-icon-size) var(--cxf-select-value-icon-size)')
    input.style.setProperty('padding-inline-start', 'calc(var(--cxf-select-value-icon-size) + 8px)')
  }

  const constrainSelectInputWidth = (): void => {
    // TDesign renders this nested host as inline-block. Its shrink-to-fit width
    // follows the selected label, so it can become wider than the outer
    // t-select even when the public control is width: 100%. Constrain the
    // official nested host at the shared adapter boundary; otherwise every
    // narrow form column leaks a few pixels into its grid gap.
    const selectInput = element.shadowRoot?.querySelector<HTMLElement>('t-select-input')
    if (selectInput === null || selectInput === undefined) return
    selectInput.style.setProperty('display', 'block')
    selectInput.style.setProperty('box-sizing', 'border-box')
    selectInput.style.setProperty('inline-size', '100%')
    selectInput.style.setProperty('min-inline-size', '0')
    selectInput.style.setProperty('max-inline-size', '100%')
  }

  const update = (): void => {
    setTDesignProps(element, {
      options: options.map(option => ({
        label: option.label,
        value: option.value,
        disabled: option.disabled === true,
      })),
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
    if (expanded && typeof document.defaultView?.requestAnimationFrame === 'function') {
      document.defaultView.requestAnimationFrame(() => {
        positionListbox()
        listbox.querySelector<HTMLElement>('t-option[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' })
      })
    }
    scheduleAccessibilityPatch(document, constrainSelectInputWidth)
    scheduleAccessibilityPatch(document, projectSelectedOptionIcon)
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
  element.addEventListener('click', () => {
    if (config.disabled || config.readonly || expanded) return
    expanded = true
    update()
  })
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
  document.defaultView?.queueMicrotask(() => {
    if (element.isConnected) connectedOnce = true
  })
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
      typeaheadTimer = document.defaultView?.setTimeout(() => {
        typeahead = ''
      }, 650)
      const match = options.findIndex(option =>
        !option.disabled && option.label.toLocaleLowerCase().startsWith(typeahead)
      )
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
    listbox.style.insetInlineStart = `${
      Math.min(Math.max(gutter, rect.left), Math.max(gutter, view.innerWidth - width - gutter))
    }px`
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
      options: options.map(option => ({
        label: option.label,
        value: option.value,
        disabled: option.disabled === true,
      })),
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
      onClear: () => {
        selected = []
        config.onChange(selected)
        update()
      },
      onPopupVisibleChange: (visible: boolean) => {
        if (!config.readonly && !config.disabled && visible) {
          expanded = true
          update()
        }
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
    if (expanded) {
      document.defaultView?.requestAnimationFrame(() => {
        positionListbox()
        listbox.querySelector<HTMLElement>('t-option[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' })
      })
    }
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
    setTDesignProps(rendered, {
      label: option.label,
      content: option.label,
      value: String(index),
      disabled: option.disabled === true,
      selected: selectedAt(index),
      multiple: true,
    })
    rendered.addEventListener('click', event => {
      event.preventDefault()
      choose(index)
    })
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
    if (connectedOnce) dispose()
  })
  observer?.observe(document.documentElement, { childList: true, subtree: true })
  const abandon = (): void => {
    if (!element.isConnected && !connectedOnce) dispose()
  }
  if (typeof document.defaultView?.requestAnimationFrame === 'function') {
    document.defaultView.requestAnimationFrame(abandon)
  } else document.defaultView?.setTimeout(abandon, 0)
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
      } else choose(active)
      return
    }
    if (event.key === 'Escape' && expanded) {
      event.preventDefault()
      expanded = false
      update()
      element.focus()
      return
    }
    if ((event.key === 'Backspace' || event.key === 'Delete') && config.clearable && selected.length > 0) {
      event.preventDefault()
      selected = []
      config.onChange(selected)
      update()
      return
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      typeahead += event.key.toLocaleLowerCase()
      if (typeaheadTimer !== undefined) document.defaultView?.clearTimeout(typeaheadTimer)
      typeaheadTimer = document.defaultView?.setTimeout(() => {
        typeahead = ''
      }, 650)
      const match = options.findIndex(option =>
        !option.disabled && option.label.toLocaleLowerCase().startsWith(typeahead)
      )
      if (match >= 0) {
        event.preventDefault()
        expanded = true
        active = match
        update()
      }
    }
  })
  Object.defineProperty(element, 'selectedValues', { get: () => selected })
  element.setSelectedValues = (value: readonly Value[], notify = false): void => {
    selected = [...value]
    if (notify) config.onChange(selected)
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
  element.setValues = (value: readonly Value[], notify = false): void => {
    values = [...value]
    if (notify) config.onChange(values)
    update()
  }
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
  if (element.type === 'submit') {
    element.addEventListener('click', event => {
      event.preventDefault()
      element.closest('form')?.requestSubmit()
    })
  }
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
