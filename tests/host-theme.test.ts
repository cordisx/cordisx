import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { HostThemeProjection } from '../packages/cli/src/renderer/host-theme.js'

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('HostThemeProjection', () => {
  it('reads the current renderer theme when a late portal first attaches', () => {
    const dom = new JSDOM('<!doctype html><html data-theme="dark"><body></body></html>')
    const projection = new HostThemeProjection(dom.window.document)
    const portal = dom.window.document.createElement('div')
    try {
      dom.window.document.documentElement.dataset.theme = 'light'
      projection.attach(portal)
      expect(portal.dataset.cordisxAppTheme).toBe('light')
      expect(portal.style.getPropertyValue('--cx-surface')).toBe('#f8fafc')
    } finally {
      projection.dispose()
      dom.window.close()
    }
  })

  it('prefers the renderer App theme over an opposite system preference, updates open portals, and cleans its projection', async () => {
    const dom = new JSDOM('<!doctype html><html class="electron-dark"><body></body></html>')
    Object.defineProperty(dom.window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    })
    const portal = dom.window.document.createElement('div')
    const projection = new HostThemeProjection(dom.window.document)
    const detach = projection.attach(portal)
    try {
      expect(portal.dataset.cordisxAppTheme).toBe('dark')
      expect(portal.dataset.cordisxThemeSource).toBe('renderer-attribute')
      expect(portal.style.getPropertyValue('--cx-surface')).toBe('#17191d')
      dom.window.document.documentElement.className = 'electron-light'
      await settle()
      expect(portal.dataset.cordisxAppTheme).toBe('light')
      expect(portal.style.getPropertyValue('--cx-surface')).toBe('#f8fafc')
      detach()
      expect(portal.hasAttribute('data-cordisx-app-theme')).toBe(false)
      expect(portal.style.getPropertyValue('--cx-surface')).toBe('')
    } finally {
      projection.dispose()
      dom.window.close()
    }
  })
})
