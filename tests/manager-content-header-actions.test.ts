import { describe, expect, it, vi } from 'vitest'
import { CORDISX_PAGE_SCHEMA_V4, CORDISX_ROUTE_SCHEMA_V2 } from '../packages/cli/src/contracts.js'
import type { ExtensionPointAccessResolver } from '../packages/cli/src/renderer/extension-points.js'
import { NavigationRegistry, OutletRegistry, PageRegistry } from '../packages/cli/src/renderer/navigation.js'
import { HostContextStore } from '../packages/cli/src/renderer/validation.js'
import { TestCodexRouteHistory } from './helpers/codex-route-history.js'
import { reactManagerFixture } from './helpers/react-manager.js'
import { fakeI18n, FakeOutlet } from './suites/navigation.fixtures.js'

describe('embedded Manager page header actions', () => {
  it('uses the standard header with owner authorization, subscription and mount cleanup', async () => {
    const fixture = reactManagerFixture()
    const document = fixture.document
    document.body.insertAdjacentHTML('beforeend', '<header></header><main></main>')
    const contexts = new HostContextStore()
    const pages = new PageRegistry()
    const outlets = new OutletRegistry()
    const i18n = fakeI18n()
    i18n.subscribeInternal = () => () => {}
    const clear = vi.spyOn(i18n, 'clearDiagnosticSite')
    const authorize = vi.fn(() => ({ authorized: true }))
    const execute = vi.fn(async () => {})
    const unsubscribe = vi.fn()
    let available = true
    let refresh = () => {}
    const navigation = new NavigationRegistry(pages, outlets, i18n, new TestCodexRouteHistory(), contexts, {
      decision: () => ({ authorized: true }),
      authorizeSurfaceRoute: () => ({ authorized: true }),
      authorizeOutletRoute: () => ({ authorized: true }),
      authorizeOutletPage: () => ({ authorized: true }),
      authorizeOutletPageCommand: authorize,
    } as unknown as ExtensionPointAccessResolver, {
      hasFor: () => available,
      executeFor: execute,
      subscribeInternal: callback => {
        refresh = callback
        return unsubscribe
      },
    })
    const header = document.querySelector('header')!
    const container = document.querySelector('main')!
    outlets.declare(
      {
        schemaVersion: 1,
        id: 'manager.content',
        authority: 'host-adapter',
        scope: 'manager',
        preferredPlacement: 'absolute',
        contextPolicy: 'semantic',
        presentationGroup: 'manager',
      },
      new FakeOutlet(container),
      path => path.startsWith('/manager/extensions/'),
    )
    pages.register('demo', {
      $schema: CORDISX_PAGE_SCHEMA_V4,
      schemaVersion: 4,
      id: 'console',
      title: { key: 'console', fallback: 'Console' },
      description: { key: 'description', fallback: 'Manage services' },
      icon: 'host:settings',
      chrome: 'standard',
      contentInset: 'none',
      headerActions: [{
        id: 'refresh',
        label: { key: 'refresh', fallback: 'Refresh console' },
        icon: 'host:refresh',
        command: { id: 'refresh' },
      }],
    }, context => {
      const iframe = document.createElement('iframe')
      iframe.style.height = '100%'
      context.container.append(iframe)
      return () => iframe.remove()
    })
    navigation.register('demo', {
      $schema: CORDISX_ROUTE_SCHEMA_V2,
      schemaVersion: 2,
      id: 'console',
      path: '/manager/extensions/demo',
      outlet: 'manager.content',
      page: 'console',
      title: { key: 'console', fallback: 'Console' },
      description: { key: 'description', fallback: 'Manage services' },
    })
    try {
      const mount = await act(async () =>
        navigation.mountManagerContent('demo', { id: 'console' }, 'demo:console', container, undefined, header)
      )
      const button = header.querySelector('button')!
      expect(button.getAttribute('aria-label')).toBe('Refresh console')
      expect(button.disabled).toBe(false)
      expect(container.querySelector('header')).toBeNull()
      const page = container.querySelector<HTMLElement>('[data-cordisx-manager-page]')!
      expect(page.style.minHeight).toBe('0')
      expect(page.style.flexGrow).toBe('1')
      button.click()
      await vi.waitFor(() =>
        expect(execute).toHaveBeenCalledWith('demo', { id: 'refresh' }, 'page:demo:console:header:refresh')
      )
      expect(authorize).toHaveBeenCalledWith(
        'demo',
        'manager.content',
        'demo:console',
        'demo:console',
        'refresh',
        'demo:refresh',
      )
      available = false
      refresh()
      expect(button.disabled).toBe(true)
      button.click()
      expect(execute).toHaveBeenCalledOnce()
      await act(async () => mount.dispose())
      expect(header.childElementCount).toBe(0)
      expect(unsubscribe).toHaveBeenCalledOnce()
      expect(clear).toHaveBeenCalledWith('demo', 'manager:demo:console:actions.refresh.label')
    } finally {
      await navigation.dispose()
      outlets.dispose()
      pages.dispose()
      contexts.dispose()
      await fixture.dispose()
    }
  })
})
import { act } from 'react'
