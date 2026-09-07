import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { ComposerVisualInteractions } from '../packages/cli/src/renderer/composer-visual-interactions.js'

function setup() {
  const dom = new JSDOM('<div id="frame"><input></div>')
  const parent = dom.window.document.querySelector<HTMLElement>('#frame')!
  let drag = true, activate = true
  const factory = new ComposerVisualInteractions(parent, () => ({ width: 300, height: 200 }), {
    drag: () => drag,
    activate: () => activate,
  })
  const create = (id: string, x = 0) => {
    const handle = factory.handle.create(id)
    handle.setRegion({ x, y: 20, width: 80, height: 80, label: id })
    const button = [...parent.querySelectorAll('button')].find(value => value.getAttribute('aria-label') === id)!
    let captured: number | undefined
    button.setPointerCapture = value => {
      captured = value
    }
    button.hasPointerCapture = value => captured === value
    button.releasePointerCapture = () => {
      captured = undefined
    }
    return { handle, button }
  }
  const event = (button: HTMLElement, type: string, options: MouseEventInit = {}) => {
    const value = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...options })
    Object.defineProperty(value, 'pointerId', { value: 1 })
    button.dispatchEvent(value)
  }
  return {
    dom,
    parent,
    factory,
    create,
    event,
    grant(d: boolean, a: boolean) {
      drag = d
      activate = a
      factory.refresh()
    },
    close() {
      factory.dispose()
      dom.window.close()
    },
  }
}

describe('Composer independent interaction handles', () => {
  it('keeps identity, clipped regions, gesture state and disposal separate', () => {
    const f = setup()
    try {
      const a = f.create('a'), b = f.create('b', 270)
      expect(f.factory.handle.create('a')).toBe(a.handle)
      expect(b.button.style.width).toBe('30px')
      f.event(a.button, 'pointerdown')
      f.event(a.button, 'pointermove', { clientX: 20 })
      f.event(a.button, 'pointerup', { clientX: 20 })
      expect(a.handle.getSnapshot()).toMatchObject({ phase: 'end', deltaX: 20 })
      expect(b.handle.getSnapshot()).toMatchObject({ phase: 'idle', sequence: 0 })
      a.handle.dispose()
      expect(a.button.isConnected).toBe(false)
      expect(b.button.isConnected).toBe(true)
      expect(f.factory.handle.create('a')).not.toBe(a.handle)
      f.factory.dispose()
      expect(f.parent.querySelectorAll('button')).toHaveLength(0)
      expect(() => f.factory.handle.create('late')).toThrow('retired')
    } finally {
      f.close()
    }
  })
  it('reports hover and controlled menu selection without activation or dragging', () => {
    const f = setup()
    try {
      const { handle, button } = f.create('cat')
      const phases: string[] = []
      handle.subscribe(() => phases.push(handle.getSnapshot().phase))
      handle.setMenu([{ id: 'feed', label: '<Feed>' }, { id: 'locked', label: 'Locked', disabled: true }])
      f.event(button, 'pointerenter')
      expect(handle.getSnapshot().hovered).toBe(true)
      f.event(button, 'contextmenu', { button: 2 })
      expect(handle.getSnapshot().menuOpen).toBe(true)
      const menu = f.dom.window.document.querySelector('[role="menu"]')!
      expect(menu.textContent).toContain('<Feed>')
      expect(menu.querySelector('feed')).toBeNull()
      const items = menu.querySelectorAll<HTMLButtonElement>('button')
      items[1]!.click()
      expect(handle.getSnapshot().menuOpen).toBe(true)
      items[0]!.click()
      expect(handle.getSnapshot()).toMatchObject({ menuOpen: false, actionId: 'feed', phase: 'idle' })
      expect(f.dom.window.document.activeElement).toBe(button)
      expect(phases).not.toContain('activate')
      expect(phases).not.toContain('start')
      expect(menu.isConnected).toBe(false)
    } finally {
      f.close()
    }
  })
  it('gates menus on activation and removes menu/regions on revoke or disposal', () => {
    const f = setup()
    try {
      const { handle, button } = f.create('cat')
      handle.setMenu([{ id: 'feed', label: 'Feed' }])
      f.grant(true, false)
      f.event(button, 'contextmenu', { button: 2 })
      expect(handle.getSnapshot().menuOpen).toBe(false)
      f.grant(true, true)
      f.event(button, 'contextmenu', { button: 2 })
      const stale = f.dom.window.document.querySelector<HTMLButtonElement>('[role="menuitem"]')!
      f.grant(true, false)
      stale.click()
      expect(handle.getSnapshot().actionId).toBeUndefined()
      expect(f.dom.window.document.querySelector('[role="menu"]')).toBeNull()
      f.grant(true, true)
      f.event(button, 'contextmenu', { button: 2 })
      handle.setRegion(null)
      expect(handle.getSnapshot().menuOpen).toBe(false)
      expect(button.style.display).toBe('none')
      f.factory.dispose()
      handle.setMenu([{ id: 'late', label: 'Late' }])
      expect(f.dom.window.document.querySelector('[role="menu"]')).toBeNull()
    } finally {
      f.close()
    }
  })
  it('owns keyboard menu navigation, Escape and stale menu replacement', () => {
    const f = setup()
    try {
      const { handle, button } = f.create('cat')
      handle.setMenu([{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }])
      button.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }))
      const menu = f.dom.window.document.querySelector('[role="menu"]')!
      const items = menu.querySelectorAll('button')
      expect(f.dom.window.document.activeElement).toBe(items[0])
      items[0]!.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      expect(f.dom.window.document.activeElement).toBe(items[1])
      menu.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      expect(handle.getSnapshot().menuOpen).toBe(false)
      f.event(button, 'contextmenu', { button: 2 })
      const stale = f.dom.window.document.querySelector<HTMLButtonElement>('[role="menuitem"]')!
      handle.setMenu([{ id: 'new', label: 'New' }])
      stale.click()
      expect(handle.getSnapshot().actionId).toBeUndefined()
      expect(handle.getSnapshot().menuOpen).toBe(false)
    } finally {
      f.close()
    }
  })
  it('bounds allocation and rejects malformed menu declarations without changing the old menu', () => {
    const f = setup()
    try {
      const { handle, button } = f.create('cat')
      handle.setMenu([{ id: 'feed', label: 'Feed' }])
      expect(() => handle.setMenu([{ id: 'x', label: 'X' }, { id: 'x', label: 'X' }])).toThrow()
      expect(() => f.factory.handle.create('')).toThrow()
      for (let i = 0; i < 31; i++) f.factory.handle.create(`entity-${i}`)
      expect(() => f.factory.handle.create('overflow')).toThrow('limit')
      f.event(button, 'contextmenu', { button: 2 })
      expect(f.dom.window.document.querySelector('[role="menuitem"]')?.textContent).toBe('Feed')
    } finally {
      f.close()
    }
  })
})
