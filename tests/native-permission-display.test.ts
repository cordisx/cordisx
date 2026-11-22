import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import { installNativePermissionDisplay } from '../packages/cli/src/renderer/native-permission-display.js'
import { COMPOSER_DIAGNOSTIC_CHANNEL } from '../packages/cli/src/renderer/native-composer-diagnostics.js'

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

it.each(['disabled', 'aria-disabled'])(
  'returns the native click target when %s clears before aria-busy',
  async disabledAttribute => {
    const dom = new JSDOM(
      `<!doctype html><html lang="zh"><body>
      <main data-codex-composer-root data-composer-placement="thread">
        <i data-above-composer-conversation-id="thread-a"></i>
        <button data-composer-navigation-target="permissions">完全访问</button>
      </main></body></html>`,
      { url: 'https://fixture.invalid' },
    )
    vi.stubGlobal('MutationObserver', dom.window.MutationObserver)
    vi.stubGlobal('Element', dom.window.Element)
    const trigger = dom.window.document.querySelector<HTMLButtonElement>('button')!
    const opened = vi.fn()
    trigger.addEventListener('click', opened)
    const display = () => dom.window.document.querySelector('[data-cordisx-permission-display]')
    const dispose = installNativePermissionDisplay(dom.window.document)
    try {
      trigger.setAttribute('aria-busy', 'true')
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(display()).toBeNull()
      expect(trigger.hidden).toBe(false)
      trigger.setAttribute(disabledAttribute, 'true')
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(display()?.textContent).toBe('完全访问')
      expect(trigger.hidden).toBe(true)
      trigger.removeAttribute(disabledAttribute)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(trigger.getAttribute('aria-busy')).toBe('true')
      expect(display()).toBeNull()
      expect(trigger.hidden).toBe(false)
      expect(trigger.style.pointerEvents).toBe('')
      trigger.click()
      expect(opened).toHaveBeenCalledOnce()
    } finally {
      dispose()
      dom.window.close()
      vi.unstubAllGlobals()
    }
  },
)

it.each([true, false])(
  'records whether the native permission menu opens (%s) without changing the click',
  async opens => {
    vi.useFakeTimers()
    const dom = new JSDOM(
      `<!doctype html><body><main data-codex-composer-root data-composer-placement="thread">
      <button data-composer-navigation-target="permissions" aria-expanded="false">Private label</button>
    </main></body>`,
      { url: 'https://fixture.invalid' },
    )
    vi.stubGlobal('MutationObserver', dom.window.MutationObserver)
    vi.stubGlobal('Element', dom.window.Element)
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const trigger = dom.window.document.querySelector<HTMLButtonElement>('button')!
    const nativeClick = vi.fn((event: Event) => {
      expect(event.defaultPrevented).toBe(false)
      if (opens) trigger.setAttribute('aria-expanded', 'true')
    })
    trigger.addEventListener('click', nativeClick)
    const dispose = installNativePermissionDisplay(dom.window.document)
    try {
      trigger.click()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(nativeClick).toHaveBeenCalledOnce()
      expect(debug.mock.calls.map(([channel, value]) => {
        expect(channel).toBe(COMPOSER_DIAGNOSTIC_CHANNEL)
        return JSON.parse(value as string)
      })).toEqual([
        { phase: 'permissions/menu', state: 'pending', elapsedMs: 0 },
        { phase: 'permissions/menu', state: opens ? 'ready' : 'timeout', elapsedMs: expect.any(Number) },
      ])
      dispose()
      trigger.setAttribute('aria-expanded', 'false')
      trigger.click()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(debug).toHaveBeenCalledTimes(2)
    } finally {
      dispose()
      dom.window.close()
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
      vi.useRealTimers()
    }
  },
)
