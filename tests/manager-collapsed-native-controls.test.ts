import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { resolveManagerPaneSeat } from '../packages/cli/src/renderer/host-probes.js'
import { installNativeManagerShell } from './fixtures/native-manager-shell.js'

/** Regression: a native thread's fourth New chat action blocked collapsed Manager entry. */
function fixture() {
  const dom = new JSDOM('<!doctype html><body></body>')
  installNativeManagerShell(dom)
  const { document } = dom.window
  const element = (selector: string) => document.querySelector<HTMLElement>(selector)!
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect
  const setRect = (node: HTMLElement, box: DOMRect) => {
    node.getClientRects = () => ({ length: 1 }) as DOMRectList
    Object.defineProperty(node, 'getBoundingClientRect', { configurable: true, value: () => box })
  }
  for (const node of document.querySelectorAll<HTMLElement>('nav,button')) {
    node.getClientRects = () => ({ length: 1 }) as DOMRectList
  }
  const header = element('header')
  header.dataset.appShellHeaderLayout = 'thread-edge-scroll'
  const aside = element('aside')
  const sidebar = document.createElement('div')
  sidebar.id = 'app-shell-sidebar'
  const list = document.createElement('div')
  list.dataset.sidebarCollapsed = ''
  sidebar.append(element('[data-app-navigation-rail]'), list)
  list.append(element('nav[role="navigation"]'))
  aside.prepend(sidebar)
  const start = element('[data-app-shell-header-slot="start"]')
  const trigger = document.createElement('button')
  trigger.dataset.appShellSidebarTrigger = 'true'
  trigger.setAttribute('aria-controls', sidebar.id)
  trigger.setAttribute('aria-expanded', 'false')
  const create = document.createElement('button')
  create.setAttribute('aria-label', 'New chat')
  start.append(trigger, create)
  for (const node of [trigger, create]) node.style.pointerEvents = 'auto'
  setRect(trigger, rect(156, 8, 28, 28))
  setRect(create, rect(190, 8, 28, 28))
  setRect(start, rect(0, 0, 224, 44))
  setRect(aside, rect(0, 44, 52, 800))
  const main = element('[data-app-shell-main-content-layout]')
  const frame = element('[data-app-shell-thread-edge-divider]')
  main.dataset.appShellMainContentLayout = 'thread-edge-scroll'
  setRect(main, rect(52, 44, 1238, 800))
  setRect(frame, rect(52, 44, 1238, 800))
  setRect(element('[data-app-shell-titlebar-slot="main"]'), rect(52, 0, 1202, 44))
  const style = dom.window.getComputedStyle.bind(dom.window)
  Object.defineProperty(dom.window, 'getComputedStyle', {
    configurable: true,
    value: (node: Element) => {
      const value = style(node)
      if (node === trigger || node === create) {
        Object.defineProperty(value, 'webkitAppRegion', { configurable: true, value: 'no-drag' })
      }
      return value
    },
  })
  return { dom, document, header, start, trigger, create, setRect, rect }
}

describe('collapsed Manager native controls', () => {
  it('clips after the captured fourth thread action without changing native controls', () => {
    const f = fixture()
    try {
      const before = f.document.body.innerHTML
      const seat = resolveManagerPaneSeat(f.document)
      expect(seat?.provenance).toBe('codex-26.1103-collapsed-sidebar')
      if (seat?.provenance === 'codex-26.1103-collapsed-sidebar') {
        expect(seat.titlebar.bounds.left).toBe(234)
        expect(seat.titlebar.bounds.width).toBe(1020)
      }
      expect(f.document.body.innerHTML).toBe(before)
      f.header.dataset.appShellHeaderLayout = 'default'
      expect(resolveManagerPaneSeat(f.document)).toBeUndefined()
      f.header.dataset.appShellHeaderLayout = 'thread-edge-scroll'
      f.setRect(f.create, f.rect(200, 8, 28, 28))
      expect(resolveManagerPaneSeat(f.document)).toBeUndefined()
      f.setRect(f.create, f.rect(190, 8, 28, 28))
      f.create.setAttribute('aria-controls', 'unrelated')
      expect(resolveManagerPaneSeat(f.document)).toBeUndefined()
    } finally {
      f.dom.window.close()
    }
  })

  it('retains the original three-control layout and rejects an extra unknown control', () => {
    const f = fixture()
    try {
      f.create.remove()
      f.header.dataset.appShellHeaderLayout = 'default'
      f.setRect(f.start, f.rect(0, 0, 190, 44))
      expect(resolveManagerPaneSeat(f.document)?.provenance).toBe('codex-26.1103-collapsed-sidebar')
      f.start.append(f.create)
      expect(resolveManagerPaneSeat(f.document)).toBeUndefined()
    } finally {
      f.dom.window.close()
    }
  })
})
