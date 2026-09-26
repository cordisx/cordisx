import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { observeNativeRailActivation } from '../packages/cli/src/renderer/adapter/native-rail-activation.js'

describe('native rail activation', () => {
  it('releases after a completed native click even when the destination is already selected', async () => {
    const document = new JSDOM(`<!doctype html><body>
      <nav data-app-navigation-rail="true"><div>
        <div><button data-sidebar-destination="builtin:home">Home</button></div>
        <div><button data-sidebar-destination="builtin:automations" aria-current="page">Automations</button></div>
        <div><button data-cordisx-manager-trigger="true">CordisX</button></div>
        <div><button id="help" aria-haspopup="menu">Help</button></div>
        <div><button id="profile" aria-haspopup="menu">Profile</button></div>
      </div></nav>
      <button id="outside" data-sidebar-destination="builtin:library">Library</button>
    </body>`).window.document
    const rail = document.querySelector<HTMLElement>('nav')!
    const home = document.querySelector<HTMLButtonElement>('[data-sidebar-destination="builtin:home"]')!
    const automations = document.querySelector<HTMLButtonElement>(
      '[data-sidebar-destination="builtin:automations"]',
    )!
    for (const element of [rail, home, automations]) {
      element.getClientRects = () => ({ length: 1 }) as DOMRectList
    }
    const activate = vi.fn()
    const dispose = observeNativeRailActivation(document, activate)
    automations.dispatchEvent(new document.defaultView!.Event('pointerdown', { bubbles: true }))
    expect(activate).not.toHaveBeenCalled()
    automations.click()
    expect(activate).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(activate).toHaveBeenCalledOnce()
    expect(automations.getAttribute('aria-current')).toBe('page')
    document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!.click()
    document.getElementById('help')!.click()
    document.getElementById('profile')!.click()
    document.getElementById('outside')!.click()
    await Promise.resolve()
    expect(activate).toHaveBeenCalledOnce()
    home.dispatchEvent(new document.defaultView!.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(activate).toHaveBeenCalledOnce()
    home.click() // The browser generates click for keyboard activation.
    await Promise.resolve()
    expect(activate).toHaveBeenCalledTimes(2)
    automations.setAttribute('aria-disabled', 'true')
    automations.click()
    await Promise.resolve()
    expect(activate).toHaveBeenCalledTimes(2)
    automations.removeAttribute('aria-disabled')
    automations.click()
    dispose()
    await Promise.resolve()
    expect(activate).toHaveBeenCalledTimes(2)
  })
})
