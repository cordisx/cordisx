import type { CordisXConfigFieldSnapshot, CordisXConfigFormIcon, CordisXJsonScalar } from '../contracts.js'
import {
  HostFormControl,
  hostFormControlLayoutForPrimitive,
  hostFormDiagnostic,
  HostFormFieldActionMenu,
  HostFormItem,
  HostTransientSecretControl,
  selectHostFormPrimitive,
  validateHostFormValue,
} from './host-form-model.js'
import { createHostObjectArrayControl } from './host-form-object-array.js'
import { createHostSurfaceIcon } from './icons.js'
import {
  bindTDesignTextareaRows,
  bindTDesignTextInput,
  createTDesignButton,
  createTDesignElement,
  createTDesignMultiSelect,
  createTDesignPortal,
  createTDesignSelect,
  createTDesignTagInput,
  setTDesignProps,
  type TDesignButtonElement,
  tdesignPortalContainer,
  type TDesignSelectElement,
  type TDesignSelectOption,
} from './tdesign-form.js'
import { managerCopy, productLocale } from './ui-copy.js'
export {
  HOST_FORM_STYLES,
  hostConfigApplyMessage,
  HostConfigApplyMode,
  HostConfigApplyPhase,
  HostFormControl,
  HostFormControlLayout,
  hostFormControlLayout,
  HostFormDiagnostic,
  hostFormDiagnostic,
  HostFormFieldActionMenu,
  HostFormItem,
  HostFormPrimitive,
  hostPresenterPrimitive,
  HostTransientSecretControl,
  selectHostFormPrimitive,
  validateHostFormValue,
} from './host-form-model.js'

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

  section(
    title?: string,
    description?: string,
    icon?: CordisXConfigFormIcon,
  ): { readonly root: HTMLElement; readonly content: HTMLElement } {
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
    config: {
      readonly id?: string
      readonly disabled?: boolean
      readonly readonly?: boolean
      readonly clearable?: boolean
      readonly placeholder?: string
    } = {},
  ): TDesignSelectElement<Value> {
    return createTDesignSelect(this.document, this.portalHost, options, {
      label,
      placeholder: config.placeholder ?? managerCopy(this.locale(), 'form.select-placeholder'),
      onChange,
      ...(value === undefined ? {} : { value }),
      ...config,
    })
  }

  item(
    options: {
      readonly id: string
      readonly label: string
      readonly help?: string
      readonly required?: boolean
      readonly fullWidth?: boolean
      readonly icon?: CordisXConfigFormIcon
    },
  ): HostFormItem {
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
      root,
      control,
      labelRow,
      label,
      ...(help === undefined ? {} : { help }),
      error,
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
    const trigger = this.button(managerCopy(locale, 'form.field-actions'), {
      icon: options.icon ?? 'host:settings',
      density: 'icon',
      variant: 'text',
    })
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
    const item = (
      label: string,
      icon: CordisXConfigFormIcon,
      disabled: boolean,
      handler: () => void | Promise<void>,
    ): HTMLButtonElement => {
      const button = this.document.createElement('button')
      button.className = 'cxf-field-menu-item'
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      button.disabled = disabled
      const glyph = createHostSurfaceIcon(this.document, icon)
      glyph.classList.add('cxf-form-icon')
      glyph.setAttribute('aria-hidden', 'true')
      button.append(glyph, this.document.createTextNode(label))
      button.addEventListener('click', () => {
        void handler()
      })
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
      menu.style.insetBlockStart = `${
        above
          ? Math.max(gutter, rect.top - (menu.offsetHeight || 120) - 4)
          : Math.min(view.innerHeight - gutter, rect.bottom + 4)
      }px`
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
      this.document.defaultView?.setTimeout(() => {
        status.hidden = true
      }, 1800)
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
      const focusedItem = event.composedPath().find(node =>
        node === useDefault || node === rollback || node === copyPath
      ) as HTMLButtonElement | undefined
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
        const next = event.key === 'Home' ? 0 : event.key === 'End'
          ? enabled.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length
        enabled[next]?.focus()
      }
    }
    const onTrigger = (): void => {
      visible ? close(false) : open()
    }
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

  control(
    field: CordisXConfigFieldSnapshot,
    id: string,
    onDraft: (value: unknown, issue?: string) => void,
    options: { readonly placeholder?: string; readonly textareaRows?: number } = {},
  ): HostFormControl {
    const primitive = selectHostFormPrimitive(field)
    const diagnostic = hostFormDiagnostic(field)
    if (primitive === 'sensitive-unavailable') {
      return {
        root: this.alert(managerCopy(this.locale(), 'form.sensitive-unavailable'), 'warning'),
        primitive,
      }
    }
    if (primitive === 'unsupported') {
      return {
        root: this.alert(managerCopy(this.locale(), 'form.unsupported'), 'warning'),
        primitive,
        ...(diagnostic === undefined ? {} : { diagnostic }),
      }
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
      const value = Array.isArray(field.value)
        ? field.value.filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
        : []
      const tags = createTDesignTagInput(this.document, {
        id,
        label: field.label ?? field.path.at(-1) ?? managerCopy(this.locale(), 'form.text-placeholder'),
        placeholder: managerCopy(this.locale(), 'form.text-placeholder'),
        value,
        ...(field.max === undefined ? {} : { max: field.max }),
        disabled: field.disabled,
        onChange: next => {
          const normalized = field.arrayItemType === 'string'
            ? next.map(String)
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
        for (let hour = 0; hour < 24; hour += 1) {
          for (let minute = 0; minute < 60; minute += 15) {
            const value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
            options.push({ label: value, value })
          }
        }
        let selectedDate = dateValue ?? ''
        let selectedTime = initialTime
        const emit = () =>
          onDraft(
            selectedDate === '' ? '' : `${selectedDate} ${selectedTime}:00`,
            validateHostFormValue(
              field,
              selectedDate === '' ? '' : `${selectedDate} ${selectedTime}:00`,
              this.locale(),
            ),
          )
        setTDesignProps(date, {
          value: dateValue,
          defaultValue: dateValue,
          placeholder: productLocale(this.locale()) === 'zh-CN' ? '选择日期' : 'Select date',
          format: 'YYYY-MM-DD',
          disabled: field.disabled,
          popupProps: { attach: () => this.portalHost },
          onChange: (value: string | undefined) => {
            selectedDate = value ?? ''
            emit()
          },
        })
        const time = createTDesignSelect(this.document, this.portalHost, options, {
          id: `${id}-time`,
          label: field.label ?? field.path.at(-1) ?? 'Time',
          placeholder: productLocale(this.locale()) === 'zh-CN' ? '选择时间' : 'Select time',
          value: selectedTime,
          disabled: field.disabled,
          clearable: false,
          onChange: value => {
            selectedTime = value ?? selectedTime
            emit()
          },
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
      for (let hour = 0; hour < 24; hour += 1) {
        for (let minute = 0; minute < 60; minute += 15) {
          const value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
          options.push({ label: value, value })
        }
      }
      const time = createTDesignSelect(this.document, this.portalHost, options, {
        id,
        label: field.label ?? field.path.at(-1) ?? 'Time',
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
        value: current,
        defaultValue: current,
        disabled: field.disabled,
        placeholder: '#RRGGBB',
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
        value,
        defaultValue: value,
        min: field.min ?? 0,
        max: field.max ?? 100,
        step: field.step ?? 1,
        disabled: field.disabled,
        label: true,
        tooltipProps: { placement: 'top' },
        onChange: (next: number) => apply(next),
      })
      setTDesignProps(numeric, {
        value,
        defaultValue: value,
        min: field.min,
        max: field.max,
        step: field.step,
        disabled: field.disabled,
        placeholder: managerCopy(this.locale(), 'form.text-placeholder'),
        onChange: (next: number | undefined) => apply(next),
      })
      root.append(slider, numeric)
      return { root, focusTarget: slider, primitive, ...(diagnostic === undefined ? {} : { diagnostic }) }
    }
    if (primitive === 'object-array') {
      return createHostObjectArrayControl(
        this.document,
        this.portalHost,
        () => this.locale(),
        this,
        field,
        id,
        onDraft,
      )
    }
    const tag = primitive === 'textarea' || primitive === 'json-textarea'
      ? 't-textarea'
      : primitive === 'number-input'
      ? 't-input-number'
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
        placeholder: options.placeholder
          ?? (primitive === 'path-input' ? '/absolute/path' : managerCopy(this.locale(), 'form.text-placeholder')),
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
        dispose: () => {
          disposeText()
          disposeRows?.()
        },
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
    const icon = options.icon
      ?? (options.action === 'save' ? 'host:save' : options.action === undefined ? undefined : 'host:reset')
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
