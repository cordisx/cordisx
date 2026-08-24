import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { BrowserPermissionPrompt } from '../packages/cli/src/renderer/platform.js'

const request = {
  identity: { source: 'file:///plugins/demo.js', id: 'demo' },
  declaration: {
    name: 'models.read' as const,
    required: true,
    reason: { key: 'permission.models', fallback: '读取当前账号可用模型' },
    scope: { providers: ['codex'] },
  },
  requested: { providerIds: ['codex'] },
}

describe('host-owned permission prompt', () => {
  it('makes persistent allow primary while keeping allow-once non-persistent and the hierarchy flat', async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
    const prompt = new BrowserPermissionPrompt(dom.window.document)
    const pending = prompt.request(request)
    await Promise.resolve()
    const dialog = dom.window.document.querySelector<HTMLElement>('[data-permission-prompt="models.read"]')
    expect(dialog?.getAttribute('role')).toBe('dialog')
    expect(dialog?.querySelectorAll('h2')).toHaveLength(1)
    expect(dialog?.querySelector('h2')?.textContent).toBe('权限请求')
    expect(dialog?.textContent?.match(/权限请求/g)).toHaveLength(1)
    expect(dialog?.querySelectorAll('[data-permission-decision]')).toHaveLength(3)
    const primary = dialog?.querySelector<HTMLButtonElement>('[data-permission-decision="allow"]')
    expect(primary?.dataset.primary).toBe('true')
    expect(dom.window.document.activeElement).toBe(primary)
    expect(dialog?.querySelector('style')?.textContent).toContain('color-scheme: light dark')
    expect(dialog?.querySelector('style')?.textContent).toContain('background: Canvas')
    dialog?.querySelector<HTMLButtonElement>('[data-permission-decision="allow-once"]')?.click()
    await expect(pending).resolves.toBe('allow-once')
    expect(dom.window.document.querySelector('[data-permission-prompt]')).toBeNull()
  })

  it('treats Escape as a one-call denial', async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
    const prompt = new BrowserPermissionPrompt(dom.window.document)
    const pending = prompt.request(request)
    await Promise.resolve()
    dom.window.document.querySelector<HTMLElement>('[data-permission-prompt]')?.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await expect(pending).resolves.toBe('deny')
  })
})
