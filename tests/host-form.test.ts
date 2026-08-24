import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import type { CordisXConfigFieldSnapshot } from '../packages/cli/src/contracts.js'
import {
  HOST_FORM_STYLES,
  HostFormAdapter,
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
    expect(selectHostFormPrimitive(field({ role: 'date' }))).toBe('date')
    expect(selectHostFormPrimitive(field({ role: 'time' }))).toBe('time')
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
})

describe('Host form DOM and accessibility', () => {
  it('projects labels, help, errors, required state, native keyboard controls, and draft events', () => {
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

    const range = control.root as HTMLInputElement
    expect(form.classList.contains('cxf-scope')).toBe(true)
    expect(item.label.htmlFor).toBe('duration')
    expect(item.root.querySelector('.cxf-required')?.getAttribute('aria-hidden')).toBe('true')
    expect(range.type).toBe('range')
    expect(range.getAttribute('aria-required')).toBe('true')
    expect(range.getAttribute('aria-describedby')).toContain('duration-help')
    range.value = '45'
    range.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    expect(onDraft).toHaveBeenCalledWith(45, undefined)
    item.setError('保存前请修正')
    expect(range.getAttribute('aria-invalid')).toBe('true')
    expect(item.error.hidden).toBe(false)
  })

  it('uses native switch/radio semantics and redacts sensitive fields', () => {
    const dom = new JSDOM('<!doctype html><body></body>')
    const adapter = new HostFormAdapter(dom.window.document)
    const switchControl = adapter.control(field({ type: 'boolean', role: 'switch', value: true }), 'enabled', () => undefined)
    const radio = adapter.control(field({ role: 'radio', value: 'safe', choices: [
      { label: 'Safe', value: 'safe' }, { label: 'Fast', value: 'fast' },
    ] }), 'mode', () => undefined)
    const secret = adapter.control(field({ role: 'credential', value: undefined, disabled: true }), 'credential', () => undefined)
    expect(switchControl.root.querySelector('input')?.getAttribute('role')).toBe('switch')
    expect(radio.root.getAttribute('role')).toBe('radiogroup')
    expect(radio.root.querySelectorAll('input[type="radio"]')).toHaveLength(2)
    expect(secret.root.getAttribute('role')).toBe('status')
    expect(secret.root.querySelector('input,textarea,select')).toBeNull()
    expect(secret.root.textContent).not.toContain('undefined')
    const switchInput = switchControl.focusTarget as HTMLInputElement
    switchInput.checked = false
    switchInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    expect(switchControl.root.textContent).toBe('已关闭')
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

  it('keeps TDesign-aligned tokens and every rule scoped to CordisX form classes', () => {
    expect(HOST_FORM_STYLES).toContain('--td-brand-color: var(--cx-primary)')
    expect(HOST_FORM_STYLES).toContain('.cxf-scope:dir(rtl)')
    expect(HOST_FORM_STYLES).toContain('@media (forced-colors: active)')
    expect(HOST_FORM_STYLES).toContain('grid-template-columns: repeat(2')
    expect(HOST_FORM_STYLES).toContain('@media (max-width: 760px)')
    expect(HOST_FORM_STYLES).not.toMatch(/(^|[\s,{])(:root|html|body|\*)\s*[{,]/u)
  })
})
