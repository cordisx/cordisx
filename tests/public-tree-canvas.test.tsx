import React, { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from 'vitest'
import { PanZoomCanvas } from '../packages/cli/src/renderer/host-ui/PanZoomCanvas.js'
import { installSharedReactRuntime } from '../packages/cli/src/renderer/react-runtime.js'
import type { PanZoomCanvasHandle } from '../packages/cli/src/ui.js'

const previous = {
  document: globalThis.document,
  window: globalThis.window,
  MutationObserver: globalThis.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
}

afterEach(() => Object.assign(globalThis, previous))

function installDom(): JSDOM {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'https://host.invalid/',
  })
  Object.assign(globalThis, {
    document: dom.window.document,
    window: dom.window,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  return dom
}

function defineGeometry(viewport: HTMLElement, content: HTMLElement): void {
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, value: 800 },
    clientHeight: { configurable: true, value: 600 },
  })
  Object.defineProperties(content, {
    scrollWidth: { configurable: true, value: 1000 },
    scrollHeight: { configurable: true, value: 500 },
  })
  viewport.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    toJSON: () => ({}),
  })
}

function pointer(dom: JSDOM, type: string, pointerId: number, clientX: number, clientY: number): Event {
  const event = new dom.window.MouseEvent(type, { bubbles: true, button: 0, clientX, clientY })
  Object.defineProperty(event, 'pointerId', { value: pointerId })
  return event
}

describe('public Select and PanZoomCanvas', () => {
  it('uses Host icons for Select prefix, semantic filters, and caret without a CSS glyph', async () => {
    const dom = installDom()
    const runtime = installSharedReactRuntime(dom.window.document)
    const root = createRoot(dom.window.document.getElementById('root')!)
    try {
      await act(async () =>
        root.render(
          <runtime.ui.Select
            aria-label="Role"
            density="compact"
            prefixIcon={<runtime.ui.Icon name="role" />}
            value="all"
            options={[{ value: 'all', label: 'All roles' }]}
            onChange={() => {}}
          />,
        )
      )
      expect(dom.window.document.querySelector('[data-host-icon="host:people"]')).not.toBeNull()
      expect(dom.window.document.querySelector('[data-host-icon-key="control.chevron-down"]')).not.toBeNull()
      const caret = dom.window.document.querySelector('[data-host-icon-key="control.chevron-down"] svg')!
      expect(caret.querySelector('path')?.getAttribute('d')).toBe('M20.3333 8.6666 L12 17 L3.6667 8.6666')
      expect(caret.innerHTML).not.toContain('L12.75 18.1893')
      expect(dom.window.document.querySelector('.cxr-ui-select')?.getAttribute('data-density')).toBe('compact')
      expect(dom.window.document.querySelector('.cxr-ui-select')?.classList.contains('cxr-ui-filter-control')).toBe(
        true,
      )
      const style = dom.window.document.querySelector('style[data-cordisx-shared-react]')?.textContent ?? ''
      expect(style).not.toContain('content:"⌄"')

      await act(async () =>
        root.render(
          <>
            <runtime.ui.Icon name="session" />
            <runtime.ui.Icon name="relationship" />
          </>,
        )
      )
      expect(dom.window.document.querySelector('[data-host-icon="host:history"]')).not.toBeNull()
      expect(dom.window.document.querySelector('[data-host-icon="host:hierarchy"]')).not.toBeNull()
    } finally {
      await act(async () => root.unmount())
      runtime.dispose()
      dom.window.close()
    }
  })

  it('zooms around the pointer, clamps input, and prevents wheel propagation', async () => {
    const dom = installDom()
    const root = createRoot(dom.window.document.getElementById('root')!)
    const controller = createRef<PanZoomCanvasHandle>()
    try {
      await act(async () =>
        root.render(
          <PanZoomCanvas aria-label="Team canvas" minScale={0.5} maxScale={1.5} controllerRef={controller}>
            <div>Tree</div>
          </PanZoomCanvas>,
        )
      )
      const viewport = dom.window.document.querySelector<HTMLElement>('.cxr-ui-pan-zoom-canvas')!
      const content = dom.window.document.querySelector<HTMLElement>('.cxr-ui-pan-zoom-canvas__content')!
      defineGeometry(viewport, content)
      let bubbled = false
      dom.window.document.body.addEventListener('wheel', () => bubbled = true)
      const zoomIn = new dom.window.WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: -10000,
        clientX: 200,
        clientY: 100,
      })
      await act(async () => void viewport.dispatchEvent(zoomIn))
      expect(bubbled).toBe(false)
      expect(zoomIn.defaultPrevented).toBe(true)
      expect(controller.current?.getScale()).toBeCloseTo(Math.exp(0.12))
      expect(viewport.dataset.scale).toBe('1.127')
      for (let index = 0; index < 20; index += 1) {
        await act(async () =>
          void viewport.dispatchEvent(
            new dom.window.WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              deltaY: -10000,
              clientX: 200,
              clientY: 100,
            }),
          )
        )
      }
      expect(controller.current?.getScale()).toBe(1.5)
      for (let index = 0; index < 30; index += 1) {
        await act(async () =>
          void viewport.dispatchEvent(
            new dom.window.WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              deltaY: 10000,
              clientX: 200,
              clientY: 100,
            }),
          )
        )
      }
      expect(controller.current?.getScale()).toBe(0.5)
    } finally {
      await act(async () => root.unmount())
      dom.window.close()
    }
  })

  it('captures drag and exposes keyboard, fit, reset, and accessible focus', async () => {
    const dom = installDom()
    const root = createRoot(dom.window.document.getElementById('root')!)
    const controller = createRef<PanZoomCanvasHandle>()
    try {
      await act(async () =>
        root.render(
          <PanZoomCanvas aria-label="Team canvas" minScale={0.25} maxScale={2} controllerRef={controller}>
            <div>Tree</div>
          </PanZoomCanvas>,
        )
      )
      const viewport = dom.window.document.querySelector<HTMLElement>('.cxr-ui-pan-zoom-canvas')!
      const content = dom.window.document.querySelector<HTMLElement>('.cxr-ui-pan-zoom-canvas__content')!
      defineGeometry(viewport, content)
      let captured: number | undefined
      let clicks = 0
      viewport.addEventListener('click', () => clicks += 1)
      Object.assign(viewport, {
        setPointerCapture: (value: number) => captured = value,
        hasPointerCapture: (value: number) => captured === value,
        releasePointerCapture: () => captured = undefined,
      })
      await act(async () => viewport.dispatchEvent(pointer(dom, 'pointerdown', 6, 100, 100)))
      await act(async () => viewport.dispatchEvent(pointer(dom, 'pointermove', 6, 102, 102)))
      expect(content.style.transform).toContain('translate(0px,0px)')
      await act(async () => viewport.dispatchEvent(pointer(dom, 'pointerup', 6, 102, 102)))
      const retainedClick = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })
      await act(async () => void viewport.dispatchEvent(retainedClick))
      expect(retainedClick.defaultPrevented).toBe(false)
      expect(clicks).toBe(1)

      await act(async () => viewport.dispatchEvent(pointer(dom, 'pointerdown', 7, 100, 100)))
      await act(async () => viewport.dispatchEvent(pointer(dom, 'pointermove', 7, 160, 140)))
      expect(captured).toBe(7)
      expect(viewport.dataset.dragging).toBe('true')
      expect(content.style.transform).toContain('translate(60px,40px)')
      await act(async () => viewport.dispatchEvent(pointer(dom, 'pointerup', 7, 160, 140)))
      expect(captured).toBeUndefined()
      const suppressed = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })
      await act(async () => void viewport.dispatchEvent(suppressed))
      expect(suppressed.defaultPrevented).toBe(true)
      expect(clicks).toBe(1)
      expect(viewport.dataset.dragging).toBe('false')

      viewport.focus()
      await act(async () =>
        viewport.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: '+', bubbles: true }))
      )
      expect(controller.current?.getScale()).toBeCloseTo(1.15)
      await act(async () =>
        viewport.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      )
      expect(content.style.transform).toContain('translate(')

      await act(async () => controller.current?.fitToView())
      expect(controller.current?.getScale()).toBe(0.8)
      expect(content.style.transform).toContain('translate(0px,100px) scale(0.8)')
      await act(async () => controller.current?.reset())
      expect(controller.current?.getScale()).toBe(1)
      expect(viewport.getAttribute('role')).toBe('region')
      expect(viewport.getAttribute('aria-keyshortcuts')).toContain('ArrowUp')
      expect(viewport.tabIndex).toBe(0)
    } finally {
      await act(async () => root.unmount())
      dom.window.close()
    }
  })

  it('establishes an explicit full-height Host seat inside a Manager page', async () => {
    const dom = installDom()
    const runtime = installSharedReactRuntime(dom.window.document)
    const managerContent = dom.window.document.createElement('main')
    managerContent.className = 'cxr-content'
    managerContent.style.height = '767px'
    const pageRoot = dom.window.document.getElementById('root')!
    pageRoot.className = 'cxr-react-root'
    managerContent.append(pageRoot)
    dom.window.document.body.append(managerContent)
    const root = createRoot(pageRoot)
    try {
      await act(async () =>
        root.render(
          <PanZoomCanvas fill aria-label="Team canvas">
            <div style={{ width: 1200, height: 700 }}>Tree</div>
          </PanZoomCanvas>,
        )
      )
      const canvas = pageRoot.querySelector<HTMLElement>('.cxr-ui-pan-zoom-canvas')!
      expect(canvas.dataset.fill).toBe('true')
      expect(pageRoot.matches('.cxr-react-root:has(.cxr-ui-pan-zoom-canvas[data-fill="true"])')).toBe(true)
      const style = dom.window.document.querySelector('style[data-cordisx-shared-react]')?.textContent ?? ''
      expect(style).toContain(
        '.cxr-react-root:has(.cxr-ui-pan-zoom-canvas[data-fill="true"]){height:100%;min-height:0;overflow:hidden}',
      )
      expect(style).toContain('.cxr-ui-pan-zoom-canvas{position:relative;width:100%;height:100%')
    } finally {
      await act(async () => root.unmount())
      runtime.dispose()
      dom.window.close()
    }
  })

  it('renders fixed standard canvas controls outside transformed content', async () => {
    const dom = installDom()
    const root = createRoot(dom.window.document.getElementById('root')!)
    let fitted = 0
    let reset = 0
    try {
      await act(async () =>
        root.render(
          <PanZoomCanvas
            aria-label="Team canvas"
            controls={{
              fitLabel: 'Fit team',
              resetLabel: 'Reset view',
              onFit: () => fitted += 1,
              onReset: () => reset += 1,
            }}
          >
            <div>Tree</div>
          </PanZoomCanvas>,
        )
      )
      const viewport = dom.window.document.querySelector<HTMLElement>('.cxr-ui-pan-zoom-canvas')!
      const toolbar = viewport.querySelector<HTMLElement>(':scope > .cxr-ui-action-toolbar')!
      expect(toolbar.closest('.cxr-ui-pan-zoom-canvas__content')).toBeNull()
      expect(toolbar.querySelectorAll('.cxr-ui-icon-action')).toHaveLength(2)
      expect(toolbar.querySelector('[data-host-icon="host:fit"]')).not.toBeNull()
      expect(toolbar.querySelector('[data-host-icon="host:reset"]')).not.toBeNull()
      await act(async () => (toolbar.querySelector('[aria-label="Fit team"]') as HTMLButtonElement).click())
      await act(async () => (toolbar.querySelector('[aria-label="Reset view"]') as HTMLButtonElement).click())
      expect(fitted).toBe(1)
      expect(reset).toBe(1)
    } finally {
      await act(async () => root.unmount())
      dom.window.close()
    }
  })

  it('renders a connected search and compact filter group with Host icons', async () => {
    const dom = installDom()
    const runtime = installSharedReactRuntime(dom.window.document)
    const root = createRoot(dom.window.document.getElementById('root')!)
    try {
      await act(async () =>
        root.render(
          <runtime.ui.FilterToolbar
            aria-label="Team filters"
            search={<runtime.ui.SearchField aria-label="Search team" value="" onChange={() => {}} />}
            filters={[
              <runtime.ui.Select
                key="role"
                aria-label="Role"
                density="compact"
                prefixIcon={<runtime.ui.Icon name="role" />}
                value="all"
                options={[{ value: 'all', label: 'All roles' }]}
                onChange={() => {}}
              />,
            ]}
          />,
        )
      )
      const toolbar = dom.window.document.querySelector<HTMLElement>('.cxr-ui-filter-toolbar')!
      expect(toolbar.getAttribute('role')).toBe('toolbar')
      expect(toolbar.querySelector('.cxr-ui-filter-toolbar__search input[type="search"]')).not.toBeNull()
      expect(toolbar.querySelector('[data-host-icon-key="search"]')).not.toBeNull()
      expect(toolbar.querySelector('.cxr-ui-filter-toolbar__filters > .cxr-ui-select')).not.toBeNull()
      expect(toolbar.querySelector('[data-host-icon="host:people"]')).not.toBeNull()
      expect(toolbar.querySelector('[data-host-icon-key="control.chevron-down"]')).not.toBeNull()
      const style = dom.window.document.querySelector('style[data-cordisx-shared-react]')?.textContent ?? ''
      expect(style).toContain('border-inline-start:1px solid var(--cx-border)')
      expect(style).toContain('.cxr-ui-filter-search__icon{display:grid;inline-size:16px')
    } finally {
      await act(async () => root.unmount())
      runtime.dispose()
      dom.window.close()
    }
  })
})
