import type { Disposable } from '@deepseek-ai/cordis'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import type { CordisXLocalizationSeat } from '../packages/cli/src/contracts.js'
import type { CordisXI18nService, LocalizationEffectOwner } from '../packages/cli/src/renderer/i18n.js'
import {
  NavigationRegistry,
  OutletRegistry,
  PageRegistry,
  type OutletController,
  type OutletHostSnapshot,
} from '../packages/cli/src/renderer/navigation.js'
import {
  CORDISX_BUILTIN_EXTENSION_POINT_CATALOG,
  ExtensionPointDescriptorRegistry,
  ExtensionPointPolicyBroker,
  MemoryExtensionPointPolicyStore,
} from '../packages/cli/src/renderer/extension-points.js'

declare module '../packages/cli/src/contracts.js' {
  interface CordisXOutletMap {
    'panel.right': { readonly scope: 'panel' }
  }
}

class FakeOutlet implements OutletController {
  private readonly listeners = new Set<() => void>()
  private snapshot: OutletHostSnapshot
  shows = 0
  hides = 0

  constructor(container: HTMLElement, contextKey = 'context:one', nativeSessionId?: string) {
    this.snapshot = { available: true, container, contextKey, placement: 'absolute', ...(nativeSessionId === undefined ? {} : { nativeSessionId }) }
  }

  getSnapshot(): OutletHostSnapshot {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  show(): void { this.shows += 1 }
  hide(): void { this.hides += 1 }

  set(container: HTMLElement, contextKey: string, nativeSessionId = this.snapshot.nativeSessionId): void {
    this.snapshot = { available: true, container, contextKey, placement: 'absolute', ...(nativeSessionId === undefined ? {} : { nativeSessionId }) }
    for (const listener of [...this.listeners]) listener()
  }
}

function fakeI18n(): CordisXI18nService {
  return {
    resolveFor(_owner: string, message: { key: string; fallback?: string }) {
      return { text: message.fallback ?? message.key, namespace: 'demo', key: message.key }
    },
    clearDiagnosticSite() {},
    seatFor(owner: string, namespace: string | undefined, own: LocalizationEffectOwner): CordisXLocalizationSeat {
      const seat: CordisXLocalizationSeat = {
        namespace: `${owner}:${namespace ?? owner}`,
        t: key => String(key),
        message: (key, params) => ({ key, ...(params === undefined ? {} : { params }) }),
        getSnapshot: () => ({ locale: 'en', direction: 'ltr', version: 0 }),
        subscribe: listener => own(() => {
          void listener
          return () => {}
        }),
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
      return seat
    },
  } as unknown as CordisXI18nService
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('NavigationRegistry', () => {
  it('moves one mounted page across same-key anchor replacement and disposes on context switch', async () => {
    const dom = new JSDOM('<body><main id="one"></main><main id="two"></main></body>')
    const pages = new PageRegistry()
    const outlets = new OutletRegistry()
    const controller = new FakeOutlet(dom.window.document.getElementById('one')!)
    outlets.declare({
      schemaVersion: 1, id: 'main', authority: 'host-adapter', scope: 'main', preferredPlacement: 'absolute', contextPolicy: 'semantic',
    }, controller, path => path.startsWith('/main/'))
    const navigation = new NavigationRegistry(pages, outlets, fakeI18n())
    let mounts = 0
    let cleanups = 0
    let aborted = false
    pages.register('demo', { id: 'analytics', title: { key: 'title' } }, (context) => {
      mounts += 1
      context.signal.addEventListener('abort', () => { aborted = true })
      context.localization.effect(() => () => { cleanups += 1 })
      const state = context.document.createElement('input')
      state.value = 'preserved'
      context.container.append(state)
      return () => {}
    })
    navigation.register('demo', { id: 'analytics', path: '/main/analytics', outlet: 'main', page: 'analytics' })

    await navigation.navigate('demo', { id: 'analytics' })
    const page = dom.window.document.querySelector<HTMLElement>('[data-cordisx-page="demo:analytics"]')!
    expect(mounts).toBe(1)
    expect(page.parentElement?.id).toBe('one')

    controller.set(dom.window.document.getElementById('two')!, 'context:one')
    await settle()
    expect(mounts).toBe(1)
    expect(cleanups).toBe(0)
    expect(page.parentElement?.id).toBe('two')
    expect(page.querySelector('input')?.value).toBe('preserved')

    controller.set(dom.window.document.getElementById('one')!, 'context:two')
    await settle()
    expect(aborted).toBe(true)
    expect(cleanups).toBe(1)
    expect(page.isConnected).toBe(false)
    expect(navigation.snapshot().outlets[0]?.activeRoute).toBeUndefined()
    await navigation.dispose()
    pages.dispose()
    outlets.dispose()
    dom.window.close()
  })

  it('supports internal back/close without browser history and rejects stale session routes', async () => {
    const dom = new JSDOM('<body><main id="app"></main><main id="session"></main></body>', { url: 'https://example.test/native' })
    const pages = new PageRegistry()
    const outlets = new OutletRegistry()
    const app = new FakeOutlet(dom.window.document.getElementById('app')!, 'renderer')
    const session = new FakeOutlet(dom.window.document.getElementById('session')!, 'session:one', 'one')
    outlets.declare({
      schemaVersion: 1, id: 'app', authority: 'host-adapter', scope: 'renderer', preferredPlacement: 'fixed', contextPolicy: 'generation',
    }, app, path => !path.startsWith('/main/') && !path.startsWith('/sessions/'))
    outlets.declare({
      schemaVersion: 1, id: 'session.content', authority: 'host-adapter', scope: 'session', preferredPlacement: 'absolute', contextPolicy: 'semantic',
    }, session, path => path.startsWith('/sessions/:sessionId/'))
    const navigation = new NavigationRegistry(pages, outlets, fakeI18n())
    pages.register('demo', { id: 'first', title: { key: 'first' } }, () => undefined)
    pages.register('demo', { id: 'second', title: { key: 'second' } }, () => undefined)
    pages.register('demo', { id: 'session', title: { key: 'session' } }, () => undefined)
    navigation.register('demo', { id: 'first', path: '/first', outlet: 'app', page: 'first' })
    navigation.register('demo', { id: 'second', path: '/second', outlet: 'app', page: 'second' })
    navigation.register('demo', { id: 'session', path: '/sessions/:sessionId/files', outlet: 'session.content', page: 'session' })

    await navigation.navigate('demo', { id: 'first' })
    await navigation.navigate('demo', { id: 'second' })
    expect(dom.window.location.href).toBe('https://example.test/native')
    await navigation.back('demo', 'app')
    expect(navigation.snapshot().outlets.find(item => item.id === 'app')?.activeRoute).toBe('demo:first')
    await navigation.close('demo', 'app')
    expect(app.hides).toBe(1)
    await expect(navigation.navigate('demo', { id: 'session', params: { sessionId: 'stale' } })).rejects.toThrow(/does not match native session one/)
    await navigation.navigate('demo', { id: 'session', params: { sessionId: 'one' } })
    expect(navigation.match('session.content', '/sessions/one/files')).toEqual({ routeId: 'demo:session', params: { sessionId: 'one' } })
    await navigation.dispose()
    pages.dispose()
    outlets.dispose()
    dom.window.close()
  })

  it('diagnoses missing dependencies and makes both path conflicts unavailable', () => {
    const dom = new JSDOM('<body><main></main></body>')
    const pages = new PageRegistry()
    const outlets = new OutletRegistry()
    outlets.declare({
      schemaVersion: 1, id: 'app', authority: 'host-adapter', scope: 'renderer', preferredPlacement: 'fixed', contextPolicy: 'generation',
    }, new FakeOutlet(dom.window.document.querySelector('main')!), () => true)
    const navigation = new NavigationRegistry(pages, outlets, fakeI18n())
    pages.register('one', { id: 'page', title: { key: 'page' } }, () => undefined)
    pages.register('two', { id: 'page', title: { key: 'page' } }, () => undefined)
    navigation.register('one', { id: 'route', path: '/conflict', outlet: 'app', page: 'page' })
    navigation.register('two', { id: 'route', path: '/conflict', outlet: 'app', page: 'page' })
    expect(navigation.snapshot().routes.every(route => !route.valid && route.error?.includes('conflicts'))).toBe(true)
    expect(navigation.match('app', '/conflict')).toBeUndefined()
    const panel = new FakeOutlet(dom.window.document.querySelector('main')!, 'panel:right')
    outlets.declare({
      schemaVersion: 1,
      id: 'panel.right',
      authority: 'host-adapter',
      scope: 'panel',
      preferredPlacement: 'portal',
      contextPolicy: 'semantic',
    }, panel, path => path.startsWith('/panels/right/'))
    pages.register('panel-demo', { id: 'page', title: { key: 'page' } }, () => undefined)
    navigation.register('panel-demo', { id: 'route', path: '/panels/right/demo', outlet: 'panel.right', page: 'page' })
    expect(navigation.snapshot().routes.find(route => route.qualifiedId === 'panel-demo:route')).toMatchObject({ valid: true })
    navigation.register('panel-demo', { id: 'wrong-path', path: '/main/wrong', outlet: 'panel.right', page: 'page' })
    expect(navigation.snapshot().routes.find(route => route.qualifiedId === 'panel-demo:wrong-path')?.error).toMatch(/incompatible/)
    void navigation.dispose()
    pages.dispose()
    outlets.dispose()
    dom.window.close()
  })

  it('denies outlet navigation and aborts an active page without touching native content', async () => {
    const dom = new JSDOM('<body><main id="app"><div id="native">native</div></main></body>')
    const container = dom.window.document.getElementById('app')!
    const native = dom.window.document.getElementById('native')!
    const nativeParent = native.parentElement
    const pages = new PageRegistry()
    const outlets = new OutletRegistry()
    const controller = new FakeOutlet(container, 'renderer')
    outlets.declare({
      schemaVersion: 1, id: 'app', authority: 'host-adapter', scope: 'renderer', preferredPlacement: 'fixed', contextPolicy: 'generation',
    }, controller, path => !path.startsWith('/main/') && !path.startsWith('/sessions/'))
    const descriptors = new ExtensionPointDescriptorRegistry()
    descriptors.registerCatalog(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG)
    const broker = new ExtensionPointPolicyBroker(descriptors, new MemoryExtensionPointPolicyStore())
    const identity = { source: 'https://plugins.example/demo', id: 'demo' }
    broker.register(identity)
    const navigation = new NavigationRegistry(pages, outlets, fakeI18n(), undefined, broker)
    let aborted = false
    let disposed = 0
    pages.register('demo', { id: 'page', title: { key: 'page' } }, ({ signal }) => {
      signal.addEventListener('abort', () => { aborted = true })
      return () => { disposed += 1 }
    })
    navigation.register('demo', { id: 'route', path: '/demo', outlet: 'app', page: 'page' })

    await navigation.navigate('demo', { id: 'route' })
    expect(navigation.snapshot().outlets[0]).toMatchObject({ mounted: true, activeRoute: 'demo:route' })
    broker.setPolicy(identity, 'app', 'deny')
    await navigation.invalidatePointPolicies()
    expect(aborted).toBe(true)
    expect(disposed).toBe(1)
    expect(controller.hides).toBe(1)
    expect(navigation.snapshot().routes[0]).toMatchObject({ valid: true, authorized: false, pointPolicy: 'deny' })
    expect(broker.accessDiagnostics()).toEqual(expect.arrayContaining([
      expect.objectContaining({ request: expect.objectContaining({ operation: 'outlet.page.mount' }), authorized: false }),
    ]))
    expect(navigation.match('app', '/demo')).toBeUndefined()
    const shows = controller.shows
    await expect(navigation.navigate('demo', { id: 'route' })).rejects.toThrow(/denied/)
    expect(controller.shows).toBe(shows)
    expect(broker.accessDiagnostics().at(-1)).toMatchObject({
      request: { operation: 'outlet.route.navigate' }, authorized: false,
    })
    expect(native.parentElement).toBe(nativeParent)
    expect(native.isConnected).toBe(true)
    expect(native.textContent).toBe('native')

    broker.setPolicy(identity, 'app', 'allow')
    await navigation.invalidatePointPolicies()
    await navigation.navigate('demo', { id: 'route' })
    expect(navigation.snapshot().outlets[0]).toMatchObject({ mounted: true, activeRoute: 'demo:route' })
    await navigation.dispose()
    pages.dispose()
    outlets.dispose()
    broker.dispose()
    descriptors.dispose()
    dom.window.close()
  })
})
