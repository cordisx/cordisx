import React, { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostMenuSurface } from '../packages/cli/src/renderer/host-ui/HostMenu.js'

const globalKeys = [
  'window',
  'document',
  'HTMLElement',
  'Element',
  'Node',
  'MutationObserver',
  'IS_REACT_ACT_ENVIRONMENT',
]
const originalGlobals = new Map(globalKeys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
let dom: JSDOM
let root: Root | undefined
let anchor: HTMLButtonElement

beforeEach(() => {
  dom = new JSDOM(
    '<html data-theme="light"><body><button id="anchor">Open</button><div id="root"></div><button id="outside">Outside</button></body></html>',
  )
  for (const key of globalKeys) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : key === 'window' ? dom.window : Reflect.get(dom.window, key),
    })
  }
  // React loads before JSDOM and selects its legacy input-event adapter.
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} })
  anchor = document.querySelector<HTMLButtonElement>('#anchor')!
  root = createRoot(document.querySelector('#root')!)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  vi.restoreAllMocks()
  dom.window.close()
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

const choices = (
  <>
    <button role="menuitem" id="first">First</button>
    <button role="menuitem" id="disabled" disabled>Disabled</button>
    <button role="menuitemradio" aria-checked="false" id="second">Second</button>
    <button role="menuitem" id="last">Last</button>
  </>
)

async function renderMenu(
  children: ReactNode = choices,
  onClose = vi.fn(),
  open = true,
  canFocus?: () => boolean,
  align?: 'start' | 'end',
) {
  await act(async () => {
    root!.render(
      <HostMenuSurface
        open={open}
        label="Test menu"
        anchorRef={{ current: anchor }}
        returnFocusRef={{ current: anchor }}
        align={align}
        onClose={onClose}
        canFocus={canFocus}
      >
        {children}
      </HostMenuSurface>,
    )
  })
  return { menu: document.querySelector<HTMLElement>('[role="menu"]')!, onClose }
}

async function press(key: string) {
  const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  await act(async () => {
    document.activeElement!.dispatchEvent(event)
  })
  return event
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return new dom.window.DOMRect(left, top, width, height)
}

describe('HostMenuSurface behavior', () => {
  it('checks current focus eligibility for initial focus and both queued Escape restorations', async () => {
    const outside = document.querySelector<HTMLButtonElement>('#outside')!
    outside.focus()
    await renderMenu(choices, vi.fn(), true, () => false)
    expect(document.activeElement).toBe(outside)
    let frame: FrameRequestCallback | undefined
    Object.defineProperty(dom.window, 'requestAnimationFrame', {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        frame = callback
        return 1
      },
    })
    let allowed = true
    await renderMenu(choices, vi.fn(), true, () => allowed)
    await act(async () => {
      document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      allowed = false
      outside.focus()
    })
    expect(document.activeElement).toBe(outside)
    await renderMenu(choices, vi.fn(), false, () => false)
    frame?.(0)
    expect(document.activeElement).toBe(outside)
  })

  it('portals into the body and navigates enabled menu items with wrapping, Home and End', async () => {
    const { menu } = await renderMenu()
    expect(menu.parentElement).toBe(document.body)
    expect(menu.getAttribute('aria-label')).toBe('Test menu')
    expect(document.activeElement?.id).toBe('first')
    const ancestorKeyDown = vi.fn()
    document.addEventListener('keydown', ancestorKeyDown)
    for (
      const [key, expected] of [
        ['ArrowDown', 'second'],
        ['ArrowDown', 'last'],
        ['ArrowDown', 'first'],
        ['ArrowUp', 'last'],
        ['ArrowUp', 'second'],
        ['ArrowUp', 'first'],
        ['End', 'last'],
        ['Home', 'first'],
      ]
    ) {
      expect((await press(key!)).defaultPrevented).toBe(true)
      expect(document.activeElement?.id).toBe(expected)
    }
    expect(ancestorKeyDown).not.toHaveBeenCalled()
    document.removeEventListener('keydown', ancestorKeyDown)
  })

  it('honors an enabled initial focus marker and skips a disabled marker', async () => {
    await renderMenu(
      <>
        {choices}
        <button role="menuitem" data-menu-initial="true" id="initial">Initial</button>
      </>,
    )
    expect(document.activeElement?.id).toBe('initial')
    await renderMenu(null, vi.fn(), false)
    await renderMenu(
      <>
        <button role="menuitem" data-menu-initial="true" disabled>Unavailable</button>
        {choices}
      </>,
    )
    expect(document.activeElement?.id).toBe('first')
  })

  it('closes only for pointerdown outside the portal and anchor', async () => {
    const { menu, onClose } = await renderMenu()
    for (const target of [menu, menu.querySelector('#second')!, anchor]) {
      await act(async () => {
        target.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }))
      })
    }
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => {
      document.querySelector('#outside')!.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('restores the anchor on Escape without propagating to the surrounding surface', async () => {
    const { onClose } = await renderMenu()
    const ancestorKeyDown = vi.fn()
    document.addEventListener('keydown', ancestorKeyDown)
    expect((await press('Escape')).defaultPrevented).toBe(true)
    expect(onClose).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(anchor)
    expect(ancestorKeyDown).not.toHaveBeenCalled()
    document.removeEventListener('keydown', ancestorKeyDown)
  })

  it('repositions on viewport resize and captured nested scroll with edge clamping', async () => {
    Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 800 })
    Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 600 })
    let anchorRect = rect(700, 400, 80, 28)
    vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function() {
      return this === anchor ? anchorRect : rect(0, 0, 200, 120)
    })
    const { menu } = await renderMenu()
    expect(menu.style.left).toBe('592px')
    expect(menu.style.top).toBe('394px')
    expect(menu.style.transform).toBe('translateY(-100%)')
    anchorRect = rect(100, 20, 80, 28)
    Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 250 })
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event('resize'))
    })
    expect(menu.style.left).toBe('42px')
    expect(menu.style.top).toBe('54px')
    anchorRect = rect(-20, 500, 80, 28)
    await act(async () => {
      anchor.dispatchEvent(new dom.window.Event('scroll', { bubbles: false }))
    })
    expect(menu.style.left).toBe('8px')
    expect(menu.style.top).toBe('494px')
    expect(menu.style.transform).toBe('translateY(-100%)')
  })

  it('tracks animated content size against the same anchor side without duplicate focus', async () => {
    Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 800 })
    Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 600 })
    let menuHeight = 120
    vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function() {
      return this === anchor ? rect(600, 400, 80, 28) : rect(0, 0, 200, menuHeight)
    })
    let resize!: () => void
    const disconnectObserver = vi.fn()
    Object.defineProperty(dom.window, 'ResizeObserver', {
      configurable: true,
      value: class {
        constructor(callback: () => void) {
          resize = callback
        }
        observe() {}
        disconnect = disconnectObserver
      },
    })
    let frame: FrameRequestCallback | undefined
    const cancel = vi.fn()
    Object.defineProperty(dom.window, 'requestAnimationFrame', {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        frame = callback
        return 7
      },
    })
    Object.defineProperty(dom.window, 'cancelAnimationFrame', { configurable: true, value: cancel })
    const focus = vi.spyOn(dom.window.HTMLElement.prototype, 'focus')
    const { menu } = await renderMenu(choices, vi.fn(), true, undefined, 'end')
    expect(menu.style.left).toBe('480px')
    expect(menu.style.top).toBe('394px')
    expect(menu.style.transform).toBe('translateY(-100%)')
    expect(menu.style.getPropertyValue('--cxhm-available-height')).toBe('386px')
    expect(focus).toHaveBeenCalledOnce()

    menuHeight = 180
    resize()
    resize()
    expect(frame).toBeDefined()
    frame?.(0)
    expect(menu.style.top).toBe('394px')
    expect(focus).toHaveBeenCalledOnce()

    menuHeight = 90
    resize()
    await act(async () => root!.unmount())
    root = undefined
    expect(cancel).toHaveBeenCalledWith(7)
    expect(disconnectObserver).toHaveBeenCalledOnce()
  })

  it('removes portal, position and outside listeners, and theme observation on unmount', async () => {
    const addWindow = vi.spyOn(dom.window, 'addEventListener')
    const removeWindow = vi.spyOn(dom.window, 'removeEventListener')
    const addDocument = vi.spyOn(document, 'addEventListener')
    const removeDocument = vi.spyOn(document, 'removeEventListener')
    const disconnect = vi.spyOn(dom.window.MutationObserver.prototype, 'disconnect')
    const measure = vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(100, 200, 80, 28))
    const { menu, onClose } = await renderMenu()
    const resize = addWindow.mock.calls.find(([type]) => type === 'resize')!
    const scroll = addDocument.mock.calls.find(([type]) => type === 'scroll')!
    const outside = addDocument.mock.calls.find(([type]) => type === 'pointerdown')!
    expect(resize).toBeDefined()
    expect(scroll).toBeDefined()
    expect(outside).toBeDefined()
    expect(menu.getAttribute('data-cordisx-app-theme')).toBe('light')
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(removeWindow).toHaveBeenCalledWith('resize', resize[1])
    expect(removeDocument).toHaveBeenCalledWith('scroll', scroll[1], true)
    expect(removeDocument).toHaveBeenCalledWith('pointerdown', outside[1], true)
    expect(disconnect).toHaveBeenCalled()
    expect(menu.hasAttribute('data-cordisx-app-theme')).toBe(false)
    expect(menu.style.getPropertyValue('--cx-surface')).toBe('')
    measure.mockClear()
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event('resize'))
      anchor.dispatchEvent(new dom.window.Event('scroll'))
      document.body.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }))
      document.documentElement.setAttribute('data-theme', 'dark')
      await Promise.resolve()
    })
    expect(measure).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(menu.hasAttribute('data-cordisx-app-theme')).toBe(false)
  })

  it.each(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'])(
    'leaves %s to the focused range input without taking its focus',
    async key => {
      await renderMenu(
        <>
          {choices}
          <input type="range" aria-label="Reasoning effort" />
        </>,
      )
      const range = document.querySelector<HTMLInputElement>('input[type="range"]')!
      range.focus()
      expect((await press(key)).defaultPrevented).toBe(false)
      expect(document.activeElement).toBe(range)
    },
  )

  it.each([['empty', null], ['all disabled', <button role="menuitem" disabled>Unavailable</button>]])(
    'focuses the menu itself when %s and still allows Escape',
    async (_name, children) => {
      const { menu, onClose } = await renderMenu(children)
      expect(menu.tabIndex).toBe(-1)
      expect(document.activeElement).toBe(menu)
      for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
        await press(key)
        expect(document.activeElement).toBe(menu)
      }
      await press('Escape')
      expect(onClose).toHaveBeenCalledOnce()
      expect(document.activeElement).toBe(anchor)
    },
  )
})
