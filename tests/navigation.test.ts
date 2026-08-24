import { Context, type Disposable } from '@deepseek-ai/cordis'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import type { CordisXLocalizationSeat } from '../packages/cli/src/contracts.js'
import { CommandRegistry } from '../packages/cli/src/renderer/commands.js'
import type { CordisXI18nService, LocalizationEffectOwner } from '../packages/cli/src/renderer/i18n.js'
import { GenerationVisibilityCoordinator } from '../packages/cli/src/renderer/generation-visibility.js'
import { CORDISX_PLUGIN_GENERATION, CORDISX_PLUGIN_ID } from '../packages/cli/src/renderer/ownership.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1, type CordisXPluginActivationRecordV1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import {
  NavigationRegistry,
  OutletRegistry,
  PageRegistry,
  type OutletController,
  type OutletHostSnapshot,
} from '../packages/cli/src/renderer/navigation.js'
import {
  CORDISX_BUILTIN_EXTENSION_POINT_CATALOG,
  CORDISX_EXTENSION_POINT_LOCALE_CATALOGS,
  CORDISX_MANAGER_EXTENSION_POINT_CATALOG,
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
  it('allows same-path page/route generations while projecting one coherent view', () => {
    const activation = (revision: number, generation: string): CordisXPluginActivationRecordV1 => ({
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1, schemaVersion: 1,
      recordKind: revision === 1 ? 'active' : 'candidate',
      ...(revision === 1 ? {} : { transactionId: 'update-demo' }),
      profileId: 'default', revision, lastGoodRevision: 1, runtimeGeneration: 'runtime-1',
      plugins: [{ id: 'demo', version: '1.0.0', digest: `sha256:${(revision === 1 ? 'a' : 'b').repeat(64)}`, moduleGeneration: generation, enabled: true, dependencies: [] }],
    })
    const previous = activation(1, 'demo-1')
    const candidate = activation(2, 'demo-2')
    const visibility = new GenerationVisibilityCoordinator(previous)
    const pages = new PageRegistry(visibility)
    const outlets = new OutletRegistry()
    const navigation = new NavigationRegistry(pages, outlets, fakeI18n())
    const oldContext = new Context().extend({ [CORDISX_PLUGIN_ID]: 'demo', [CORDISX_PLUGIN_GENERATION]: 'demo-1' })
    pages.register(oldContext, { id: 'settings', title: { key: 'old' } }, () => undefined)
    navigation.register(oldContext, { id: 'settings', path: '/settings', outlet: 'app', page: 'settings' })

    const handle = visibility.begin('update-demo', previous, candidate)
    const candidateContext = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'demo', [CORDISX_PLUGIN_GENERATION]: 'demo-2', ...visibility.context(handle, 'demo'),
    })
    pages.register(candidateContext, { id: 'settings', title: { key: 'new' } }, () => undefined)
    navigation.register(candidateContext, { id: 'settings', path: '/settings', outlet: 'app', page: 'settings' })
    expect(navigation.snapshot().pages[0]?.metadata.title).toEqual({ key: 'old' })
    expect(navigation.snapshot(visibility.view(candidateContext)).pages[0]?.metadata.title).toEqual({ key: 'new' })
    expect(navigation.snapshot(visibility.view(candidateContext)).routes).toHaveLength(1)

    visibility.publish(visibility.preparePublish(handle, visibility.confirmReadiness(handle)))
    expect(navigation.snapshot().pages[0]?.metadata.title).toEqual({ key: 'new' })
    expect(navigation.snapshot().routes).toHaveLength(1)
    void navigation.dispose()
    pages.dispose()
    outlets.dispose()
  })

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
    pages.register('demo', { id: 'first', title: { key: 'first' }, icon: 'host:info' }, () => undefined)
    pages.register('demo', { id: 'second', title: { key: 'second' }, icon: 'host:analytics' }, () => undefined)
    pages.register('demo', { id: 'session', title: { key: 'session' } }, () => undefined)
    navigation.register('demo', { id: 'first', path: '/first', outlet: 'app', page: 'first' })
    navigation.register('demo', { id: 'second', path: '/second', outlet: 'app', page: 'second' })
    navigation.register('demo', { id: 'session', path: '/sessions/:sessionId/files', outlet: 'session.content', page: 'session' })

    await navigation.navigate('demo', { id: 'first' })
    expect(dom.window.document.querySelector('[data-cordisx-page-leading] [data-host-icon="host:info"]')).not.toBeNull()
    expect(dom.window.document.querySelector('[data-cordisx-page-chrome] button[aria-label="Back"]')).toBeNull()
    await navigation.navigate('demo', { id: 'second' })
    const back = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-page-leading] button[aria-label="Back"]')!
    expect(back).not.toBeNull()
    expect(dom.window.document.querySelector('[data-cordisx-page-leading] [data-host-icon="host:analytics"]')).toBeNull()
    expect(dom.window.location.href).toBe('https://example.test/native')
    back.click()
    await settle()
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

  it('projects exact route toggles and mounts body-only pages under persistent session chrome', async () => {
    const dom = new JSDOM(`
      <body>
        <header id="native-session-header"><button id="trigger">Trace</button></header>
        <main id="session"><div id="native-thread">native</div></main>
      </body>
    `)
    const pages = new PageRegistry()
    const outlets = new OutletRegistry()
    const controller = new FakeOutlet(dom.window.document.getElementById('session')!, 'session:one', 'one')
    outlets.declare({
      schemaVersion: 1, id: 'session.content', authority: 'host-adapter', scope: 'session', preferredPlacement: 'absolute', contextPolicy: 'semantic',
    }, controller, path => path.startsWith('/sessions/:sessionId/'))
    const navigation = new NavigationRegistry(pages, outlets, fakeI18n())
    pages.register('demo', {
      id: 'trace', title: { key: 'trace', fallback: 'Agent Trace' }, icon: 'host:history', chrome: 'body-only',
    }, ({ container }) => {
      const bodyButton = container.ownerDocument.createElement('button')
      bodyButton.textContent = 'Timeline body'
      container.append(bodyButton)
    })
    navigation.register('demo', {
      id: 'trace', path: '/sessions/:sessionId/trace', outlet: 'session.content', page: 'trace',
    })
    const trigger = dom.window.document.getElementById('trigger') as HTMLButtonElement
    const reference = { id: 'trace', params: { sessionId: 'one' } } as const

    expect(navigation.routeProjection('demo', reference)).toMatchObject({ active: false, presented: false })
    await navigation.toggleFromSurface('demo', reference, 'session.header.actions', 'demo:trace', trigger)
    expect(navigation.routeProjection('demo', reference)).toMatchObject({
      active: true, presented: true, outlet: 'session.content',
    })
    expect(navigation.routeProjection('demo', { id: 'trace', params: { sessionId: 'two' } })).toMatchObject({
      active: false, presented: false,
    })
    const page = dom.window.document.querySelector<HTMLElement>('[data-cordisx-page="demo:trace"]')!
    expect(page.dataset.cordisxPageChromePolicy).toBe('body-only')
    expect(page.getAttribute('aria-label')).toBe('Agent Trace')
    expect(page.querySelector('[data-cordisx-page-chrome]')).toBeNull()
    expect(page.querySelector('[data-cordisx-page-title]')).toBeNull()
    expect(page.querySelector('button[aria-label="Close"]')).toBeNull()
    expect(page.firstElementChild?.getAttribute('data-cordisx-page-body')).toBe('true')
    expect(dom.window.document.getElementById('native-session-header')?.isConnected).toBe(true)
    expect(dom.window.document.getElementById('native-thread')?.textContent).toBe('native')

    page.querySelector('button')!.focus()
    page.querySelector('button')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    }))
    await navigation.settled()
    expect(navigation.routeProjection('demo', reference)).toMatchObject({ active: false, presented: false })
    expect(dom.window.document.activeElement).toBe(trigger)

    await navigation.toggleFromSurface('demo', reference, 'session.header.actions', 'demo:trace', trigger)
    trigger.focus()
    await navigation.toggleFromSurface('demo', reference, 'session.header.actions', 'demo:trace', trigger)
    expect(navigation.routeProjection('demo', reference)).toMatchObject({ active: false, presented: false })
    expect(dom.window.document.activeElement).toBe(trigger)
    await expect(navigation.toggleFromSurface(
      'demo', { id: 'trace', params: { sessionId: 'two' } }, 'session.header.actions', 'demo:trace', trigger,
    )).rejects.toThrow(/does not match native session one/)

    await navigation.dispose()
    pages.dispose()
    outlets.dispose()
    dom.window.close()
  })

  it('mounts a body-only manager settings page through attributed access checks and aborts before dispose', async () => {
    const dom = new JSDOM('<body><main id="logical"></main><section id="panel" role="tabpanel"><div id="body"></div></section></body>', {
      url: 'https://codex.local/native',
    })
    const pages = new PageRegistry()
    const outlets = new OutletRegistry()
    const controller = new FakeOutlet(dom.window.document.getElementById('logical')!, 'manager:generation')
    outlets.declare({
      schemaVersion: 1,
      id: 'manager.settings.content',
      authority: 'host-adapter',
      scope: 'manager-settings',
      preferredPlacement: 'portal',
      contextPolicy: 'generation',
      presentationGroup: 'manager-settings',
    }, controller, path => path.startsWith('/manager/settings/'))
    const descriptors = new ExtensionPointDescriptorRegistry(CORDISX_EXTENSION_POINT_LOCALE_CATALOGS)
    descriptors.registerCatalog(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG)
    descriptors.registerCatalog(CORDISX_MANAGER_EXTENSION_POINT_CATALOG)
    const broker = new ExtensionPointPolicyBroker(descriptors, new MemoryExtensionPointPolicyStore(), 'generation-one')
    const identity = { source: 'file:///plugins/demo/index.ts', id: 'demo' }
    broker.register(identity)
    const navigation = new NavigationRegistry(pages, outlets, fakeI18n())
    navigation.setAccessResolver(broker)
    const events: string[] = []
    pages.register('demo', {
      id: 'settings', title: { key: 'settings' }, chrome: 'body-only', localeNamespace: 'demo',
    }, (context) => {
      events.push('mount')
      context.signal.addEventListener('abort', () => events.push('abort'), { once: true })
      context.localization.effect(() => () => { events.push('effect-dispose') })
      const input = context.document.createElement('input')
      input.dataset.pluginSettingsInput = 'true'
      context.container.append(input)
      return () => { events.push('page-dispose') }
    })
    navigation.register('demo', {
      id: 'settings', path: '/manager/settings/demo', outlet: 'manager.settings.content', page: 'settings',
    })

    const body = dom.window.document.getElementById('body')!
    const mount = await navigation.mountManagerSettings('demo', { id: 'settings' }, 'demo:settings', body)
    expect(mount).toMatchObject({ owner: 'demo', contributionId: 'demo:settings', routeId: 'demo:settings', pageId: 'demo:settings' })
    expect(body.querySelector('[data-cordisx-settings-page="demo:settings"] [data-plugin-settings-input]')).not.toBeNull()
    expect(body.querySelector('[data-cordisx-page-chrome]')).toBeNull()
    expect(body.closest('[role="tabpanel"]')?.getAttribute('role')).toBe('tabpanel')
    expect(dom.window.location.href).toBe('https://codex.local/native')
    expect(broker.accessDiagnostics().map(item => item.request.operation)).toEqual([
      'surface.route.navigate', 'outlet.route.navigate', 'outlet.page.mount',
    ])
    expect(broker.accessDiagnostics().every(item => item.request.identity.pluginId === 'demo'
      && item.request.identity.source === identity.source
      && item.request.generation === 'generation-one')).toBe(true)

    await navigation.closeManagerSettings()
    expect(events).toEqual(['mount', 'abort', 'page-dispose', 'effect-dispose'])
    expect(body.children).toHaveLength(0)
    expect(navigation.snapshot().outlets.find(item => item.id === 'manager.settings.content')).toMatchObject({ mounted: false })

    await navigation.dispose()
    broker.dispose()
    descriptors.dispose()
    pages.dispose()
    outlets.dispose()
    dom.window.close()
  })

  it('keeps unresolved manager settings dependencies pending and rejects path, page chrome, conflict, and policy denial', async () => {
    const dom = new JSDOM('<body><main id="logical"></main><div id="panel"></div></body>')
    const pages = new PageRegistry()
    const outlets = new OutletRegistry()
    const navigation = new NavigationRegistry(pages, outlets, fakeI18n())
    navigation.register('demo', {
      id: 'pending', path: '/manager/settings/pending', outlet: 'manager.settings.content', page: 'pending',
    })
    expect(navigation.managerSettingsRoute('demo', 'pending')).toMatchObject({ state: 'pending', detail: expect.stringContaining('outlet') })

    const controller = new FakeOutlet(dom.window.document.getElementById('logical')!, 'manager:generation')
    outlets.declare({
      schemaVersion: 1, id: 'manager.settings.content', authority: 'host-adapter', scope: 'manager-settings',
      preferredPlacement: 'portal', contextPolicy: 'generation', presentationGroup: 'manager-settings',
    }, controller, path => path.startsWith('/manager/settings/'))
    expect(navigation.managerSettingsRoute('demo', 'pending')).toMatchObject({ state: 'pending', detail: expect.stringContaining('page') })
    pages.register('demo', { id: 'pending', title: { key: 'pending' } }, () => undefined)
    expect(navigation.managerSettingsRoute('demo', 'pending')).toMatchObject({ state: 'invalid', detail: expect.stringContaining('body-only') })

    pages.register('demo', { id: 'ready', title: { key: 'ready' }, chrome: 'body-only' }, () => undefined)
    navigation.register('demo', { id: 'root', path: '/manager/settings', outlet: 'manager.settings.content', page: 'ready' })
    expect(navigation.managerSettingsRoute('demo', 'root')).toMatchObject({ state: 'invalid', detail: expect.stringContaining('strictly below') })
    navigation.register('demo', { id: 'first', path: '/manager/settings/shared', outlet: 'manager.settings.content', page: 'ready' })
    navigation.register('other', { id: 'second', path: '/manager/settings/shared', outlet: 'manager.settings.content', page: 'ready' })
    expect(navigation.managerSettingsRoute('demo', 'first')).toMatchObject({ state: 'invalid', detail: expect.stringContaining('conflicts') })

    const descriptors = new ExtensionPointDescriptorRegistry(CORDISX_EXTENSION_POINT_LOCALE_CATALOGS)
    descriptors.registerCatalog(CORDISX_MANAGER_EXTENSION_POINT_CATALOG)
    const store = new MemoryExtensionPointPolicyStore()
    const broker = new ExtensionPointPolicyBroker(descriptors, store)
    const identity = { source: 'file:///plugins/denied/index.ts', id: 'denied' }
    broker.register(identity)
    broker.setPolicy(identity, 'manager.settings.content', 'deny')
    navigation.setAccessResolver(broker)
    pages.register('denied', { id: 'settings', title: { key: 'settings' }, chrome: 'body-only' }, () => undefined)
    navigation.register('denied', {
      id: 'settings', path: '/manager/settings/denied', outlet: 'manager.settings.content', page: 'settings',
    })
    expect(navigation.managerSettingsRoute('denied', 'settings')).toMatchObject({ state: 'invalid', detail: expect.stringContaining('denied') })
    await expect(navigation.mountManagerSettings('denied', { id: 'settings' }, 'denied:settings', dom.window.document.getElementById('panel')!))
      .rejects.toThrow(/denied/)

    await navigation.dispose()
    broker.dispose()
    descriptors.dispose()
    pages.dispose()
    outlets.dispose()
    dom.window.close()
  })

  it('suspends an overlapping outlet without remounting and restores it after close', async () => {
    const dom = new JSDOM('<body><main id="main"></main><main id="app"></main></body>')
    const pages = new PageRegistry()
    const outlets = new OutletRegistry()
    const main = new FakeOutlet(dom.window.document.getElementById('main')!, 'main:one')
    const app = new FakeOutlet(dom.window.document.getElementById('app')!, 'renderer')
    outlets.declare({
      schemaVersion: 1, id: 'main', authority: 'host-adapter', scope: 'main', preferredPlacement: 'portal', contextPolicy: 'semantic', presentationGroup: 'primary',
    }, main, path => path.startsWith('/main/'))
    outlets.declare({
      schemaVersion: 1, id: 'app', authority: 'host-adapter', scope: 'renderer', preferredPlacement: 'fixed', contextPolicy: 'generation', presentationGroup: 'primary',
    }, app, path => !path.startsWith('/main/'))
    const navigation = new NavigationRegistry(pages, outlets, fakeI18n())
    pages.register('demo', { id: 'main', title: { key: 'main' } }, ({ container }) => {
      const input = container.ownerDocument.createElement('input')
      input.value = 'preserved'
      container.append(input)
    })
    pages.register('demo', { id: 'app', title: { key: 'app' } }, () => undefined)
    navigation.register('demo', { id: 'main', path: '/main/demo', outlet: 'main', page: 'main' })
    navigation.register('demo', { id: 'app', path: '/app', outlet: 'app', page: 'app' })

    await navigation.navigate('demo', { id: 'main' })
    const mainPage = dom.window.document.querySelector<HTMLElement>('[data-cordisx-page="demo:main"]')!
    await navigation.navigate('demo', { id: 'app' })
    expect(navigation.snapshot().outlets.find(item => item.id === 'main')).toMatchObject({
      mounted: true, presentation: 'suspended', suspendedBy: 'app',
    })
    expect(navigation.snapshot().outlets.find(item => item.id === 'app')).toMatchObject({ presentation: 'presented' })
    expect(mainPage.isConnected).toBe(true)
    expect(mainPage.inert).toBe(true)
    expect(mainPage.getAttribute('aria-hidden')).toBe('true')

    await navigation.close('demo', 'app')
    expect(navigation.snapshot().outlets.find(item => item.id === 'main')).toMatchObject({ presentation: 'presented' })
    expect(dom.window.document.querySelector('[data-cordisx-page="demo:main"]')).toBe(mainPage)
    expect(mainPage.querySelector('input')?.value).toBe('preserved')
    expect(mainPage.inert).toBe(false)
    expect(mainPage.hasAttribute('aria-hidden')).toBe(false)

    await navigation.dispose()
    pages.dispose()
    outlets.dispose()
    dom.window.close()
  })

  it('renders app and main page headers from closed data and rechecks outlet policy before header commands', async () => {
    const dom = new JSDOM(`
      <body>
        <header data-app-shell-application-menu-bar><button class="native-icon-button" type="button">native</button></header>
        <main id="app"></main>
      </body>
    `)
    const pages = new PageRegistry()
    const outlets = new OutletRegistry()
    const descriptors = new ExtensionPointDescriptorRegistry(CORDISX_EXTENSION_POINT_LOCALE_CATALOGS)
    descriptors.registerCatalog(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG)
    const broker = new ExtensionPointPolicyBroker(descriptors, new MemoryExtensionPointPolicyStore())
    const identity = { source: 'https://plugins.example/demo', id: 'demo' }
    broker.register(identity)
    const commandRegistry = new CommandRegistry(broker)
    const commands = {
      hasFor: (owner: string, reference: { id: string }) => commandRegistry.has(owner, reference),
      executeFor: (owner: string, reference: { id: string }, invocationKey?: string) => commandRegistry.execute(owner, reference, invocationKey),
      subscribeInternal: (listener: () => void) => commandRegistry.subscribe(listener),
    }
    const controller = new FakeOutlet(dom.window.document.getElementById('app')!, 'renderer')
    outlets.declare({
      schemaVersion: 1, id: 'app', authority: 'host-adapter', scope: 'renderer', preferredPlacement: 'fixed', contextPolicy: 'generation',
    }, controller, path => !path.startsWith('/main/') && !path.startsWith('/sessions/'))
    const navigation = new NavigationRegistry(pages, outlets, fakeI18n(), undefined, broker, commands)
    let executions = 0
    commandRegistry.register('demo', { id: 'refresh', title: { key: 'refresh', fallback: 'Refresh' } }, () => { executions += 1 })
    let bodyContainer: HTMLElement | undefined
    pages.register('demo', {
      id: 'overview',
      title: { key: 'title', fallback: 'Overview' },
      icon: 'host:layers',
      breadcrumbs: [{ key: 'crumb', fallback: 'Demo' }],
      tabs: [{ id: 'details', label: { key: 'details', fallback: 'Details' }, icon: 'host:info' }],
      headerActions: [{
        id: 'refresh',
        label: { key: 'refresh', fallback: 'Refresh' },
        icon: 'host:refresh',
        command: { id: 'refresh' },
      }],
    }, ({ container }) => { bodyContainer = container })
    navigation.register('demo', { id: 'overview', path: '/overview', outlet: 'app', page: 'overview' })

    await navigation.navigate('demo', { id: 'overview' })
    const chrome = dom.window.document.querySelector<HTMLElement>('[data-cordisx-page-chrome]')!
    const title = chrome.querySelector<HTMLElement>('[data-cordisx-page-title]')!
    const action = chrome.querySelector<HTMLButtonElement>('[data-cordisx-page-header-action="refresh"]')!
    expect(chrome.querySelector('[data-cordisx-page-leading] [data-host-icon="host:layers"]')).not.toBeNull()
    expect(chrome.querySelector('button[aria-label="Back"]')).toBeNull()
    expect(title.textContent).toBe('Overview')
    expect(action.classList.contains('native-icon-button')).toBe(true)
    expect(action.textContent).toBe('')
    expect(action.getAttribute('aria-label')).toBe('Refresh')
    expect(action.dataset.cordisxNoDrag).toBe('true')
    expect(action.querySelector('[data-host-icon="host:refresh"]')).not.toBeNull()
    expect(dom.window.document.querySelector('[role="tab"] [data-host-icon="host:info"]')).not.toBeNull()
    expect(bodyContainer?.dataset.cordisxPageBody).toBe('true')
    expect(bodyContainer?.closest('header')).toBeNull()

    action.click()
    await settle()
    expect(executions).toBe(1)
    expect(broker.accessDiagnostics().at(-1)).toMatchObject({
      request: {
        operation: 'outlet.page.command.invoke',
        routeId: 'demo:overview',
        pageId: 'demo:overview',
        actionId: 'refresh',
        commandId: 'demo:refresh',
      },
      authorized: true,
    })

    broker.setPolicy(identity, 'app', 'deny')
    action.click()
    await settle()
    expect(executions).toBe(1)
    expect(broker.accessDiagnostics().at(-1)).toMatchObject({
      request: { operation: 'outlet.page.command.invoke', actionId: 'refresh' },
      authorized: false,
    })

    await navigation.dispose()
    commandRegistry.dispose()
    pages.dispose()
    outlets.dispose()
    broker.dispose()
    descriptors.dispose()
    dom.window.close()
  })

  it('rejects arbitrary page-header render fields instead of exposing a DOM seat', () => {
    const pages = new PageRegistry()
    expect(() => pages.register('demo', {
      id: 'unsafe',
      title: { key: 'unsafe' },
      headerMount: () => undefined,
    } as never, () => undefined)).toThrow(/unknown field headerMount/)
    expect(() => pages.register('demo', {
      id: 'unsafe-action',
      title: { key: 'unsafe-action' },
      headerActions: [{
        id: 'unsafe',
        label: { key: 'unsafe' },
        icon: 'host:info',
        command: { id: 'unsafe' },
        children: [],
      }],
    } as never, () => undefined)).toThrow(/unknown field children/)
    expect(() => pages.register('demo', {
      id: 'body-only-header',
      title: { key: 'body-only-header' },
      chrome: 'body-only',
      breadcrumbs: [],
    }, () => undefined)).toThrow(/body-only page body-only-header cannot declare/)
    pages.dispose()
  })

  it('rejects body-only page chrome from app outlets without persistent external chrome', () => {
    const dom = new JSDOM('<body><main id="app"></main></body>')
    const pages = new PageRegistry()
    const outlets = new OutletRegistry()
    outlets.declare({
      schemaVersion: 1, id: 'app', authority: 'host-adapter', scope: 'renderer', preferredPlacement: 'fixed', contextPolicy: 'generation',
    }, new FakeOutlet(dom.window.document.getElementById('app')!, 'renderer'), path => path === '/trace')
    const navigation = new NavigationRegistry(pages, outlets, fakeI18n())
    pages.register('demo', { id: 'trace', title: { key: 'trace' }, chrome: 'body-only' }, () => undefined)
    navigation.register('demo', { id: 'trace', path: '/trace', outlet: 'app', page: 'trace' })
    expect(navigation.snapshot().routes[0]).toMatchObject({
      valid: false,
      error: 'body-only page trace requires an outlet with persistent external chrome',
    })
    void navigation.dispose()
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
    const descriptors = new ExtensionPointDescriptorRegistry(CORDISX_EXTENSION_POINT_LOCALE_CATALOGS)
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
    await navigation.navigateFromSurface('demo', { id: 'route' }, 'sidebar.navigation.items', 'demo:navigation')
    expect(broker.accessDiagnostics().at(-3)).toMatchObject({
      request: { operation: 'surface.route.navigate', contributionId: 'demo:navigation', routeId: 'demo:route' },
      authorized: true,
    })
    broker.setPolicy(identity, 'sidebar.navigation.items', 'deny')
    await expect(navigation.navigateFromSurface('demo', { id: 'route' }, 'sidebar.navigation.items', 'demo:navigation')).rejects.toThrow(/denied/)
    broker.setPolicy(identity, 'sidebar.navigation.items', 'inherit')
    const disposedBeforeOutletDeny = disposed
    const hidesBeforeOutletDeny = controller.hides
    broker.setPolicy(identity, 'app', 'deny')
    await navigation.invalidatePointPolicies()
    expect(aborted).toBe(true)
    expect(disposed).toBe(disposedBeforeOutletDeny + 1)
    expect(controller.hides).toBe(hidesBeforeOutletDeny + 1)
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
