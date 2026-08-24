import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_ROUTE_SCHEMA_V2,
  type CordisXLocalizationSeat,
} from '../packages/cli/src/contracts.js'
import type { CordisXI18nService, LocalizationEffectOwner } from '../packages/cli/src/renderer/i18n.js'
import {
  compareManagerSettingsNavigationItems,
  sortManagerSettingsNavigationItems,
} from '../packages/cli/src/renderer/manager-settings-navigation.js'
import {
  NavigationRegistry,
  OutletRegistry,
  PageRegistry,
  type OutletController,
  type OutletHostSnapshot,
} from '../packages/cli/src/renderer/navigation.js'
import { SurfaceRegistry } from '../packages/cli/src/renderer/surfaces.js'
import { HostContextStore } from '../packages/cli/src/renderer/validation.js'

class FakeOutlet implements OutletController {
  private readonly listeners = new Set<() => void>()
  shows = 0
  hides = 0

  constructor(private readonly container: HTMLElement) {}

  getSnapshot(): OutletHostSnapshot {
    return { available: true, container: this.container, contextKey: 'manager:one', placement: 'absolute' }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  show(): void { this.shows += 1 }
  hide(): void { this.hides += 1 }
}

function fakeI18n(): CordisXI18nService {
  return {
    resolveFor(_owner: string, message: { key: string; fallback?: string }) {
      return { text: message.fallback ?? message.key, namespace: 'demo', key: message.key }
    },
    clearDiagnosticSite() {},
    seatFor(owner: string, namespace: string | undefined, own: LocalizationEffectOwner): CordisXLocalizationSeat {
      return {
        namespace: `${owner}:${namespace ?? owner}`,
        t: key => String(key),
        message: (key, params) => ({ key, ...(params === undefined ? {} : { params }) }),
        getSnapshot: () => ({ locale: 'en', direction: 'ltr', version: 0 }),
        subscribe: listener => own(() => { void listener; return () => {} }),
        effect: setup => own(() => setup({ locale: 'en', direction: 'ltr', version: 0 })),
        bindText: (node, message) => own(() => {
          const previous = node.textContent
          node.textContent = message.fallback ?? message.key
          return () => { node.textContent = previous }
        }),
        bindAttribute: (element, name, message) => own(() => {
          const previous = element.getAttribute(name)
          element.setAttribute(name, message.fallback ?? message.key)
          return () => previous === null ? element.removeAttribute(name) : element.setAttribute(name, previous)
        }),
      }
    },
  } as unknown as CordisXI18nService
}

describe('Manager Settings navigation core', () => {
  it('enforces the route-only surface envelope and projects pending/invalid dependencies', () => {
    const contexts = new HostContextStore()
    const surfaces = new SurfaceRegistry(contexts)
    surfaces.setResolvers({
      command: () => false,
      route: () => false,
      managerSettingsNavigationRoute: (_owner, id) => id === 'ready' || id === 'shared'
        ? { state: 'available' }
        : id === 'invalid'
          ? { state: 'invalid', detail: 'route is outside the Manager family' }
          : { state: 'pending', detail: 'route is unresolved' },
    })

    expect(() => surfaces.register('demo', {
      name: 'manager.settings.navigation-items', id: 'missing-group',
    } as never, { route: { id: 'ready' } })).toThrow(/requires group/)
    expect(() => surfaces.register('demo', {
      name: 'manager.settings.navigation-items', id: 'bad-group', group: 'default',
    } as never, { route: { id: 'ready' } })).toThrow(/requires group/)
    expect(() => surfaces.register('demo', {
      name: 'manager.settings.tabs', id: 'content', group: 'after-settings',
    } as never, { title: { key: 'content' }, icon: 'host:settings', route: { id: 'ready' } })).toThrow(/does not accept/)

    const ready = surfaces.register('demo', {
      name: 'manager.settings.navigation-items', id: 'ready', group: 'after-settings', order: 20,
    }, { route: { id: 'ready' } })
    surfaces.register('demo', {
      name: 'manager.settings.navigation-items', id: 'pending', group: 'before-settings', order: 10,
    }, { route: { id: 'pending' } })
    surfaces.register('demo', {
      name: 'manager.settings.navigation-items', id: 'invalid', group: 'after-settings', order: 10,
    }, { route: { id: 'invalid' } })
    surfaces.register('demo', {
      name: 'manager.settings.navigation-items', id: 'free-header', group: 'after-settings',
    }, { route: { id: 'ready' }, title: { key: 'forbidden' }, html: '<b>forbidden</b>' } as never)

    expect(surfaces.snapshot().find(item => item.id === 'ready')).toMatchObject({ valid: true, pending: false })
    expect(surfaces.snapshot().find(item => item.id === 'pending')).toMatchObject({ valid: true, pending: true })
    expect(surfaces.snapshot().find(item => item.id === 'invalid')).toMatchObject({ valid: false, pending: false })
    expect(surfaces.snapshot().find(item => item.id === 'free-header')?.error).toMatch(/unknown field/)
    surfaces.register('demo', {
      name: 'manager.settings.navigation-items', id: 'shared-a', group: 'before-settings',
    }, { route: { id: 'shared' } })
    surfaces.register('demo', {
      name: 'manager.settings.navigation-items', id: 'shared-b', group: 'after-settings',
    }, { route: { id: 'shared' } })
    const duplicateDestinations = surfaces.snapshot().filter(item => item.id.startsWith('shared-'))
    expect(duplicateDestinations.every(item => !item.valid)).toBe(true)
    expect(duplicateDestinations[0]?.error).toContain('demo:shared-a, demo:shared-b')
    ready.updateOptions({ group: 'before-settings', order: -5, disabled: { value: true } })
    expect(surfaces.snapshot().find(item => item.id === 'ready')).toMatchObject({ group: 'before-settings', order: -5, disabled: true })

    surfaces.dispose()
    contexts.dispose()
  })

  it('sorts fixed groups by order, owner, and owner-qualified id without mutating input', () => {
    const input = Object.freeze([
      Object.freeze({ group: 'after-settings' as const, order: -100, owner: 'alpha', id: 'alpha:last' }),
      Object.freeze({ group: 'before-settings' as const, order: 10, owner: 'zeta', id: 'zeta:a' }),
      Object.freeze({ group: 'before-settings' as const, order: 10, owner: 'alpha', id: 'alpha:z' }),
      Object.freeze({ group: 'before-settings' as const, order: 10, owner: 'alpha', id: 'alpha:a' }),
      Object.freeze({ group: 'before-settings' as const, order: 5, owner: 'zeta', id: 'zeta:first' }),
    ])
    const sorted = sortManagerSettingsNavigationItems(input)

    expect(sorted.map(item => item.id)).toEqual([
      'zeta:first', 'alpha:a', 'alpha:z', 'zeta:a', 'alpha:last',
    ])
    expect(input.map(item => item.id)).toEqual([
      'alpha:last', 'zeta:a', 'alpha:z', 'alpha:a', 'zeta:first',
    ])
    expect(Object.isFrozen(sorted)).toBe(true)
    expect(compareManagerSettingsNavigationItems(sorted[0]!, sorted[1]!)).toBeLessThan(0)
  })

  it('resolves the strict Manager route/page contract and rejects invalid or unresolved dependencies', async () => {
    const contexts = new HostContextStore()
    contexts.replace({ enabled: false })
    const pages = new PageRegistry()
    const outlets = new OutletRegistry()
    const navigation = new NavigationRegistry(pages, outlets, fakeI18n(), contexts)

    navigation.register('demo', {
      $schema: CORDISX_ROUTE_SCHEMA_V2, schemaVersion: 2,
      id: 'ready', path: '/manager/extensions/demo', outlet: 'manager.content', page: 'ready',
      title: { key: 'route.title' }, description: { key: 'route.description' },
    })
    expect(navigation.managerSettingsNavigationRoute('demo', 'ready')).toMatchObject({ state: 'pending' })

    const dom = new JSDOM('<body><main id="manager"></main></body>')
    const controller = new FakeOutlet(dom.window.document.getElementById('manager')!)
    outlets.declare({
      schemaVersion: 1, id: 'manager.content', authority: 'host-adapter', scope: 'manager',
      preferredPlacement: 'absolute', contextPolicy: 'semantic', presentationGroup: 'manager',
    }, controller, path => path.startsWith('/manager/extensions/'))
    expect(navigation.managerSettingsNavigationRoute('demo', 'ready')).toMatchObject({ state: 'pending' })

    pages.register('demo', {
      $schema: CORDISX_PAGE_SCHEMA_V3, schemaVersion: 3,
      id: 'ready', title: { key: 'page.title' }, description: { key: 'page.description' },
      icon: 'host:layers', chrome: 'standard',
    }, context => {
      const body = context.document.createElement('p')
      body.dataset.demoManagerContent = 'true'
      body.textContent = 'Host-controlled demo body'
      context.container.append(body)
      return () => body.remove()
    })
    expect(navigation.managerSettingsNavigationRoute('demo', 'ready')).toMatchObject({
      state: 'available',
      resolved: { owner: 'demo', qualifiedId: 'demo:ready', definition: { outlet: 'manager.content' }, page: { qualifiedId: 'demo:ready' } },
    })
    const managerBody = dom.window.document.createElement('section')
    dom.window.document.body.append(managerBody)
    const mount = await navigation.mountManagerContent('demo', { id: 'ready' }, 'demo:entry', managerBody)
    expect(managerBody.querySelector('[data-demo-manager-content]')?.textContent).toBe('Host-controlled demo body')
    expect(navigation.snapshot().outlets.find(item => item.id === 'manager.content')).toMatchObject({
      mounted: true,
      activeRoute: 'demo:ready',
    })
    mount.abort()
    await mount.dispose()
    expect(managerBody.querySelector('[data-demo-manager-content]')).toBeNull()

    pages.register('demo', {
      $schema: CORDISX_PAGE_SCHEMA_V3, schemaVersion: 3,
      id: 'missing-icon', title: { key: 'title' }, description: { key: 'description' },
    }, () => undefined)
    navigation.register('demo', {
      $schema: CORDISX_ROUTE_SCHEMA_V2, schemaVersion: 2,
      id: 'missing-icon', path: '/manager/extensions/missing-icon', outlet: 'manager.content', page: 'missing-icon',
      title: { key: 'title' }, description: { key: 'description' },
    })
    expect(navigation.managerSettingsNavigationRoute('demo', 'missing-icon')).toMatchObject({ state: 'invalid' })

    pages.register('demo', {
      $schema: CORDISX_PAGE_SCHEMA_V3, schemaVersion: 3,
      id: 'body', title: { key: 'title' }, description: { key: 'description' }, icon: 'host:info', chrome: 'body-only',
    }, () => undefined)
    navigation.register('demo', {
      $schema: CORDISX_ROUTE_SCHEMA_V2, schemaVersion: 2,
      id: 'body', path: '/manager/extensions/body', outlet: 'manager.content', page: 'body',
      title: { key: 'title' }, description: { key: 'description' },
    })
    expect(navigation.managerSettingsNavigationRoute('demo', 'body')).toMatchObject({ state: 'invalid' })

    navigation.register('demo', {
      $schema: CORDISX_ROUTE_SCHEMA_V2, schemaVersion: 2,
      id: 'root', path: '/manager/extensions', outlet: 'manager.content', page: 'ready',
      title: { key: 'title' }, description: { key: 'description' },
    })
    expect(navigation.managerSettingsNavigationRoute('demo', 'root')).toMatchObject({ state: 'invalid' })

    navigation.register('demo', {
      $schema: CORDISX_ROUTE_SCHEMA_V2, schemaVersion: 2,
      id: 'when', path: '/manager/extensions/when', outlet: 'manager.content', page: 'ready',
      title: { key: 'title' }, description: { key: 'description' }, when: { key: 'enabled', equals: true },
    })
    expect(navigation.managerSettingsNavigationRoute('demo', 'when')).toMatchObject({ state: 'pending' })

    void navigation.dispose()
    pages.dispose()
    outlets.dispose()
    contexts.dispose()
    dom.window.close()
  })

})
