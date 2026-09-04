import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import {
  mountNavigationCollectionActions,
  type HostNavigationCollectionAction,
} from '../packages/cli/src/renderer/host-ui/NavigationCollectionActions.js'

function action(overrides: Partial<HostNavigationCollectionAction> = {}): HostNavigationCollectionAction {
  return {
    id: 'pin',
    label: 'Pin',
    ariaLabel: 'Pin',
    placement: 'direct',
    tone: 'neutral',
    pressed: false,
    disabled: false,
    success: 'Pinned',
    failure: 'Pin failed',
    invoke: async () => {},
    ...overrides,
  }
}

describe('NavigationCollectionActions mount lifecycle', () => {
  it('returns direct confirmation focus to the action button itself', async () => {
    const dom = new JSDOM('<body><div id="actions"></div></body>')
    const document = dom.window.document
    const invoke = vi.fn(async () => {})
    const dispose = mountNavigationCollectionActions(document, document.getElementById('actions')!, [action({
      confirmation: { title: 'Pin?', description: 'Confirm pin.', confirmLabel: 'Pin' },
      invoke,
    })])
    const button = document.querySelector<HTMLButtonElement>('.cordisx-navigation-direct-action')!

    button.click()
    expect(document.querySelector('.cordisx-navigation-confirm')).not.toBeNull()
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await Promise.resolve()

    expect(document.activeElement).toBe(button)
    expect(invoke).not.toHaveBeenCalled()
    dispose()
    dom.window.close()
  })

  it('disposes owned modal, document listeners, and the pending confirmation promise', async () => {
    const dom = new JSDOM('<body><div id="actions"></div></body>')
    const document = dom.window.document
    const removeEventListener = vi.spyOn(document, 'removeEventListener')
    const invoke = vi.fn(async () => {})
    const dispose = mountNavigationCollectionActions(document, document.getElementById('actions')!, [action({
      confirmation: { title: 'Pin?', description: 'Confirm pin.', confirmLabel: 'Pin' },
      invoke,
    })])

    document.querySelector<HTMLButtonElement>('.cordisx-navigation-direct-action')!.click()
    expect(document.querySelector('.cordisx-navigation-confirm-backdrop')).not.toBeNull()
    dispose()
    await Promise.resolve()

    expect(document.querySelector('.cordisx-navigation-confirm-backdrop')).toBeNull()
    expect(removeEventListener.mock.calls.some(([type, _listener, options]) => type === 'keydown' && options === true)).toBe(true)
    expect(invoke).not.toHaveBeenCalled()
    dom.window.close()
  })

  it('clears feedback timers, closes overflow listeners, and ignores a late action result after disposal', async () => {
    const dom = new JSDOM('<body><div id="actions"></div></body>')
    const document = dom.window.document
    const clearTimeout = vi.spyOn(dom.window, 'clearTimeout')
    const removeEventListener = vi.spyOn(document, 'removeEventListener')
    const container = document.getElementById('actions')!

    let resolveAction = (): void => {}
    const disposePending = mountNavigationCollectionActions(document, container, [action({
      invoke: async () => await new Promise<void>(resolve => { resolveAction = resolve }),
    })])
    document.querySelector<HTMLButtonElement>('.cordisx-navigation-direct-action')!.click()
    await Promise.resolve()
    disposePending()
    resolveAction()
    await Promise.resolve()
    await Promise.resolve()
    expect(document.querySelector('.cordisx-navigation-feedback')).toBeNull()

    const disposeFeedback = mountNavigationCollectionActions(document, container, [
      action(),
      action({ id: 'delete', label: 'Delete', ariaLabel: 'Delete', placement: 'overflow' }),
    ])
    document.querySelector<HTMLButtonElement>('.cordisx-navigation-direct-action')!.click()
    await vi.waitFor(() => expect(document.querySelector('.cordisx-navigation-feedback')).not.toBeNull())
    document.querySelector<HTMLButtonElement>('.cordisx-navigation-more-action')!.click()
    expect(document.querySelector('.cordisx-navigation-menu')).not.toBeNull()
    disposeFeedback()

    expect(clearTimeout).toHaveBeenCalled()
    expect(document.querySelector('.cordisx-navigation-feedback')).toBeNull()
    expect(document.querySelector('.cordisx-navigation-menu')).toBeNull()
    expect(removeEventListener.mock.calls.some(([type, _listener, options]) => type === 'pointerdown' && options === true)).toBe(true)
    expect(removeEventListener.mock.calls.some(([type, _listener, options]) => type === 'keydown' && options === true)).toBe(true)
    dom.window.close()
  })
})
