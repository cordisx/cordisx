import { JSDOM } from 'jsdom'
import { expect, it } from 'vitest'
import { NavigationRegistry, OutletRegistry, PageRegistry } from '../packages/cli/src/renderer/navigation.js'
import { TestCodexRouteHistory } from './helpers/codex-route-history.js'
import { fakeI18n, FakeOutlet, settle } from './suites/navigation.fixtures.js'

it('themes the mounted Host page and chrome outside the React body, follows App preference over OS, and releases it on close', async () => {
  const dom = new JSDOM('<html class="electron-light"><body><main id="app"></main></body></html>', {
    url: 'https://example.test/',
  })
  Object.defineProperty(dom.window, 'matchMedia', {
    value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  })
  const pages = new PageRegistry()
  const outlets = new OutletRegistry()
  outlets.declare(
    {
      schemaVersion: 1,
      id: 'app',
      authority: 'host-adapter',
      scope: 'renderer',
      preferredPlacement: 'fixed',
      contextPolicy: 'generation',
    },
    new FakeOutlet(dom.window.document.getElementById('app')!, 'renderer'),
    () => true,
  )
  const navigation = new NavigationRegistry(pages, outlets, fakeI18n(), new TestCodexRouteHistory())
  pages.register('demo', { id: 'page', title: { key: 'page' } }, () => undefined)
  navigation.register('demo', { id: 'page', path: '/page', outlet: 'app', page: 'page' })
  try {
    await navigation.navigate('demo', { id: 'page' })
    const content = dom.window.document.querySelector<HTMLElement>('[data-cordisx-page="demo:page"]')!
    expect(content.dataset.cordisxAppTheme).toBe('light')
    expect(content.style.getPropertyValue('--cx-surface')).toBe('#f8fafc')
    expect(content.style.getPropertyValue('--cx-text')).toBe('#18212f')
    expect(content.style.background).toContain('--cx-surface')
    expect(content.querySelector<HTMLElement>('[data-cordisx-page-chrome]')!.style.background).toContain('--cx-surface')
    dom.window.document.documentElement.className = 'electron-dark'
    await settle()
    expect(content.dataset.cordisxAppTheme).toBe('dark')
    expect(content.style.getPropertyValue('--cx-surface')).toBe('#17191d')
    dom.window.document.documentElement.className = 'electron-light'
    await settle()
    expect(content.dataset.cordisxAppTheme).toBe('light')
    await navigation.close('demo', 'app')
    expect(content.isConnected).toBe(false)
    expect(content.hasAttribute('data-cordisx-app-theme')).toBe(false)
    expect(content.style.getPropertyValue('--cx-surface')).toBe('')
  } finally {
    await navigation.dispose()
    dom.window.close()
  }
})
