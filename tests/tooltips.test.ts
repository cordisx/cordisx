import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dismissHostTooltips, HostTooltipController } from '../packages/cli/src/renderer/tooltips.js'

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left, y: top, left, top, right: left + width, bottom: top + height, width, height,
    toJSON: () => ({}),
  } as DOMRect
}

describe('HostTooltipController', () => {
  afterEach(() => vi.useRealTimers())

  it('renders a native-token tooltip through body and clamps it inside the viewport', async () => {
    vi.useFakeTimers()
    const dom = new JSDOM('<html class="electron-dark"><body><aside style="overflow:hidden"><button id="action">action</button></aside></body></html>')
    Object.defineProperty(dom.window, 'innerWidth', { value: 300 })
    Object.defineProperty(dom.window, 'innerHeight', { value: 200 })
    const action = dom.window.document.getElementById('action')!
    Object.defineProperty(action, 'getBoundingClientRect', { value: () => rect(276, 80, 24, 24) })
    const original = dom.window.HTMLElement.prototype.getBoundingClientRect
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value() {
        return this.getAttribute('role') === 'tooltip' ? rect(0, 0, 120, 32) : original.call(this)
      },
    })
    const controller = new HostTooltipController(dom.window.document)
    controller.attach(action, () => 'Quick action', 'top')

    action.dispatchEvent(new dom.window.Event('pointerenter'))
    vi.advanceTimersByTime(650)

    const tooltip = dom.window.document.querySelector<HTMLElement>('[role="tooltip"]')!
    expect(tooltip.parentElement).toBe(dom.window.document.body)
    expect(tooltip.textContent).toBe('Quick action')
    expect(tooltip.classList.contains('bg-primary-solid')).toBe(true)
    expect(tooltip.classList.contains('text-primary-solid')).toBe(true)
    expect(tooltip.dataset.cordisxAppTheme).toBe('dark')
    expect(tooltip.style.left).toBe('172px')
    expect(tooltip.style.top).toBe('40px')
    expect(action.getAttribute('aria-describedby')).toBe(tooltip.id)
    dom.window.document.documentElement.className = 'electron-light'
    await Promise.resolve()
    expect(tooltip.dataset.cordisxAppTheme).toBe('light')

    let escapedToDocument = false
    dom.window.document.addEventListener('keydown', () => { escapedToDocument = true })
    const escape = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    action.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(true)
    expect(escapedToDocument).toBe(false)
    expect(dom.window.document.querySelector('[role="tooltip"]')).toBeNull()

    dismissHostTooltips(dom.window.document)
    expect(dom.window.document.querySelector('[role="tooltip"]')).toBeNull()
    controller.dispose()
    dom.window.close()
  })
})
