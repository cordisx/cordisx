import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import { installNativePermissionDisplay } from '../packages/cli/src/renderer/native-permission-display.js'

it('shows persistent permission labels during loading, isolates chats, and restores native ownership', async () => {
  const dom = new JSDOM(
    `<!doctype html><html lang="zh"><body>
    <main data-codex-composer-root data-composer-placement="thread">
      <i data-above-composer-conversation-id="thread-a"></i>
      <footer><button data-composer-navigation-target="permissions" aria-describedby="permission-name">完全访问</button>
        <span id="permission-name">完全访问</span></footer>
    </main></body></html>`,
    { url: 'https://fixture.invalid' },
  )
  vi.stubGlobal('MutationObserver', dom.window.MutationObserver)
  vi.stubGlobal('Element', dom.window.Element)
  const trigger = dom.window.document.querySelector<HTMLButtonElement>('button')!
  const name = dom.window.document.getElementById('permission-name')!
  const marker = dom.window.document.querySelector('i')!
  const display = () => dom.window.document.querySelector('[data-cordisx-permission-display]')
  let dispose = installNativePermissionDisplay(dom.window.document)
  dispose()
  trigger.setAttribute('aria-busy', 'true')
  trigger.disabled = true
  trigger.textContent = ''
  name.textContent = ''
  dispose = installNativePermissionDisplay(dom.window.document)
  expect(display()?.textContent).toBe('完全访问')
  expect(display()?.getAttribute('aria-disabled')).toBe('true')
  expect(display()?.querySelector('button')).toBeNull()
  expect(trigger.disabled).toBe(true)
  expect(trigger.hidden).toBe(true)
  marker.setAttribute('data-above-composer-conversation-id', 'thread-b')
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(display()).toBeNull()
  expect(trigger.hidden).toBe(false)
  name.textContent = '请求批准'
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(display()?.textContent).toBe('请求批准')
  trigger.removeAttribute('aria-busy')
  trigger.disabled = false
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(display()).toBeNull()
  expect(trigger.hidden).toBe(false)
  trigger.setAttribute('aria-busy', 'true')
  trigger.disabled = true
  name.textContent = ''
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(display()?.textContent).toBe('请求批准')
  dispose()
  expect(display()).toBeNull()
  expect(trigger.hidden).toBe(false)
  dom.window.close()
  vi.unstubAllGlobals()
})
