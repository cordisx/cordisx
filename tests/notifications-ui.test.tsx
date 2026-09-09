import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { NotificationCenter } from '../packages/cli/src/renderer/notifications/model.js'
import { NotificationViewport } from '../packages/cli/src/renderer/notifications/view.js'

let root: Root | undefined
let dom: JSDOM | undefined
const previous = {
  window: globalThis.window,
  document: globalThis.document,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
}
afterEach(async () => {
  await act(async () => root?.unmount())
  dom?.window.close()
  Object.assign(globalThis, previous)
})
describe('notification card interactions', () => {
  it('renders source icon/navigation, details, actions and recoverable mute management', async () => {
    dom = new JSDOM('<html lang="en"><body><div id="root"></div></body></html>', { url: 'https://example.test' })
    const document = dom.window.document
    Object.assign(globalThis, { window: dom.window, document, IS_REACT_ACT_ENVIRONMENT: true })
    dom.window.HTMLDialogElement.prototype.showModal = function() {
      this.open = true
    }
    dom.window.HTMLDialogElement.prototype.close = function() {
      this.open = false
    }
    const copy = vi.fn(async () => {})
    Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: copy } })
    const open = vi.fn(async () => {})
    let finish!: () => void
    const action = vi.fn(() =>
      new Promise<void>(resolve => {
        finish = resolve
      })
    )
    const center = new NotificationCenter({ read: () => [], write() {} })
    const binding = center.bind({
      key: 'source/plugin',
      pluginId: 'plugin',
      active: () => true,
      presentation: () => ({ name: 'Game Room', icon: 'data:image/png;base64,AA==' }),
      open,
    })
    root = createRoot(document.getElementById('root')!)
    await act(async () => {
      root!.render(<NotificationViewport center={center} document={document} />)
    })
    const show = () =>
      binding.api.show({
        kind: 'connect.failed',
        type: 'error',
        message: 'Connection failed',
        details: 'Diagnostic code',
        action: { label: 'Retry', run: action },
      })
    const click = async (label: string) => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b =>
        b.textContent === label || b.getAttribute('aria-label') === label
      )
      expect(button, label).toBeDefined()
      await act(async () => button!.click())
    }
    await act(async () => {
      show()
    })
    expect(document.querySelector('.cxn-source img')).not.toBeNull()
    await click('Game Room')
    expect(open).toHaveBeenCalledOnce()
    expect(document.querySelectorAll('.cxn-card')).toHaveLength(1)
    await click('Show details')
    await click('Copy details')
    expect(copy).toHaveBeenCalledWith('Diagnostic code')
    await click('Retry')
    expect(document.querySelector<HTMLButtonElement>('.cxn-action')!.disabled).toBe(true)
    await act(async () => {
      show()
    })
    expect(document.querySelectorAll('.cxn-card')).toHaveLength(2)
    await act(async () => finish())
    expect(document.querySelectorAll('.cxn-card')).toHaveLength(1)
    await click('More notification options')
    await click('Mute this kind of notification')
    expect(document.querySelectorAll('.cxn-card')).toHaveLength(0)
    await act(async () => {
      show()
    })
    expect(document.querySelectorAll('.cxn-card')).toHaveLength(0)
    await click('Undo')
    await act(async () => {
      show()
    })
    expect(document.querySelectorAll('.cxn-card')).toHaveLength(1)
    await click('More notification options')
    await click('Mute all notifications from this plugin')
    await click('Manage')
    expect(document.querySelector('dialog')?.open).toBe(true)
    await click('Restore notifications')
    expect(center.getRules()).toHaveLength(0)
    await click('Close')
    await act(async () => {
      show()
    })
    await click('Dismiss notification')
    expect(document.querySelectorAll('.cxn-card')).toHaveLength(0)
  })
})
