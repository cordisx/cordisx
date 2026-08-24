import { JSDOM } from 'jsdom'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CordisXConfigFieldSnapshot } from '../packages/cli/src/contracts.js'
import {
  HOST_FORM_STYLES,
  HostFormAdapter,
  hostConfigApplyMessage,
  hostFormDiagnostic,
  selectHostFormPrimitive,
  validateHostFormValue,
} from '../packages/cli/src/renderer/host-form.js'

function field(overrides: Partial<CordisXConfigFieldSnapshot> = {}): CordisXConfigFieldSnapshot {
  return {
    namespace: 'fixture', path: ['value'], type: 'string', value: '', disabled: false, required: false, ...overrides,
  }
}

describe('Host form primitive registry', () => {
  it('selects every bounded primitive without exposing a library or renderer choice', () => {
    expect(selectHostFormPrimitive(field())).toBe('input')
    expect(selectHostFormPrimitive(field({ role: 'textarea' }))).toBe('textarea')
    expect(selectHostFormPrimitive(field({ type: 'number', value: 1 }))).toBe('number-input')
    expect(selectHostFormPrimitive(field({ choices: [{ label: 'Safe', value: 'safe' }] }))).toBe('select')
    expect(selectHostFormPrimitive(field({ role: 'radio', choices: [{ label: 'Safe', value: 'safe' }] }))).toBe('radio')
    expect(selectHostFormPrimitive(field({ type: 'boolean', value: false }))).toBe('checkbox')
    expect(selectHostFormPrimitive(field({ type: 'boolean', role: 'switch', value: false }))).toBe('switch')
    expect(selectHostFormPrimitive(field({ type: 'number', role: 'slider', value: 5 }))).toBe('slider')
    expect(selectHostFormPrimitive(field({ role: 'date' }))).toBe('unsupported')
    expect(selectHostFormPrimitive(field({ role: 'time' }))).toBe('unsupported')
    expect(selectHostFormPrimitive(field({ role: 'color' }))).toBe('unsupported')
    expect(selectHostFormPrimitive(field({ type: 'array', role: 'multi-select', value: ['design'] }))).toBe('unsupported')
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
    expect(hostFormDiagnostic(field({ role: 'date' }))).toEqual({
      code: 'unsupported-schema-role', fieldPath: ['value'],
      detail: 'unsupported schema role date; no native control fallback is permitted',
    })
    expect(hostFormDiagnostic(field({ type: 'array', role: 'multi-select', value: ['design'] }))).toEqual({
      code: 'unsupported-schema-role', fieldPath: ['value'],
      detail: 'unsupported schema role multi-select; no native control fallback is permitted',
    })
  })

  it('validates required, finite numeric, natural, range, and choice constraints', () => {
    expect(validateHostFormValue(field({ required: true }), '')).toBe('此项为必填项')
    expect(validateHostFormValue(field({ type: 'number', value: 0 }), Number.NaN)).toBe('请输入有效数字')
    expect(validateHostFormValue(field({ type: 'natural', value: 0 }), -1)).toBe('请输入非负整数')
    expect(validateHostFormValue(field({ type: 'number', value: 2, min: 2 }), 1)).toBe('不能小于 2')
    expect(validateHostFormValue(field({ type: 'number', value: 2, max: 3 }), 4)).toBe('不能大于 3')
    expect(validateHostFormValue(field({ type: 'number', value: 2, min: 1, step: 2 }), 2)).toBe('请按 2 的步长输入')
    expect(validateHostFormValue(field({ choices: [{ label: 'Safe', value: 'safe' }] }), 'fast')).toBe('请选择列表中的有效值')
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
  })
})

describe('Host form DOM and accessibility', () => {
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

    const range = control.root as HTMLElement & { value?: number; onChange?: (value: number) => void }
    expect(form.classList.contains('cxf-scope')).toBe(true)
    expect(item.label.htmlFor).toBe('duration')
    expect(item.root.querySelector('.cxf-required')?.getAttribute('aria-hidden')).toBe('true')
    expect(range.tagName).toBe('T-SLIDER')
    expect(range.dataset.tdesignVersion).toBe('1.2.10')
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
    expect(adapter.control(field({ role: 'date' }), 'date', () => undefined).root.textContent)
      .toContain('cannot be edited safely')
    const onDraft = vi.fn()
    const json = adapter.control(field({ type: 'object', value: {} }), 'json', onDraft).root as HTMLElement & { onChange?: (value: string) => void }
    json.onChange?.('{')
    expect(onDraft).toHaveBeenLastCalledWith(undefined, 'Enter valid JSON')
    locale = 'zh-CN'
    expect(adapter.control(field({ role: 'secret' }), 'secret-zh', () => undefined).root.textContent)
      .toContain('Host 凭据边界')
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
    expect(HOST_FORM_STYLES).toContain('[data-cordisx-app-theme="dark"] .cxf-scope { color-scheme: dark; }')
    expect(HOST_FORM_STYLES).toContain('.cxf-tdesign-control { display: inline-block;')
    expect(HOST_FORM_STYLES).not.toMatch(/t-select\.cxf-tdesign-control:focus-visible/u)
    expect(HOST_FORM_STYLES).toContain('.cxf-tdesign-control:focus-visible { outline: 2px solid Highlight;')
    expect(HOST_FORM_STYLES).toContain('.cxf-scope:dir(rtl)')
    expect(HOST_FORM_STYLES).toContain('@media (forced-colors: active)')
    expect(HOST_FORM_STYLES).toContain('inline-size: 100%; min-inline-size: 0; margin: 0;')
    expect(HOST_FORM_STYLES).toContain('.cxf-form-grid')
    expect(HOST_FORM_STYLES).toContain('@media (max-width: 760px)')
    expect(HOST_FORM_STYLES).not.toMatch(/(^|[\s,{])(:root|html|body|\*)\s*[{,]/u)
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
