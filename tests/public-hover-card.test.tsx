import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HoverCard } from '../packages/cli/src/renderer/host-ui/HoverCard.js'

interface TestGlobals {
  readonly document: typeof globalThis.document
  readonly window: typeof globalThis.window
  readonly MutationObserver: typeof globalThis.MutationObserver
  readonly IS_REACT_ACT_ENVIRONMENT: typeof globalThis.IS_REACT_ACT_ENVIRONMENT
}

const previous: TestGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  MutationObserver: globalThis.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
}

afterEach(() => {
  vi.useRealTimers()
  Object.assign(globalThis, previous)
})

function installDom(coarse = false): JSDOM {
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><body><div id="root"></div></body></html>', {
    url: 'https://host.invalid/',
    pretendToBeVisual: true,
  })
  Object.defineProperty(dom.window, 'matchMedia', {
    value: (query: string) => ({
      matches: query === '(pointer: coarse)' ? coarse : query.includes('dark'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
  })
  Object.assign(globalThis, {
    document: dom.window.document,
    window: dom.window,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  return dom
}

function card(root: ReturnType<typeof createRoot>, onClick?: () => void) {
  return act(async () =>
    root.render(
      <HoverCard
        aria-label="Lead information"
        trigger={<button type="button" onClick={onClick}>Lead</button>}
        content={<div data-card-body="true">Coordinates the room.</div>}
      />,
    )
  )
}

describe('public HoverCard', () => {
  it('uses Host delay tokens and keeps the portal open while the pointer moves into the card', async () => {
    vi.useFakeTimers()
    const dom = installDom()
    const root = createRoot(dom.window.document.getElementById('root')!)
    try {
      await card(root)
      const trigger = dom.window.document.querySelector<HTMLElement>('.cxr-ui-hover-card__trigger')!
      expect(trigger.tagName).toBe('BUTTON')
      expect(dom.window.document.querySelectorAll('[tabindex]')).toHaveLength(1)
      await act(async () => trigger.dispatchEvent(new dom.window.MouseEvent('pointerover', { bubbles: true })))
      await act(async () => vi.advanceTimersByTime(399))
      expect(dom.window.document.querySelector('[role="tooltip"]')).toBeNull()
      await act(async () => vi.advanceTimersByTime(1))
      const overlay = dom.window.document.querySelector<HTMLElement>('[role="tooltip"]')!
      expect(overlay.textContent).toBe('Coordinates the room.')
      expect(trigger.getAttribute('aria-describedby')).toBe(overlay.id)

      await act(async () => {
        trigger.dispatchEvent(new dom.window.MouseEvent('pointerout', { bubbles: true, relatedTarget: overlay }))
        overlay.dispatchEvent(new dom.window.MouseEvent('pointerover', { bubbles: true, relatedTarget: trigger }))
        vi.advanceTimersByTime(120)
      })
      expect(dom.window.document.querySelector('[role="tooltip"]')).toBe(overlay)

      await act(async () => {
        overlay.dispatchEvent(new dom.window.MouseEvent('pointerout', { bubbles: true }))
        vi.advanceTimersByTime(120)
      })
      expect(dom.window.document.querySelector('[role="tooltip"]')).toBeNull()
      expect(trigger.getAttribute('aria-describedby')).toBeNull()
    } finally {
      await act(async () => root.unmount())
      dom.window.close()
    }
  })

  it('opens on focus, restores trigger focus on Escape, and positions the themed portal inside the viewport', async () => {
    const dom = installDom()
    Object.defineProperties(dom.window, {
      innerWidth: { configurable: true, value: 200 },
      innerHeight: { configurable: true, value: 200 },
    })
    const root = createRoot(dom.window.document.getElementById('root')!)
    try {
      await card(root)
      const trigger = dom.window.document.querySelector<HTMLElement>('.cxr-ui-hover-card__trigger')!
      Object.defineProperty(trigger, 'getBoundingClientRect', {
        value: () => ({ width: 40, height: 20, x: 180, y: 170, top: 170, right: 220, bottom: 190, left: 180 }),
      })
      await act(async () => trigger.focus())
      const overlay = dom.window.document.querySelector<HTMLElement>('[role="tooltip"]')!
      Object.defineProperty(overlay, 'getBoundingClientRect', {
        value: () => ({ width: 120, height: 60, x: 0, y: 0, top: 0, right: 120, bottom: 60, left: 0 }),
      })
      await act(async () => dom.window.dispatchEvent(new dom.window.Event('resize')))
      expect(overlay.parentElement).toBe(dom.window.document.body)
      expect(overlay.dataset.side).toBe('top')
      expect(overlay.style.left).toBe('72px')
      expect(overlay.style.top).toBe('102px')
      expect(overlay.dataset.cordisxAppTheme).toBe('dark')

      await act(async () => {
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await Promise.resolve()
      })
      expect(dom.window.document.querySelector('[role="tooltip"]')).toBeNull()
      expect(dom.window.document.activeElement).toBe(trigger)
    } finally {
      await act(async () => root.unmount())
      dom.window.close()
    }
  })

  it('supports a pinned coarse-pointer fallback and dismisses it on outside input', async () => {
    vi.useFakeTimers()
    const dom = installDom(true)
    const root = createRoot(dom.window.document.getElementById('root')!)
    try {
      const onClick = vi.fn()
      await card(root, onClick)
      const trigger = dom.window.document.querySelector<HTMLElement>('.cxr-ui-hover-card__trigger')!
      await act(async () => trigger.click())
      expect(onClick).toHaveBeenCalledTimes(1)
      expect(dom.window.document.querySelector('[role="tooltip"]')).not.toBeNull()
      await act(async () => {
        trigger.dispatchEvent(new dom.window.MouseEvent('pointerout', { bubbles: true }))
        vi.advanceTimersByTime(1_000)
      })
      expect(dom.window.document.querySelector('[role="tooltip"]')).not.toBeNull()
      await act(async () =>
        dom.window.document.body.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }))
      )
      expect(dom.window.document.querySelector('[role="tooltip"]')).toBeNull()
    } finally {
      await act(async () => root.unmount())
      dom.window.close()
    }
  })
})
