import { JSDOM } from 'jsdom'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CordisXConfigFieldSnapshot } from '../packages/cli/src/contracts.js'
import {
  HOST_FORM_STYLES,
  HostFormAdapter,
  hostConfigApplyMessage,
  hostFormControlLayout,
  hostFormDiagnostic,
  hostPresenterPrimitive,
  selectHostFormPrimitive,
  validateHostFormValue,
} from '../packages/cli/src/renderer/host-form.js'
import { HOST_ICON_16PX_CSS } from '../packages/cli/src/renderer/icons.js'
import { setTDesignProps, unwrapTDesignChangeValue, type TDesignElement } from '../packages/cli/src/renderer/tdesign-form.js'

function field(overrides: Partial<CordisXConfigFieldSnapshot> = {}): CordisXConfigFieldSnapshot {
  return {
    namespace: 'fixture', path: ['value'], type: 'string', value: '', disabled: false, required: false, ...overrides,
  }
}

describe('Host form primitive registry', () => {
  it('supports a headingless section when the Host page header already owns the route title', () => {
    const dom = new JSDOM('<!doctype html><body></body>')
    const adapter = new HostFormAdapter(dom.window.document)
    const section = adapter.section()

    expect(section.root.className).toBe('cxf-section')
    expect(section.root.querySelector('.cxf-section-heading')).toBeNull()
    expect(section.root.firstElementChild).toBe(section.content)
  })

  it('selects every bounded primitive without exposing a library or renderer choice', () => {
    expect(selectHostFormPrimitive(field())).toBe('input')
    expect(selectHostFormPrimitive(field({ role: 'textarea' }))).toBe('textarea')
    expect(selectHostFormPrimitive(field({ type: 'number', value: 1 }))).toBe('number-input')
    expect(selectHostFormPrimitive(field({ choices: [{ label: 'Safe', value: 'safe' }] }))).toBe('select')
    expect(selectHostFormPrimitive(field({ role: 'radio', choices: [{ label: 'Safe', value: 'safe' }] }))).toBe('radio')
    expect(selectHostFormPrimitive(field({ type: 'boolean', value: false }))).toBe('checkbox')
    expect(selectHostFormPrimitive(field({ type: 'boolean', role: 'switch', value: false }))).toBe('switch')
    expect(selectHostFormPrimitive(field({ type: 'number', role: 'slider', value: 5 }))).toBe('slider')
    expect(selectHostFormPrimitive(field({ role: 'date' }))).toBe('date-picker')
    expect(selectHostFormPrimitive(field({ role: 'datetime' }))).toBe('date-picker')
    expect(selectHostFormPrimitive(field({ role: 'time' }))).toBe('time-picker')
    expect(selectHostFormPrimitive(field({ role: 'color' }))).toBe('color-picker')
    expect(selectHostFormPrimitive(field({ type: 'array', role: 'multi-select', value: ['design'], choices: [{ label: 'Design', value: 'design' }] }))).toBe('multi-select')
    expect(selectHostFormPrimitive(field({ type: 'array', value: ['design'], arrayItemType: 'string', max: 5 }))).toBe('tag-input')
    expect(selectHostFormPrimitive(field({ type: 'array', value: [true], arrayItemType: 'boolean', choices: [{ label: 'Enabled', value: true }], presenter: { version: 1, kind: 'array.scalar-rows' } }))).toBe('multi-select')
    expect(selectHostFormPrimitive(field({ role: 'directory' }))).toBe('path-input')
    expect(selectHostFormPrimitive(field({ type: 'object', value: { enabled: true } }))).toBe('json-textarea')
    expect(selectHostFormPrimitive(field({ role: 'secret', disabled: true }))).toBe('sensitive-unavailable')
    expect(selectHostFormPrimitive(field({ type: 'lazy', value: undefined }))).toBe('unsupported')
  })

  it('records honest diagnostics for unknown roles and unsupported fields', () => {
    expect(hostFormDiagnostic(field({ role: 'future-role' }))).toEqual({
      code: 'unsupported-schema-role', fieldPath: ['value'], detail: 'unknown role future-role; used input',
    })
    expect(hostFormDiagnostic(field({ type: 'lazy', value: undefined }))).toEqual({
      code: 'unsupported-schema-field', fieldPath: ['value'], detail: 'unsupported Schemastery field type: lazy',
    })
    expect(hostFormDiagnostic(field({ type: 'array', role: 'multi-select', value: ['design'] }))).toBeUndefined()
  })

  it('classifies compact controls once and keeps full controls in the full control column', () => {
    expect(hostFormControlLayout(field())).toBe('fill')
    expect(hostFormControlLayout(field({ role: 'textarea' }))).toBe('fill')
    expect(hostFormControlLayout(field({ role: 'directory' }))).toBe('fill')
    expect(hostFormControlLayout(field({ choices: [{ label: 'Safe', value: 'safe' }] }))).toBe('fill')
    expect(hostFormControlLayout(field({ type: 'number', value: 1 }))).toBe('compact')
    expect(hostFormControlLayout(field({ type: 'number', role: 'slider', value: 1 }))).toBe('compact')
    expect(hostFormControlLayout(field({ type: 'boolean', value: false }))).toBe('compact')
    expect(hostFormControlLayout(field({ type: 'boolean', role: 'switch', value: false }))).toBe('compact')
    expect(hostFormControlLayout(field({ role: 'radio', choices: [{ label: 'Safe', value: 'safe' }] }))).toBe('compact')

    const dom = new JSDOM('<!doctype html><body></body>')
    const adapter = new HostFormAdapter(dom.window.document)
    const compactItem = adapter.item({ id: 'compact', label: 'Parallel tasks' })
    adapter.connect(compactItem, adapter.control(field({ type: 'number', value: 2 }), 'compact', () => undefined))
    const fillItem = adapter.item({ id: 'fill', label: 'Workspace name' })
    adapter.connect(fillItem, adapter.control(field(), 'fill', () => undefined))
    expect(compactItem.root.dataset.controlLayout).toBe('compact')
    expect(fillItem.root.dataset.controlLayout).toBe('fill')
    expect(HOST_FORM_STYLES).toContain('.cxf-item[data-control-layout="compact"] .cxf-control-seat')
    expect(HOST_FORM_STYLES).toContain('justify-self: end')
    expect(HOST_FORM_STYLES).toContain('.cxf-item[data-control-layout="compact"] .cxf-slider-control')
  })

  it('resolves only closed presenter tokens and keeps segmented and object arrays Host-owned', () => {
    const choices = [{ label: 'Manual', value: 'manual' }, { label: 'Automatic', value: 'automatic' }] as const
    const segmented = field({ value: 'manual', choices, presenter: { version: 1, kind: 'choice.segmented' } })
    expect(hostPresenterPrimitive(segmented)).toBe('radio')
    const incompatible = field({ type: 'string', presenter: { version: 1, kind: 'number.slider' } })
    expect(hostPresenterPrimitive(incompatible)).toBeUndefined()
    expect(hostFormDiagnostic(incompatible)).toMatchObject({ code: 'unsupported-presenter' })

    const dom = new JSDOM('<!doctype html><body></body>')
    const adapter = new HostFormAdapter(dom.window.document)
    const control = adapter.control(segmented, 'approval', () => undefined)
    expect(control.root.dataset.enumPresentation).toBe('segmented')
    expect((control.focusTarget as HTMLElement & { variant?: string }).variant).toBe('primary-filled')

    const objectArray = field({
      type: 'array', value: [{ name: 'Daily summary', enabled: true }], min: 1, max: 3,
      presenter: { version: 1, kind: 'array.object-dialog' },
      arrayItemSchema: { type: 'object', disabled: false, required: false, fields: [
        { key: 'name', schema: { type: 'string', disabled: false, required: true, label: 'Name' } },
        { key: 'enabled', schema: { type: 'boolean', disabled: false, required: false, label: 'Enabled' } },
      ] },
    })
    const drafts = vi.fn()
    const array = adapter.control(objectArray, 'rules', drafts)
    expect(array.primitive).toBe('object-array')
    expect(array.root.querySelectorAll('[data-host-array-item-id]')).toHaveLength(1)
    expect(array.root.querySelector('[data-host-array-drag-handle="true"]')?.getAttribute('title')).toBe('使用上下移动操作调整顺序')
    expect([...array.root.querySelectorAll<HTMLElement>('.cxf-array-row-actions t-button')].every(button => button.dataset.density === 'icon')).toBe(true)
    ;(array.root.querySelector('t-button') as HTMLElement).click()
    expect(array.root.querySelectorAll('[data-host-array-item-id]')).toHaveLength(2)
    expect(drafts).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ name: 'Daily summary' })]), undefined)
  })

  it('validates required, finite numeric, natural, range, and choice constraints', () => {
    expect(validateHostFormValue(field({ required: true }), '')).toBe('此项为必填项')
    expect(validateHostFormValue(field({ type: 'number', value: 0 }), Number.NaN)).toBe('请输入有效数字')
    expect(validateHostFormValue(field({ type: 'natural', value: 0 }), -1)).toBe('请输入非负整数')
    expect(validateHostFormValue(field({ type: 'number', value: 2, min: 2 }), 1)).toBe('不能小于 2')
    expect(validateHostFormValue(field({ type: 'number', value: 2, max: 3 }), 4)).toBe('不能大于 3')
    expect(validateHostFormValue(field({ type: 'number', value: 2, min: 1, step: 2 }), 2)).toBe('请按 2 的步长输入')
    expect(validateHostFormValue(field({ choices: [{ label: 'Safe', value: 'safe' }] }), 'fast')).toBe('请选择列表中的有效值')
    expect(validateHostFormValue(field({ role: 'datetime' }), 'bad')).toBe('请输入有效日期和时间')
  })

  it('keeps object-array identity, reorder, dialog keyboard dismissal, and parent draft ownership in the Host', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true, url: 'https://forms.example.test/' })
    const adapter = new HostFormAdapter(dom.window.document, undefined, () => 'en')
    const drafts = vi.fn()
    const control = adapter.control(field({
      type: 'array', value: [{ title: 'First' }, { title: 'Second' }], min: 1, max: 4,
      presenter: { version: 1, kind: 'array.object-dialog', options: { allowReorder: true } },
      arrayItemSchema: { type: 'object', disabled: false, required: false, fields: [
        { key: 'title', schema: { type: 'string', disabled: false, required: true, label: 'Title' } },
      ] },
    }), 'rules', drafts)
    dom.window.document.body.append(control.root)
    await Promise.resolve()
    const initialIds = [...control.root.querySelectorAll<HTMLElement>('[data-host-array-item-id]')].map(row => row.dataset.hostArrayItemId)
    const actions = control.root.querySelectorAll<HTMLElement>('t-button')
    // Add, edit, duplicate, up, down, delete per each row. Move the second row up.
    actions[8]!.click()
    const reordered = [...control.root.querySelectorAll<HTMLElement>('[data-host-array-item-id]')].map(row => row.dataset.hostArrayItemId)
    expect(reordered[0]).toBe(initialIds[1])
    expect(reordered[1]).toBe(initialIds[0])
    const edit = control.root.querySelectorAll<HTMLElement>('t-button')[1]!
    edit.click()
    const portal = dom.window.document.querySelector<HTMLElement>('[data-cxf-tdesign-portal-host]')!
    const dialog = portal.shadowRoot?.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(dialog?.querySelector('t-input')).not.toBeNull()
    expect(dialog?.classList.contains('cxf-array-editor-dialog')).toBe(true)
    expect(HOST_FORM_STYLES).toContain('--cxf-manager-dialog-padding: 1rem')
    expect(HOST_FORM_STYLES).toContain('box-shadow: 0 24px 80px var(--cx-shadow)')
    dialog?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(portal.shadowRoot?.querySelector('[role="dialog"]')).toBeNull()
    edit.click()
    expect(portal.shadowRoot?.querySelector('[role="dialog"]')).not.toBeNull()
    control.root.remove()
    await new Promise(resolve => dom.window.setTimeout(resolve, 0))
    expect(portal.shadowRoot?.querySelector('[role="dialog"]')).toBeNull()
    expect(drafts).toHaveBeenCalled()
  })

  it('projects every generic apply mode only when a draft or save needs it', () => {
    expect(hostConfigApplyMessage('live', 'dirty')).toBe('有未保存更改 · 保存后立即生效')
    expect(hostConfigApplyMessage('plugin-restart', 'saved')).toBe('保存后重启插件生效')
    expect(hostConfigApplyMessage('restart', 'saved')).toBe('保存后重启插件生效')
    expect(hostConfigApplyMessage('service-restart', 'dirty')).toBe('有未保存更改 · 保存后重启相关服务生效')
    expect(hostConfigApplyMessage('app-restart', 'saved')).toBe('保存后重启 App 生效')
    expect(hostConfigApplyMessage('app-restart', 'saving')).toBe('正在保存…')
    expect(hostConfigApplyMessage('live', 'dirty', 'en')).toBe('Unsaved changes · Applies immediately after saving')
    expect(hostConfigApplyMessage('plugin-restart', 'saved', 'en-US')).toBe('Takes effect after restarting the plugin')
    expect(hostConfigApplyMessage('service-restart', 'saved', 'en')).toBe('Takes effect after restarting the service')
    expect(hostConfigApplyMessage('app-restart', 'saving', 'en')).toBe('Saving…')
  })

  it('localizes Host validation independently from plugin labels', () => {
    expect(validateHostFormValue(field({ required: true }), '', 'en')).toBe('Required')
    expect(validateHostFormValue(field({ type: 'number', value: 0 }), Number.NaN, 'en')).toBe('Enter a valid number')
    expect(validateHostFormValue(field({ type: 'natural', value: 0 }), -1, 'en')).toBe('Enter a non-negative integer')
    expect(validateHostFormValue(field({ type: 'number', value: 2, min: 2 }), 1, 'en')).toBe('Must be at least 2')
    expect(validateHostFormValue(field({ type: 'number', value: 2, max: 3 }), 4, 'en')).toBe('Must be at most 3')
    expect(validateHostFormValue(field({ type: 'number', value: 2, min: 1, step: 2 }), 2, 'en')).toBe('Use increments of 2')
    expect(validateHostFormValue(field({ choices: [{ label: 'Safe', value: 'safe' }] }), 'fast', 'en')).toBe('Choose a value from the list')
    expect(validateHostFormValue(field({ role: 'datetime' }), 'bad', 'en')).toBe('Enter a valid date and time')
  })
})

describe('Host form DOM and accessibility', () => {
  it('updates getter-only official component props through the typed props seam', () => {
    const dom = new JSDOM('<!doctype html><body></body>')
    const control = dom.window.document.createElement('div') as TDesignElement
    control.props = {}
    Object.defineProperty(control, 'theme', {
      configurable: true,
      get: () => control.props?.theme,
    })
    expect(() => setTDesignProps(control, { theme: 'primary' })).not.toThrow()
    expect(control.theme).toBe('primary')
  })

  it('captures one-shot secrets through an official password input without adding them to form snapshots', () => {
    const dom = new JSDOM('<!doctype html><body></body>')
    const adapter = new HostFormAdapter(dom.window.document)
    const onDraft = vi.fn()
    const secret = adapter.transientSecret('credential', onDraft)
    const input = secret.root as TDesignElement

    expect(input.tagName).toBe('T-INPUT')
    expect(input.dataset.hostTransientSecret).toBe('true')
    expect(input.getAttribute('autocomplete')).toBe('new-password')
    expect(input).toMatchObject({ value: '', defaultValue: '', type: 'password' })
    ;(input.onChange as ((value: string) => void) | undefined)?.('test-only-secret')
    expect(onDraft).toHaveBeenCalledWith('test-only-secret')
    expect(secret.root.textContent).not.toContain('test-only-secret')
    secret.clear()
    expect(input).toMatchObject({ value: '', defaultValue: '', type: 'password' })
  })
  it('unwraps official CustomEvent and native input events before they enter Host drafts', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true })
    const adapter = new HostFormAdapter(dom.window.document)
    const onDraft = vi.fn()
    const event = (value: unknown) => new dom.window.CustomEvent('change', { detail: { value } })
    expect(unwrapTDesignChangeValue<string>(event('Northstar'))).toBe('Northstar')
    expect(unwrapTDesignChangeValue<number>(event(42))).toBe(42)
    const nativeInput = dom.window.document.createElement('input')
    nativeInput.value = 'Native value'
    nativeInput.addEventListener('input', nativeEvent => {
      expect(unwrapTDesignChangeValue<string>(nativeEvent)).toBe('Native value')
    })
    nativeInput.dispatchEvent(new dom.window.Event('input'))

    const input = adapter.control(field({ value: '' }), 'input', onDraft).root as HTMLElement & { onChange?: (value: unknown) => void }
    input.onChange?.(event('Northstar'))
    expect(onDraft).toHaveBeenLastCalledWith('Northstar', undefined)

    // The official controlled `t-input` calls the Host callback from its
    // internal input and then re-renders from `props.value`. Keep that exact
    // CustomEvent detail path from restoring the prior value after a fill.
    const controlledInput = adapter.control(field({ value: 'Northstar workspace' }), 'controlled-input', onDraft).root as HTMLElement & {
      onChange?: (value: unknown) => void
      value?: string
      props?: { value?: string }
      receiveProps?: (next: { value?: string }, previous: { value?: string }) => void
    }
    controlledInput.props = { value: 'Northstar workspace' }
    const receiveProps = vi.fn((next: { value?: string }) => {
      // Mirrors the official component's private controlled value update.
      internalInput.value = next.value ?? ''
    })
    controlledInput.receiveProps = receiveProps
    const internalInput = dom.window.document.createElement('input')
    internalInput.value = controlledInput.props.value
    internalInput.addEventListener('input', () => {
      // `t-input` first invokes its prop callback with the raw value, then
      // emits the matching CustomEvent detail for DOM consumers.
      controlledInput.onChange?.(internalInput.value)
      controlledInput.onChange?.(new dom.window.CustomEvent('change', { detail: { value: internalInput.value } }))
      // Models the immediate controlled redraw in the official component.
      internalInput.value = controlledInput.props?.value ?? ''
    })
    internalInput.value = 'Northstar updated'
    internalInput.dispatchEvent(new dom.window.Event('input'))
    expect(controlledInput.props.value).toBe('Northstar updated')
    expect(controlledInput.value).toBe('Northstar updated')
    expect(internalInput.value).toBe('Northstar updated')
    expect(receiveProps).toHaveBeenNthCalledWith(1,
      { value: 'Northstar updated' },
      { value: 'Northstar workspace' },
    )
    expect(onDraft).toHaveBeenLastCalledWith('Northstar updated', undefined)

    const textarea = adapter.control(field({ role: 'textarea', value: '' }), 'textarea', onDraft).root as HTMLElement & { onChange?: (value: unknown) => void }
    textarea.onChange?.(event('Multiline value'))
    expect(onDraft).toHaveBeenLastCalledWith('Multiline value', undefined)

    const number = adapter.control(field({ type: 'number', value: 1 }), 'number', onDraft).root as HTMLElement & { onChange?: (value: unknown) => void }
    number.onChange?.(event(9))
    expect(onDraft).toHaveBeenLastCalledWith(9, undefined)

    const slider = adapter.control(field({ type: 'number', role: 'slider', value: 2, min: 0, max: 10 }), 'slider', onDraft)
    ;(slider.focusTarget as HTMLElement & { onChange?: (value: unknown) => void }).onChange?.(event(7))
    expect(onDraft).toHaveBeenLastCalledWith(7, undefined)

    const checkbox = adapter.control(field({ type: 'boolean', value: false }), 'checkbox', onDraft).root as HTMLElement & { onChange?: (value: unknown) => void }
    checkbox.onChange?.(event([true]))
    expect(onDraft).toHaveBeenLastCalledWith(true)

    const toggle = adapter.control(field({ type: 'boolean', role: 'switch', value: false }), 'toggle', onDraft).root as HTMLElement & { onChange?: (value: unknown) => void }
    toggle.onChange?.(event('true'))
    expect(onDraft).toHaveBeenLastCalledWith(true)

    const radio = adapter.control(field({ role: 'radio', value: 'safe', choices: [{ label: 'Safe', value: 'safe' }, { label: 'Fast', value: 'fast' }] }), 'radio', onDraft)
    ;(radio.focusTarget as HTMLElement & { onChange?: (value: unknown) => void }).onChange?.(event('fast'))
    expect(onDraft).toHaveBeenLastCalledWith('fast')

    const select = adapter.control(field({ value: 'safe', choices: [{ label: 'Safe', value: 'safe' }, { label: 'Fast', value: 'fast' }] }), 'select', onDraft).root as HTMLElement & { onChange?: (value: unknown) => void }
    select.onChange?.(event('fast'))
    expect(onDraft).toHaveBeenLastCalledWith('fast', undefined)
  })

  it('keeps upgraded Shadow DOM text controls editable and preserves explicit textarea rows', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true })
    const adapter = new HostFormAdapter(dom.window.document)
    const onDraft = vi.fn()
    const control = adapter.control({
      namespace: 'test', path: ['introduction'], type: 'string', role: 'textarea', value: '', disabled: false, required: false,
    }, 'introduction', onDraft, { placeholder: 'Describe this channel', textareaRows: 5 })
    const host = control.root as TDesignElement
    const shadow = host.attachShadow({ mode: 'open' })
    const textarea = dom.window.document.createElement('textarea')
    shadow.append(textarea)
    dom.window.document.body.append(host)

    await Promise.resolve()
    textarea.value = 'Editable introduction'
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true, composed: true }))
    await Promise.resolve()

    expect(onDraft).toHaveBeenLastCalledWith('Editable introduction', undefined)
    expect(textarea.value).toBe('Editable introduction')
    expect(textarea.rows).toBe(5)
    expect(textarea.style.getPropertyValue('min-height')).toBe('122px')
    expect(textarea.style.getPropertyPriority('min-height')).toBe('important')
    expect(host.getAttribute('placeholder')).toBe('Describe this channel')
    control.dispose?.()
    dom.window.close()
  })

  it('projects labels, help, errors, required state, TDesign controls, and draft events', () => {
    const dom = new JSDOM('<!doctype html><html lang="zh-CN" dir="rtl"><body></body></html>', { pretendToBeVisual: true })
    const adapter = new HostFormAdapter(dom.window.document)
    const form = adapter.form('fixture')
    const item = adapter.item({ id: 'duration', label: '时长', help: '1 到 120 秒', required: true })
    const onDraft = vi.fn()
    const control = adapter.control(field({ path: ['duration'], type: 'number', role: 'slider', value: 30, min: 1, max: 120, required: true }), 'duration', onDraft)
    adapter.connect(item, control)
    item.control.append(control.root)
    form.append(item.root)
    dom.window.document.body.append(form)

    const range = control.focusTarget as HTMLElement & { value?: number; onChange?: (value: number) => void }
    expect(form.classList.contains('cxf-scope')).toBe(true)
    expect(item.label.htmlFor).toBe('duration')
    expect(item.root.querySelector('.cxf-required')?.getAttribute('aria-hidden')).toBe('true')
    expect(control.root.tagName).toBe('DIV')
    expect(control.root.className).toBe('cxf-slider-control')
    expect(range.tagName).toBe('T-SLIDER')
    const numeric = control.root.querySelector<HTMLElement>('t-input-number')
    expect(numeric).not.toBeNull()
    expect(numeric?.getAttribute('placeholder')).toBe('请输入')
    expect(range.dataset.tdesignVersion).toBe('1.2.10')
    expect((range as HTMLElement & { label?: boolean; tooltipProps?: { placement?: string } }).label).toBe(true)
    expect((range as HTMLElement & { tooltipProps?: { placement?: string } }).tooltipProps).toEqual({ placement: 'top' })
    expect(range.getAttribute('role')).toBe('slider')
    expect(range.getAttribute('aria-required')).toBe('true')
    expect(range.getAttribute('aria-describedby')).toContain('duration-help')
    range.onChange?.(45)
    expect(onDraft).toHaveBeenCalledWith(45, undefined)
    item.setError('保存前请修正')
    expect(range.getAttribute('aria-invalid')).toBe('true')
    expect(item.error.hidden).toBe(false)
  })

  it('uses TDesign switch/radio semantics and redacts sensitive fields', () => {
    const dom = new JSDOM('<!doctype html><body></body>')
    const adapter = new HostFormAdapter(dom.window.document)
    const switchControl = adapter.control(field({ type: 'boolean', role: 'switch', value: true }), 'enabled', () => undefined)
    const checkbox = adapter.control(field({ type: 'boolean', value: true }), 'avatars', () => undefined)
    const radio = adapter.control(field({ role: 'radio', value: 'safe', choices: [
      { label: 'Safe', value: 'safe' }, { label: 'Fast', value: 'fast' },
    ] }), 'mode', () => undefined)
    const secret = adapter.control(field({ role: 'credential', value: undefined, disabled: true }), 'credential', () => undefined)
    expect(switchControl.root.tagName).toBe('T-SWITCH')
    expect(switchControl.root.getAttribute('role')).toBe('switch')
    expect(switchControl.root.getAttribute('value')).toBe('true')
    expect(switchControl.root.getAttribute('custom-value')).toBe('["true","false"]')
    expect(checkbox.root.tagName).toBe('T-CHECKBOX-GROUP')
    expect(checkbox.root.dataset.tdesignComponent).toBe('checkbox-group')
    expect(checkbox.root.getAttribute('role')).toBe('checkbox')
    expect(radio.root.getAttribute('role')).toBe('radiogroup')
    expect(radio.focusTarget?.tagName).toBe('T-RADIO-GROUP')
    expect(radio.focusTarget?.dataset.tdesignComponent).toBe('radio-group')
    expect(secret.root.getAttribute('role')).toBe('status')
    expect(secret.root.querySelector('input,textarea,select')).toBeNull()
    expect(secret.root.textContent).not.toContain('undefined')
    const switchInput = switchControl.focusTarget as HTMLElement & { onChange?: (value: boolean) => void }
    switchInput.onChange?.(false)
    expect(switchControl.root.getAttribute('aria-checked')).toBe('false')
  })

  it('uses the live locale provider for switch, secret, unsupported, and JSON feedback', () => {
    const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>')
    let locale = 'en'
    const adapter = new HostFormAdapter(dom.window.document, undefined, () => locale)
    const switchControl = adapter.control(field({ type: 'boolean', role: 'switch', value: true }), 'enabled', () => undefined)
    expect((switchControl.root as HTMLElement & { label?: string[] }).label).toEqual(['On', 'Off'])
    expect(adapter.control(field({ role: 'secret' }), 'secret', () => undefined).root.textContent)
      .toContain('Managed by Host credentials')
    expect(adapter.control(field({ role: 'date' }), 'date', () => undefined).root.tagName).toBe('T-DATE-PICKER')
    const text = adapter.control(field(), 'text', () => undefined).root as HTMLElement & { placeholder?: string }
    const textarea = adapter.control(field({ role: 'textarea' }), 'textarea', () => undefined).root as HTMLElement & { placeholder?: string }
    const multiline = adapter.control(field({ role: 'multiline' }), 'multiline', () => undefined).root
    const number = adapter.control(field({ type: 'number', value: undefined }), 'number', () => undefined).root as HTMLElement & { placeholder?: string }
    const slider = adapter.control(field({ type: 'number', role: 'slider', value: 4, min: 0, max: 10 }), 'slider', () => undefined).root
    const select = adapter.control(field({ choices: [{ label: 'Safe', value: 'safe' }] }), 'select', () => undefined).root as HTMLElement & { placeholder?: string }
    expect(text.placeholder).toBe('Enter a value')
    expect(text.getAttribute('placeholder')).toBe('Enter a value')
    expect(textarea.placeholder).toBe('Enter a value')
    expect(textarea.getAttribute('placeholder')).toBe('Enter a value')
    expect(multiline.tagName).toBe('T-TEXTAREA')
    expect(number.placeholder).toBe('Enter a value')
    expect(number.getAttribute('placeholder')).toBe('Enter a value')
    expect(slider.querySelector('t-input-number')?.getAttribute('placeholder')).toBe('Enter a value')
    expect(select.placeholder).toBe('Choose')
    expect(select.getAttribute('placeholder')).toBe('Choose')
    const onDraft = vi.fn()
    const json = adapter.control(field({ type: 'object', value: {} }), 'json', onDraft).root as HTMLElement & { onChange?: (value: string) => void }
    json.onChange?.('{')
    expect(onDraft).toHaveBeenLastCalledWith(undefined, 'Enter valid JSON')
    locale = 'zh-CN'
    expect(adapter.control(field({ role: 'secret' }), 'secret-zh', () => undefined).root.textContent)
      .toContain('Host 凭据边界')
    const textZh = adapter.control(field(), 'text-zh', () => undefined).root as HTMLElement & { placeholder?: string }
    const textareaZh = adapter.control(field({ role: 'textarea' }), 'textarea-zh', () => undefined).root as HTMLElement & { placeholder?: string }
    const numberZh = adapter.control(field({ type: 'number', value: undefined }), 'number-zh', () => undefined).root as HTMLElement & { placeholder?: string }
    const selectZh = adapter.control(field({ choices: [{ label: '安全', value: 'safe' }] }), 'select-zh', () => undefined).root as HTMLElement & { placeholder?: string }
    expect(textZh.placeholder).toBe('请输入')
    expect(textZh.getAttribute('placeholder')).toBe('请输入')
    expect(textareaZh.placeholder).toBe('请输入')
    expect(textareaZh.getAttribute('placeholder')).toBe('请输入')
    expect(numberZh.placeholder).toBe('请输入')
    expect(numberZh.getAttribute('placeholder')).toBe('请输入')
    expect(selectZh.placeholder).toBe('选择')
    expect(selectZh.getAttribute('placeholder')).toBe('选择')
  })

  it('connects help and errors to the keyboard target and labels native radio groups', () => {
    const dom = new JSDOM('<!doctype html><body></body>')
    const adapter = new HostFormAdapter(dom.window.document)
    const checkboxItem = adapter.item({ id: 'enabled', label: '启用', help: '切换功能' })
    const checkbox = adapter.control(field({ type: 'boolean', value: false }), 'enabled', () => undefined)
    adapter.connect(checkboxItem, checkbox)
    expect(checkbox.focusTarget?.getAttribute('aria-describedby')).toBe('enabled-help enabled-error')

    const radioItem = adapter.item({ id: 'mode', label: '模式', help: '选择一种模式' })
    const radio = adapter.control(field({ role: 'radio', value: 'safe', choices: [
      { label: 'Safe', value: 'safe' }, { label: 'Fast', value: 'fast' },
    ] }), 'mode', () => undefined)
    adapter.connect(radioItem, radio)
    expect(radioItem.label.htmlFor).toBe('')
    expect(radio.root.getAttribute('aria-labelledby')).toBe('mode-label')
    expect(radio.root.getAttribute('aria-describedby')).toBe('mode-help mode-error')
  })

  it('keeps official TDesign tokens and every base rule scoped to CordisX form classes', () => {
    expect(HOST_FORM_STYLES).toContain('--td-brand-color: var(--cx-primary)')
    expect(HOST_FORM_STYLES).toContain('--td-bg-color-container-hover: var(--cx-hover)')
    expect(HOST_FORM_STYLES).toContain('--td-bg-color-container-select: var(--cx-pressed)')
    expect(HOST_FORM_STYLES).toContain('--td-bg-color-component-disabled:')
    expect(HOST_FORM_STYLES).toContain('--td-text-color-anti: var(--cx-primary-text)')
    expect(HOST_FORM_STYLES).toContain('--td-brand-color-disabled:')
    expect(HOST_FORM_STYLES).toContain('[data-cordisx-app-theme="dark"] .cxf-scope { color-scheme: dark; }')
    expect(HOST_FORM_STYLES).toContain('.cxf-tdesign-control { display: inline-block;')
    expect(HOST_FORM_STYLES).not.toMatch(/t-select\.cxf-tdesign-control:focus-visible/u)
    expect(HOST_FORM_STYLES).toContain('.cxf-tdesign-control:focus-visible { outline: 2px solid Highlight;')
    expect(HOST_FORM_STYLES).toContain('.cxf-scope:dir(rtl)')
    expect(HOST_FORM_STYLES).toContain('@media (forced-colors: active)')
    expect(HOST_FORM_STYLES).toContain('inline-size: 100%; min-inline-size: 0; margin: 0;')
    expect(HOST_FORM_STYLES).toContain('.cxf-form-grid')
    expect(HOST_FORM_STYLES).toContain('@media (max-width: 760px)')
    expect(HOST_FORM_STYLES).toContain('.cxf-button { display: inline-block; min-block-size: 0;')
    expect(HOST_FORM_STYLES).toContain('.cxf-button[data-density="icon"] { inline-size: 2rem; block-size: 2rem; }')
    expect(HOST_FORM_STYLES).toContain('.cxf-form-footer { position: sticky; inset-block-start: 0;')
    expect(HOST_FORM_STYLES).toContain('margin: 0; padding: 0; border: 0; border-radius: 0; background: transparent;')
    expect(HOST_FORM_STYLES).toContain('t-select.cxf-tdesign-control { border: 0; border-radius: 0; padding: 0; background: transparent; }')
    expect(HOST_FORM_STYLES).toContain('t-select.cxf-tdesign-control::part(suffix), t-select.cxf-tdesign-control::part(t-select__right-icon) { display: inline-grid; align-self: center; place-items: center; block-size: 100%; }')
    expect(HOST_FORM_STYLES).not.toContain('inset-block-end: -.25rem')
    expect(HOST_FORM_STYLES).not.toContain('.cxf-button {\n    display: inline-flex;')
    expect(HOST_FORM_STYLES).not.toMatch(/(^|[\s,{])(:root|html|body|\*)\s*[{,]/u)
  })

  it('projects semantic Host action icons into official TDesign icon slots with accessible compact actions', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true })
    const adapter = new HostFormAdapter(dom.window.document)
    const restore = adapter.button('Restore default', { action: 'restore-default', density: 'icon' })
    const undo = adapter.button('Undo changes', { action: 'undo', density: 'icon' })
    const save = adapter.button('Save configuration', { action: 'save', variant: 'primary', density: 'icon' })

    expect(restore.getAttribute('aria-label')).toBe('Restore default')
    expect(restore.getAttribute('title')).toBe('Restore default')
    expect(restore.getAttribute('theme')).toBe('default')
    expect(restore.getAttribute('variant')).toBe('outline')
    expect(restore.getAttribute('shape')).toBe('square')
    expect(restore.dataset.hostFormAction).toBe('restore-default')
    expect(restore.dataset.hostFormActionIcon).toBe('host:reset')
    expect(restore.textContent).toBe('')
    expect(restore.querySelector('[data-host-icon="host:reset"]')?.getAttribute('slot')).toBe('icon')
    expect(undo.dataset.hostFormActionIcon).toBe('host:reset')
    expect(undo.querySelector('[data-host-icon="host:reset"]')?.getAttribute('slot')).toBe('icon')
    expect(undo.getAttribute('aria-label')).toBe('Undo changes')
    expect(undo.getAttribute('title')).toBe('Undo changes')
    expect(undo.textContent).toBe('')
    expect(save.dataset.hostFormActionIcon).toBe('host:save')
    expect(save.querySelector('[data-host-icon="host:save"]')?.getAttribute('slot')).toBe('icon')
    expect(save as unknown as { theme?: string; variant?: string; content?: string }).toMatchObject({ theme: 'primary', variant: 'base', content: '' })
    expect(restore as unknown as { shape?: string; size?: string; content?: string }).toMatchObject({ shape: 'square', size: 'small', content: '' })
  })

  it('uses one Host-owned portalled field-action menu for default, field rollback, and path copy', async () => {
    const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', { pretendToBeVisual: true })
    const adapter = new HostFormAdapter(dom.window.document, undefined, () => 'en')
    let hasDraft = true
    const useDefault = vi.fn()
    const rollback = vi.fn()
    const copyPath = vi.fn(async () => true)
    const menu = adapter.fieldActionMenu({
      label: 'Workspace name', canUseDefault: () => true, hasFieldDraft: () => hasDraft,
      useDefault, rollback, copyPath,
    })
    dom.window.document.body.append(menu.trigger)
    expect(menu.trigger.textContent).toBe('')
    expect(menu.trigger.getAttribute('aria-label')).toBe('Field actions')
    expect(menu.trigger.getAttribute('variant')).toBe('text')
    expect(menu.trigger.querySelector('[data-host-icon="host:settings"]')).not.toBeNull()
    const semanticMenu = adapter.fieldActionMenu({
      label: 'Schedule', icon: 'host:calendar', canUseDefault: () => false, hasFieldDraft: () => false,
      useDefault: () => undefined, rollback: () => undefined, copyPath: async () => false,
    })
    expect(semanticMenu.trigger.querySelector('[data-host-icon="host:calendar"]')).not.toBeNull()
    expect(semanticMenu.trigger.querySelector('[data-host-icon="host:settings"]')).toBeNull()
    semanticMenu.dispose()
    menu.trigger.click()
    const portal = dom.window.document.querySelector<HTMLElement>('[data-cxf-tdesign-portal-host]')!
    const popup = portal.shadowRoot?.querySelector<HTMLElement>('[role="menu"]')!
    const entries = [...popup.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    expect(popup.hidden).toBe(false)
    expect(menu.trigger.getAttribute('aria-expanded')).toBe('true')
    expect(entries.map(entry => entry.textContent)).toEqual(['Use default value', 'Revert field change', 'Copy configuration path'])
    expect(entries.map(entry => entry.querySelector('[data-host-icon]')?.getAttribute('data-host-icon'))).toEqual(['host:reset', 'host:reset', 'host:files'])
    const portalStyles = portal.shadowRoot?.querySelector('style')?.textContent ?? ''
    expect(portalStyles).toContain(HOST_ICON_16PX_CSS)
    expect(HOST_FORM_STYLES).toContain(HOST_ICON_16PX_CSS)
    expect(portalStyles).toContain('inline-size: 16px')
    expect(portalStyles).toContain('color: currentColor')
    expect(portalStyles).toContain('min-inline-size: 160px')
    expect(portalStyles).toContain('padding: 8px 9px')
    expect(portalStyles).toContain('gap: 9px')
    expect(portalStyles).toContain('.cxf-field-menu-item:active:not(:disabled)')
    expect(HOST_FORM_STYLES).toContain('.cxf-field-menu-trigger:hover:not(:disabled), .cxf-field-menu-trigger[aria-expanded="true"] { background: transparent;')
    expect(HOST_FORM_STYLES).toContain('t-select.cxf-tdesign-control::part(t-select__right-icon)')
    expect(HOST_FORM_STYLES).toContain('.cxf-time-select { inline-size: 100%; max-inline-size: none; }')
    expect(HOST_FORM_STYLES).toContain('padding-inline-end: var(--td-comp-paddingLR-s)')
    entries[0]!.click()
    expect(useDefault).toHaveBeenCalledOnce()
    expect(popup.hidden).toBe(true)

    menu.trigger.click()
    entries[1]!.click()
    expect(rollback).toHaveBeenCalledOnce()
    hasDraft = false
    menu.trigger.click()
    expect(entries[1]!.disabled).toBe(true)
    entries[2]!.focus()
    entries[2]!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true, cancelable: true }))
    await Promise.resolve()
    expect(copyPath).toHaveBeenCalledOnce()
    expect(popup.querySelector('[role="status"]')?.textContent).toBe('Path copied')
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(popup.hidden).toBe(true)
    expect(dom.window.document.activeElement).toBe(menu.trigger)
    menu.dispose()
    expect(portal.shadowRoot?.querySelector('[role="menu"]')).toBeNull()
  })

  it('uses the official TDesign Loading component and an honest Host empty state', () => {
    const dom = new JSDOM('<!doctype html><body></body>')
    const adapter = new HostFormAdapter(dom.window.document)
    const loading = adapter.loading('加载中…')
    expect(loading.tagName).toBe('T-LOADING')
    expect(loading.dataset.tdesignVersion).toBe('1.2.10')
    expect(loading.getAttribute('aria-busy')).toBe('true')
    const empty = adapter.empty('暂无数据')
    expect(empty.tagName).toBe('DIV')
    expect(empty.className).toBe('cxf-empty')
  })

  it('renders choices through the pinned official TDesign Select adapter with complete keyboard semantics', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true })
    const adapter = new HostFormAdapter(dom.window.document)
    const onDraft = vi.fn()
    const control = adapter.control(field({ value: 'safe', choices: [
      { label: 'Safe', value: 'safe' }, { label: 'Fast', value: 'fast' }, { label: 'Off', value: 'off', disabled: true },
    ] }), 'mode', onDraft)
    const select = control.root as HTMLElement & {
      selectedValue: string | undefined
      setSelectedValue(value: string | undefined, notify?: boolean): void
    }
    dom.window.document.body.append(select)
    expect(select.tagName).toBe('T-SELECT')
    expect(select.dataset.tdesignComponent).toBe('select')
    expect(select.style.getPropertyValue('--td-bg-color-container')).toBe('var(--cx-surface)')
    expect(select.style.getPropertyValue('--td-bg-color-container-select')).toBe('var(--cx-pressed)')
    expect(select.style.getPropertyValue('color-scheme')).toBe('inherit')
    expect(select.getAttribute('role')).toBe('combobox')
    expect(select.getAttribute('aria-haspopup')).toBe('listbox')
    select.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    expect(select.getAttribute('aria-expanded')).toBe('true')
    ;(select as HTMLElement & { onPopupVisibleChange?: (visible: boolean) => void }).onPopupVisibleChange?.(true)
    expect(select.getAttribute('aria-expanded')).toBe('true')
    const portal = dom.window.document.querySelector<HTMLElement>('[data-cxf-tdesign-portal-host]')
    const listbox = portal?.shadowRoot?.querySelector<HTMLElement>('[role="listbox"]')
    expect(listbox?.hidden).toBe(false)
    expect(listbox?.querySelectorAll('t-option[data-tdesign-version="1.2.10"]')).toHaveLength(3)
    expect(listbox?.querySelector('[aria-disabled="true"]')?.textContent).toBe('Off')
    expect(listbox?.querySelector('t-option[data-active="true"]')?.textContent).toBe('Fast')
    select.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(select.selectedValue).toBe('fast')
    expect(listbox?.querySelector('t-option[aria-selected="true"]')?.textContent).toBe('Fast')
    expect(onDraft).toHaveBeenLastCalledWith('fast', undefined)
    select.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    select.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(select.getAttribute('aria-expanded')).toBe('false')
    expect(listbox?.hidden).toBe(true)
    select.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    dom.window.document.body.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true, composed: true }))
    expect(select.getAttribute('aria-expanded')).toBe('false')
  })

  it('renders editable date/time/color, bounded multi-select, and finite tags through Host-owned TDesign controls', () => {
    const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', { pretendToBeVisual: true })
    const adapter = new HostFormAdapter(dom.window.document, undefined, () => 'en')
    const onDraft = vi.fn()
    const date = adapter.control(field({ role: 'date', value: '2026-09-01' }), 'date', onDraft)
    const dateTime = adapter.control(field({ role: 'datetime', value: '2026-09-01 09:30:00' }), 'date-time', onDraft)
    const time = adapter.control(field({ role: 'time', value: '18:30' }), 'time', onDraft)
    const color = adapter.control(field({ role: 'color', value: '#3B82F6' }), 'color', onDraft)
    const multi = adapter.control(field({ type: 'array', role: 'multi-select', value: ['design'], min: 1, max: 3, choices: [
      { label: 'Design', value: 'design' }, { label: 'Research', value: 'research' },
    ] }), 'audiences', onDraft)
    const tags = adapter.control(field({ type: 'array', value: ['weekly'], arrayItemType: 'string', max: 4 }), 'tags', onDraft)
    dom.window.document.body.append(date.root, dateTime.root, time.root, color.root, multi.root, tags.root)
    expect(date.root.tagName).toBe('T-DATE-PICKER')
    expect(dateTime.root.className).toBe('cxf-datetime-control')
    expect(dateTime.root.querySelectorAll('t-date-picker, t-select')).toHaveLength(2)
    expect(time.root.tagName).toBe('T-SELECT')
    expect(color.root.querySelectorAll('t-input')).toHaveLength(1)
    expect(color.root.querySelector<HTMLInputElement>('input[type="color"]')?.value).toBe('#3b82f6')
    expect(color.root.getAttribute('data-host-form-primitive')).toBeNull()
    expect(color.root.querySelector('t-input')?.getAttribute('data-host-form-primitive')).toBe('color-picker')
    expect(multi.root.tagName).toBe('T-SELECT')
    expect(multi.root.dataset.hostFormPrimitive).toBe('multi-select')
    expect(tags.root.tagName).toBe('T-TAG-INPUT')
    const multiElement = multi.root as HTMLElement & { selectedValues: readonly string[] }
    multiElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    expect(multiElement.getAttribute('aria-expanded')).toBe('true')
    multiElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(multiElement.selectedValues).toEqual(['design', 'research'])
    expect(onDraft).toHaveBeenLastCalledWith(['design', 'research'], undefined)
    const dateTimeTime = dateTime.root.querySelector('t-select') as HTMLElement & { onChange?: (value: string) => void }
    dateTimeTime.onChange?.('10:00')
    expect(onDraft).toHaveBeenLastCalledWith('2026-09-01 10:00:00', undefined)
    const colorInput = color.focusTarget as HTMLElement & { onChange?: (value: string) => void }
    colorInput.onChange?.('#ef4444')
    expect(onDraft).toHaveBeenLastCalledWith('#EF4444', undefined)
    const colorPicker = color.root.querySelector<HTMLInputElement>('input[type="color"]')!
    colorPicker.value = '#10b981'
    colorPicker.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    expect(onDraft).toHaveBeenLastCalledWith('#10B981', undefined)
  })

  it('cleans abandoned, removed, and explicitly disposed select portals before remount', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true })
    const adapter = new HostFormAdapter(dom.window.document)
    const abandoned = adapter.select('Mode', [{ label: 'Safe', value: 'safe' }], 'safe', () => undefined)
    const portal = dom.window.document.querySelector<HTMLElement>('[data-cxf-tdesign-portal-host]')!
    expect(portal.shadowRoot?.querySelectorAll('[role="listbox"]')).toHaveLength(1)
    await new Promise(resolve => dom.window.setTimeout(resolve, 30))
    expect(portal.shadowRoot?.querySelectorAll('[role="listbox"]')).toHaveLength(0)

    const mounted = adapter.select('Mode', [{ label: 'Safe', value: 'safe' }], 'safe', () => undefined)
    dom.window.document.body.append(mounted)
    await Promise.resolve()
    expect(portal.shadowRoot?.querySelectorAll('[role="listbox"]')).toHaveLength(1)
    mounted.remove()
    await new Promise(resolve => dom.window.setTimeout(resolve, 0))
    expect(portal.shadowRoot?.querySelectorAll('[role="listbox"]')).toHaveLength(0)

    const remounted = adapter.select('Mode', [{ label: 'Safe', value: 'safe' }], 'safe', () => undefined)
    dom.window.document.body.append(remounted)
    expect(portal.shadowRoot?.querySelectorAll('[role="listbox"]')).toHaveLength(1)
    remounted.dispose()
    expect(portal.shadowRoot?.querySelectorAll('[role="listbox"]')).toHaveLength(0)

    const multi = adapter.control(field({ type: 'array', role: 'multi-select', choices: [{ label: 'Safe', value: 'safe' }] }), 'multi', () => undefined)
      .root as HTMLElement & { dispose(): void }
    dom.window.document.body.append(multi)
    expect(portal.shadowRoot?.querySelectorAll('[role="listbox"]')).toHaveLength(1)
    multi.dispose()
    expect(portal.shadowRoot?.querySelectorAll('[role="listbox"]')).toHaveLength(0)
  })

  it('fails if Host renderer source reintroduces a native select element', () => {
    const renderer = join(process.cwd(), 'packages/cli/src/renderer')
    const files = readdirSync(renderer, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.ts') && entry.parentPath !== join(renderer, 'vendor'))
      .map(entry => join(entry.parentPath, entry.name))
    const violations = files.flatMap(file => {
      const source = readFileSync(file, 'utf8')
      return [
        /createElement\(\s*['"]select['"]\s*\)/gu,
        /create\([^\n]*['"]select['"]/gu,
        /<select\b/gu,
      ].flatMap(pattern => [...source.matchAll(pattern)].map(match => `${file}:${source.slice(0, match.index).split('\n').length}`))
    })
    expect(violations).toEqual([])
  })
})
