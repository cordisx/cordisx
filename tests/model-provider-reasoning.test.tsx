import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderReasoningSlider } from '../packages/cli/src/renderer/model-provider-reasoning.js'

const globals = Object.fromEntries(
  ['window', 'document', 'HTMLElement', 'Element', 'Node', 'IS_REACT_ACT_ENVIRONMENT']
    .map(key => [key, Reflect.get(globalThis, key)]),
)
const labelFor = (effort?: string) => effort ?? 'Unknown'
let root: ReturnType<typeof createRoot> | undefined
let dom: JSDOM | undefined
let reducedMotion = false

afterEach(async () => {
  await act(async () => root?.unmount())
  dom?.window.close()
  root = undefined
  dom = undefined
  reducedMotion = false
  Object.assign(globalThis, globals)
})

function renderSlider(props: Partial<React.ComponentProps<typeof ProviderReasoningSlider>> = {}) {
  dom ??= new JSDOM('<html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  Object.defineProperty(dom.window.document, 'hidden', { configurable: true, value: false })
  Object.defineProperty(dom.window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: reducedMotion,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  })
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} })
  root ??= createRoot(document.getElementById('root')!)
  const commit = props.commit ?? vi.fn(async () => undefined)
  act(() =>
    root!.render(
      <ProviderReasoningSlider
        efforts={props.efforts ?? ['low', 'high']}
        value={props.value ?? 'high'}
        disabled={props.disabled ?? false}
        pending={props.pending ?? false}
        fast={props.fast ?? false}
        label="Reasoning effort"
        labelFor={labelFor}
        commit={commit}
      />,
    )
  )
  const slider = document.querySelector<HTMLInputElement>('input[type="range"]')!
  const reasoning = slider.closest<HTMLElement>('.cxmp-reasoning')!
  Object.defineProperty(reasoning, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 100, right: 300, top: 0, bottom: 44, width: 200, height: 44, x: 100, y: 0 }),
  })
  return { commit, reasoning, slider }
}

function pointerEvent(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
  const event = new dom!.window.MouseEvent(type, init)
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 })
  return event
}

describe('ProviderReasoningSlider', () => {
  it('clears an uncommitted draft when the effort set changes', async () => {
    const { slider } = renderSlider()
    await act(async () => {
      slider.value = '0'
      slider.dispatchEvent(new dom!.window.Event('input', { bubbles: true }))
    })
    expect(slider.getAttribute('aria-valuetext')).toBe('low')
    renderSlider({ efforts: ['medium', 'high'], value: 'high' })
    expect(document.querySelector('input')?.getAttribute('aria-valuetext')).toBe('high')
  })

  it('does not submit a draft after the control becomes pending', async () => {
    const commit = vi.fn(async () => undefined)
    const { slider } = renderSlider({ commit })
    await act(async () => {
      slider.dispatchEvent(new dom!.window.Event('pointerdown', { bubbles: true }))
      slider.value = '0'
      slider.dispatchEvent(new dom!.window.Event('input', { bubbles: true }))
    })
    renderSlider({ commit, pending: true })
    await act(async () => slider.dispatchEvent(new dom!.window.Event('pointerup', { bubbles: true })))
    expect(commit).not.toHaveBeenCalled()
  })

  it('tracks pointer position continuously and commits the snapped effort on release', async () => {
    const commit = vi.fn(async () => undefined)
    const { reasoning, slider } = renderSlider({
      commit,
      efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      value: 'medium',
    })
    await act(async () => {
      reasoning.dispatchEvent(pointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 141 }))
      reasoning.dispatchEvent(pointerEvent('pointermove', { bubbles: true, clientX: 189 }))
    })
    expect(Number(reasoning.dataset.progress)).toBeCloseTo(0.4375, 4)
    expect(slider.getAttribute('aria-valuetext')).toBe('medium')
    expect(reasoning.dataset.dragging).toBe('true')
    expect(reasoning.querySelectorAll('.cxmp-reasoning-marks > [data-active="true"]')).toHaveLength(3)

    await act(async () => {
      reasoning.dispatchEvent(pointerEvent('pointerup', { bubbles: true, clientX: 260 }))
    })
    expect(commit).toHaveBeenCalledWith('high')
    expect(commit).toHaveBeenCalledTimes(1)
    expect(reasoning.hasAttribute('data-dragging')).toBe(false)
  })

  it('focuses on pointer down and keeps a click on the animated discrete path', async () => {
    const commit = vi.fn(async () => undefined)
    const { reasoning, slider } = renderSlider({
      commit,
      efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      value: 'medium',
    })
    await act(async () => {
      const pointerDown = pointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 141,
        clientY: 20,
      })
      reasoning.dispatchEvent(pointerDown)
      expect(pointerDown.defaultPrevented).toBe(true)
    })
    expect(document.activeElement).toBe(slider)
    expect(reasoning.hasAttribute('data-dragging')).toBe(false)
    expect(Number(reasoning.dataset.progress)).toBe(0.5)

    await act(async () => {
      reasoning.dispatchEvent(pointerEvent('pointermove', { bubbles: true, clientX: 144, clientY: 20 }))
    })
    expect(reasoning.hasAttribute('data-dragging')).toBe(false)
    expect(Number(reasoning.dataset.progress)).toBe(0.5)

    await act(async () => {
      reasoning.dispatchEvent(pointerEvent('pointerup', { bubbles: true, clientX: 276, clientY: 20 }))
    })
    expect(commit).toHaveBeenCalledWith('xhigh')
    expect(commit).toHaveBeenCalledTimes(1)
    expect(reasoning.hasAttribute('data-dragging')).toBe(false)
  })

  it('keeps native range keyboard semantics and commits the discrete value', async () => {
    const commit = vi.fn(async () => undefined)
    const { slider } = renderSlider({
      commit,
      efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      value: 'medium',
    })
    await act(async () => {
      slider.value = '4'
      slider.dispatchEvent(new dom!.window.Event('input', { bubbles: true }))
    })
    expect(slider.min).toBe('0')
    expect(slider.max).toBe('4')
    expect(slider.step).toBe('1')
    expect(slider.getAttribute('aria-valuetext')).toBe('xhigh')
    await act(async () => {
      slider.dispatchEvent(new dom!.window.KeyboardEvent('keyup', { bubbles: true, key: 'End' }))
    })
    expect(commit).toHaveBeenCalledWith('xhigh')
  })

  it('shows decorative particles only for the last two supported efforts or Fast', async () => {
    const efforts = ['minimal', 'low', 'medium', 'high', 'xhigh']
    const { reasoning } = renderSlider({ efforts, value: 'minimal' })
    const marks = reasoning.querySelectorAll('.cxmp-reasoning-marks > span')
    expect(marks).toHaveLength(5)
    for (const value of ['minimal', 'low', 'medium']) {
      renderSlider({ efforts, value })
      expect(reasoning.hasAttribute('data-particles')).toBe(false)
      expect(reasoning.hasAttribute('data-flowing')).toBe(false)
    }
    for (const value of ['high', 'xhigh']) {
      renderSlider({ efforts, value })
      expect(reasoning.dataset.particles).toBe('true')
      expect(reasoning.dataset.flowing).toBe('true')
    }
    renderSlider({ efforts, value: 'minimal', fast: true })
    expect(reasoning.dataset.particles).toBe('true')
    expect(reasoning.dataset.flowing).toBe('true')
    expect(reasoning.querySelectorAll('.cxmp-reasoning-marks > span')).toHaveLength(5)
    renderSlider({ efforts, value: 'xhigh', pending: true })
    expect(reasoning.hasAttribute('data-particles')).toBe(false)
    renderSlider({ efforts, value: 'unknown' })
    expect(reasoning.hasAttribute('data-particles')).toBe(false)

    await act(async () => root?.unmount())
    root = undefined
    reducedMotion = true
    renderSlider({ efforts, value: 'xhigh', fast: true })
    const reduced = document.querySelector<HTMLElement>('.cxmp-reasoning')!
    expect(reduced.dataset.particles).toBe('true')
    expect(reduced.hasAttribute('data-flowing')).toBe(false)
    expect(reduced.querySelectorAll('.cxmp-reasoning-particle')).toHaveLength(0)
    expect(reduced.querySelectorAll('.cxmp-reasoning-marks > span')).toHaveLength(5)
  })

  it('stops the particle flow while the page is hidden', async () => {
    const { reasoning } = renderSlider({ fast: true, value: 'low' })
    expect(reasoning.dataset.flowing).toBe('true')
    Object.defineProperty(dom!.window.document, 'hidden', { configurable: true, value: true })
    await act(async () => document.dispatchEvent(new dom!.window.Event('visibilitychange')))
    expect(reasoning.hasAttribute('data-flowing')).toBe(false)
    expect(reasoning.querySelectorAll('.cxmp-reasoning-particle')).toHaveLength(0)
  })
})
