import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'

function dom(lang = 'en', theme: 'light' | 'dark' = 'dark'): JSDOM {
  const instance = new JSDOM(
    `<!doctype html><html lang="${lang}" class="electron-${theme}"><body><button id="before">Before</button></body></html>`,
    { pretendToBeVisual: true },
  )
  Object.defineProperty(instance.window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: theme === 'dark', addEventListener: () => {}, removeEventListener: () => {} }),
  })
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver']) {
    vi.stubGlobal(key, Reflect.get(instance.window, key))
  }
  Object.defineProperties(instance.window.HTMLElement.prototype, {
    attachEvent: { configurable: true, value: () => {} },
    detachEvent: { configurable: true, value: () => {} },
  })
  vi.stubGlobal('getComputedStyle', instance.window.getComputedStyle.bind(instance.window))
  vi.stubGlobal('requestAnimationFrame', instance.window.requestAnimationFrame.bind(instance.window))
  vi.stubGlobal('cancelAnimationFrame', instance.window.cancelAnimationFrame.bind(instance.window))
  return instance
}

async function mounted(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function press(instance: JSDOM, target: HTMLElement, key: string, shiftKey = false): KeyboardEvent {
  const event = new instance.window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

function type(instance: JSDOM, input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(instance.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new instance.window.Event('input', { bubbles: true }))
}

afterEach(async () => {
  await new Promise(resolve => setImmediate(resolve))
  vi.unstubAllGlobals()
})

describe('Host-owned plugin HTTP consent', () => {
  it('renders a themed accessible Host modal, captures a bearer secret, and restores focus', async () => {
    const instance = dom('zh-CN')
    const { captureHttpConsent } = await import('../packages/cli/src/renderer/plugin-http-consent.js')
    const before = instance.window.document.querySelector<HTMLButtonElement>('#before')!
    before.focus()
    const pending = captureHttpConsent({
      pluginId: 'game-room',
      origin: 'https://game.example',
      credential: 'bearer',
      signal: new AbortController().signal,
    })
    await mounted()

    expect(instance.window.document.querySelector('dialog')).toBeNull()
    const overlay = instance.window.document.querySelector<HTMLElement>('[data-plugin-http-consent]')!
    const panel = overlay.querySelector<HTMLElement>('[role="dialog"]')!
    expect(overlay.classList.contains('cxh-tdesign-root')).toBe(true)
    expect(overlay.dataset.cordisxAppTheme).toBe('dark')
    expect(overlay.style.getPropertyValue('--cx-surface')).toBe('#17191d')
    expect(panel.getAttribute('aria-modal')).toBe('true')
    expect(panel.getAttribute('aria-labelledby')).toBe(panel.querySelector('h2')?.id)
    expect(panel.getAttribute('aria-describedby')).toBe(panel.querySelector('.cxp-http-description')?.id)
    expect(panel.querySelector('h2')?.textContent).toBe('允许服务器连接')
    expect(panel.textContent).toContain('game-room')
    expect(panel.textContent).toContain('https://game.example')
    expect(panel.querySelector('[data-host-icon-key="permissions"]')).not.toBeNull()
    expect(panel.querySelector('[data-plugin-http-action="allow"]')?.classList.contains('t-button')).toBe(true)

    const input = panel.querySelector<HTMLInputElement>('input[type="password"]')!
    const allow = panel.querySelector<HTMLButtonElement>('[data-plugin-http-action="allow"]')!
    expect(instance.window.document.activeElement).toBe(input)
    expect(input.autocomplete).toBe('off')
    expect(input.maxLength).toBe(16_384)
    expect(input.required).toBe(true)
    type(instance, input, 'secret-value')
    allow.click()

    await expect(pending).resolves.toEqual({ approved: true, secret: 'secret-value' })
    expect(input.value).toBe('')
    expect(instance.window.document.querySelector('[data-plugin-http-consent]')).toBeNull()
    expect(instance.window.document.querySelector('[data-plugin-http-consent-style]')).toBeNull()
    expect(instance.window.document.activeElement).toBe(before)
    instance.window.close()
  })

  it('traps Tab, cancels with Escape, and removes its Host portal', async () => {
    const instance = dom()
    const { captureHttpConsent } = await import('../packages/cli/src/renderer/plugin-http-consent.js')
    const pending = captureHttpConsent({
      pluginId: 'game-room',
      origin: 'https://game.example',
      credential: 'none',
      signal: new AbortController().signal,
    })
    const overlay = instance.window.document.querySelector<HTMLElement>('[data-plugin-http-consent]')!
    const cancel = overlay.querySelector<HTMLButtonElement>('[data-plugin-http-action="cancel"]')!
    const allow = overlay.querySelector<HTMLButtonElement>('[data-plugin-http-action="allow"]')!
    expect(instance.window.document.activeElement).toBe(allow)
    expect(press(instance, allow, 'Tab').defaultPrevented).toBe(true)
    expect(instance.window.document.activeElement).toBe(cancel)
    expect(press(instance, cancel, 'Tab', true).defaultPrevented).toBe(true)
    expect(instance.window.document.activeElement).toBe(allow)
    press(instance, allow, 'Escape')
    await expect(pending).resolves.toEqual({ approved: false })
    expect(overlay.isConnected).toBe(false)
    expect(overlay.childElementCount).toBe(0)
    instance.window.close()
  })

  it('fails closed on abort and erases a transient secret before cleanup', async () => {
    const instance = dom()
    const { captureHttpConsent } = await import('../packages/cli/src/renderer/plugin-http-consent.js')
    const before = instance.window.document.querySelector<HTMLButtonElement>('#before')!
    before.focus()
    const abort = new AbortController()
    const pending = captureHttpConsent({
      pluginId: 'game-room',
      origin: 'https://game.example',
      credential: 'bearer',
      signal: abort.signal,
    })
    const input = instance.window.document.querySelector<HTMLInputElement>('input[type="password"]')!
    type(instance, input, 'erase-me')
    await mounted()
    abort.abort()
    await expect(pending).resolves.toEqual({ approved: false })
    expect(input.value).toBe('')
    expect(instance.window.document.querySelector('[data-plugin-http-consent]')).toBeNull()
    expect(instance.window.document.activeElement).toBe(before)
    instance.window.close()
  })
})
