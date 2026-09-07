import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { ComposerVisualDrag } from '../packages/cli/src/renderer/composer-visual-drag.js'

function setup() {
  const dom = new JSDOM('<div id="frame"><input></div>')
  const parent = dom.window.document.querySelector<HTMLElement>('#frame')!
  let drag = true, activate = true
  const controller = new ComposerVisualDrag(parent, () => ({ width: 300, height: 200 }), {
    drag: () => drag,
    activate: () => activate,
  })
  controller.handle.setRegion({ x: 250, y: 150, width: 100, height: 100, label: 'Move avatar' })
  const button = parent.querySelector('button')!
  let captured: number | undefined
  button.setPointerCapture = id => {
    captured = id
  }
  button.hasPointerCapture = id => captured === id
  button.releasePointerCapture = () => {
    captured = undefined
  }
  const pointer = (type: string, x: number, y: number) => {
    const event = new dom.window.MouseEvent(type, {
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
      button: 0,
    })
    Object.defineProperty(event, 'pointerId', { value: 1 })
    button.dispatchEvent(event)
  }
  return {
    dom,
    parent,
    controller,
    button,
    pointer,
    grant(d: boolean, a: boolean) {
      drag = d
      activate = a
      controller.refresh()
    },
    close() {
      controller.dispose()
      dom.window.close()
    },
  }
}

describe('Host-owned composer drag target', () => {
  it('clips the declared region, keeps native input separate and supplies stable semantic snapshots', () => {
    const f = setup()
    try {
      expect(f.button.style.width).toBe('50px')
      expect(f.button.style.height).toBe('50px')
      expect(f.button.style.bottom).toBe('calc(100% + 0px)')
      expect(f.button.getAttribute('aria-label')).toBe('Move avatar')
      expect(f.parent.querySelector('input')).not.toBeNull()
      expect(f.controller.handle.getSnapshot()).toBe(f.controller.handle.getSnapshot())
      f.pointer('pointerdown', 260, 160)
      f.pointer('pointermove', 220, 120)
      expect(f.controller.handle.getSnapshot()).toMatchObject({ phase: 'move', deltaX: -40, deltaY: -40, gesture: 1 })
      f.pointer('pointerup', 220, 120)
      expect(f.controller.handle.getSnapshot().phase).toBe('end')
    } finally {
      f.close()
    }
  })
  it('activates clicks but never a drag that returns to its origin', () => {
    const f = setup()
    try {
      f.pointer('pointerdown', 260, 160)
      f.pointer('pointerup', 261, 161)
      expect(f.controller.handle.getSnapshot()).toMatchObject({ phase: 'activate', deltaX: 0, deltaY: 0 })
      f.pointer('pointerdown', 260, 160)
      f.pointer('pointermove', 270, 160)
      f.pointer('pointerup', 260, 160)
      expect(f.controller.handle.getSnapshot().phase).toBe('end')
      f.grant(true, false)
      f.pointer('pointerdown', 260, 160)
      f.pointer('pointerup', 260, 160)
      expect(f.controller.handle.getSnapshot().phase).toBe('end')
    } finally {
      f.close()
    }
  })
  it('keeps click jitter stationary until the drag threshold is crossed', () => {
    const f = setup()
    try {
      f.pointer('pointerdown', 260, 160)
      const start = f.controller.handle.getSnapshot()
      f.pointer('pointermove', 261, 162)
      expect(f.controller.handle.getSnapshot()).toBe(start)
      f.pointer('pointerup', 261, 162)
      expect(f.controller.handle.getSnapshot()).toMatchObject({ phase: 'activate', deltaX: 0, deltaY: 0 })
      f.grant(true, false)
      f.pointer('pointerdown', 260, 160)
      f.pointer('pointermove', 261, 162)
      f.pointer('pointerup', 261, 162)
      expect(f.controller.handle.getSnapshot()).toMatchObject({ phase: 'end', deltaX: 0, deltaY: 0 })
      f.pointer('pointerdown', 260, 160)
      f.pointer('pointermove', 264, 160)
      expect(f.controller.handle.getSnapshot()).toMatchObject({ phase: 'move', deltaX: 4, deltaY: 0 })
    } finally {
      f.close()
    }
  })
  it('accepts semantic assistive clicks without duplicating pointer clicks or keyboard defaults', () => {
    const f = setup()
    try {
      f.button.click()
      expect(f.controller.handle.getSnapshot()).toMatchObject({ phase: 'activate', gesture: 1 })
      f.pointer('pointerdown', 260, 160)
      f.pointer('pointerup', 260, 160)
      const pointerResult = f.controller.handle.getSnapshot()
      f.button.dispatchEvent(new f.dom.window.MouseEvent('click', { detail: 1, bubbles: true }))
      expect(f.controller.handle.getSnapshot()).toBe(pointerResult)
      const keyboard = new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
      f.button.dispatchEvent(keyboard)
      expect(keyboard.defaultPrevented).toBe(true)
      expect(f.controller.handle.getSnapshot().gesture).toBe(3)
      f.grant(true, false)
      const denied = f.controller.handle.getSnapshot()
      f.button.click()
      expect(f.controller.handle.getSnapshot()).toBe(denied)
    } finally {
      f.close()
    }
  })
  it('hides the pointer focus outline while retaining keyboard focus feedback', () => {
    const f = setup()
    try {
      f.pointer('pointerdown', 260, 160)
      expect(f.dom.window.document.activeElement).toBe(f.button)
      expect(f.button.style.outline).toBe('none')
      f.button.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape' }))
      expect(f.button.style.outline).toBe('')
      f.pointer('pointerdown', 260, 160)
      expect(f.button.style.outline).toBe('none')
      f.button.blur()
      expect(f.button.style.outline).toBe('')
    } finally {
      f.close()
    }
  })
  it('cancels on blur, revoked authority and disposal, leaving stale handles inert', () => {
    const f = setup()
    try {
      f.pointer('pointerdown', 260, 160)
      f.dom.window.dispatchEvent(new f.dom.window.Event('blur'))
      expect(f.controller.handle.getSnapshot().phase).toBe('cancel')
      f.pointer('pointerdown', 260, 160)
      f.grant(false, true)
      expect(f.controller.handle.getSnapshot().phase).toBe('cancel')
      f.grant(true, true)
      f.pointer('pointerdown', 260, 160)
      f.button.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape' }))
      expect(f.controller.handle.getSnapshot().phase).toBe('cancel')
      f.grant(false, false)
      expect(f.button.style.display).toBe('none')
      f.controller.dispose()
      const old = f.controller.handle.getSnapshot()
      f.controller.handle.setRegion({ x: 0, y: 0, width: 50, height: 50, label: 'stale' })
      f.pointer('pointerdown', 0, 0)
      expect(f.controller.handle.getSnapshot()).toBe(old)
      expect(f.parent.querySelector('button')).toBeNull()
    } finally {
      f.close()
    }
  })
  it('supports complete keyboard gestures and activation with independent authority', () => {
    const f = setup()
    try {
      f.button.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft' }))
      expect(f.controller.handle.getSnapshot()).toMatchObject({ phase: 'end', deltaX: -8 })
      f.grant(false, true)
      f.button.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Enter' }))
      expect(f.controller.handle.getSnapshot().phase).toBe('activate')
      const old = f.controller.handle.getSnapshot()
      f.button.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight' }))
      expect(f.controller.handle.getSnapshot()).toBe(old)
    } finally {
      f.close()
    }
  })
})
