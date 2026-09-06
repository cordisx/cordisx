import { Context } from '@deepseek-ai/cordis'
import { JSDOM } from 'jsdom'
import { expect, it } from 'vitest'
import { CORDISX_PAGE_SCHEMA_V3, CORDISX_ROUTE_SCHEMA_V2 } from '../../packages/cli/src/contracts.js'
import { activatePlaygroundReviewNavigation } from '../../packages/cli/src/playground/client/review-navigation.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../../packages/cli/src/plugin-lifecycle-contracts.js'
import { BrowserRouteHistoryAdapter } from '../../packages/cli/src/renderer/codex-router-history.js'
import { type ExtensionPointAccessResolver } from '../../packages/cli/src/renderer/extension-points.js'
import { GenerationVisibilityCoordinator } from '../../packages/cli/src/renderer/generation-visibility.js'
import { NavigationRegistry, OutletRegistry, PageRegistry } from '../../packages/cli/src/renderer/navigation.js'
import {
  CORDISX_PLUGIN_GENERATION,
  CORDISX_PLUGIN_ID,
  CORDISX_PLUGIN_SOURCE,
} from '../../packages/cli/src/renderer/ownership.js'
import { TestCodexRouteHistory } from '../helpers/codex-route-history.js'
import { copySessionStorage, fakeI18n, FakeOutlet, settle } from './navigation.fixtures.js'

export function registerHistoryTests() {
  it('resolves Agent Session routes only through the exact source and generation owner coordinate', async () => {
    const pluginId = 'org.cordisx.chatroom'
    const moduleGeneration = 'chatroom-generation-one'
    const activation: CordisXPluginActivationRecordV1 = {
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1,
      recordKind: 'active',
      profileId: 'playground',
      revision: 1,
      lastGoodRevision: 1,
      runtimeGeneration: 'runtime-one',
      plugins: [{
        id: pluginId,
        version: '1.0.0',
        digest: `sha256:${'a'.repeat(64)}`,
        moduleGeneration,
        enabled: true,
        dependencies: [],
      }],
    }
    const visibility = new GenerationVisibilityCoordinator(activation)
    const pages = new PageRegistry(visibility)
    const outlets = new OutletRegistry()
    const navigation = new NavigationRegistry(pages, outlets, fakeI18n(), new TestCodexRouteHistory())
    const source = 'file:///plugins/chatroom-a/index.mjs'
    const context = new Context().extend({
      [CORDISX_PLUGIN_ID]: pluginId,
      [CORDISX_PLUGIN_SOURCE]: source,
      [CORDISX_PLUGIN_GENERATION]: moduleGeneration,
    })
    navigation.register(context, {
      $schema: CORDISX_ROUTE_SCHEMA_V2,
      schemaVersion: 2,
      id: 'room-session-detail',
      path: '/main/chatroom/:roomId/session/:sessionId',
      outlet: 'main',
      page: 'room',
      title: { key: 'route.session.title', fallback: 'Open session' },
      description: { key: 'route.session.description', fallback: 'Open the exact room session.' },
    })

    expect(navigation.agentRuntimeRoutesForOwner({ source, pluginId, moduleGeneration })).toEqual([{
      id: 'room-session-detail',
      path: '/main/chatroom/:roomId/session/:sessionId',
      schemaVersion: 2,
    }])
    expect(navigation.agentRuntimeRoutesForOwner({
      source: 'file:///plugins/chatroom-b/index.mjs',
      pluginId,
      moduleGeneration,
    })).toEqual([])
    expect(navigation.agentRuntimeRoutesForOwner({ source, pluginId, moduleGeneration: 'chatroom-generation-two' }))
      .toEqual([])
    expect(navigation.agentRuntimeRouteFromHistory({
      schemaVersion: 1,
      owner: pluginId,
      routeId: `${pluginId}:room-session-detail`,
      outlet: 'main',
      path: '/main/chatroom/room-one/session/cx-session.reviewer',
      params: { roomId: 'room-one', sessionId: 'cx-session.reviewer' },
    })).toMatchObject({
      owner: { source, pluginId, moduleGeneration },
      id: 'room-session-detail',
      schemaVersion: 2,
    })

    await navigation.dispose()
    pages.dispose()
    outlets.dispose()
  })

  it('mounts generic body-only pages in main with plugin-owned chrome and one scroll owner', async () => {
    const dom = new JSDOM('<body><main id="main"></main><main id="app"></main></body>')
    const pages = new PageRegistry()
    const outlets = new OutletRegistry()
    outlets.declare(
      {
        schemaVersion: 1,
        id: 'main',
        authority: 'host-adapter',
        scope: 'main',
        preferredPlacement: 'portal',
        contextPolicy: 'semantic',
        presentationGroup: 'primary',
      },
      new FakeOutlet(dom.window.document.getElementById('main')!, 'main:one'),
      path => path.startsWith('/main/'),
    )
    outlets.declare(
      {
        schemaVersion: 1,
        id: 'app',
        authority: 'host-adapter',
        scope: 'renderer',
        preferredPlacement: 'fixed',
        contextPolicy: 'generation',
        presentationGroup: 'primary',
      },
      new FakeOutlet(dom.window.document.getElementById('app')!, 'renderer'),
      path => !path.startsWith('/main/'),
    )
    const navigation = new NavigationRegistry(pages, outlets, fakeI18n(), new TestCodexRouteHistory())
    const mount = ({ container }: { container: HTMLElement }) => {
      const chrome = container.ownerDocument.createElement('header')
      chrome.className = 'product-chrome'
      chrome.textContent = 'Dynamic room title'
      const timeline = container.ownerDocument.createElement('div')
      timeline.dataset.agentConversationScrollOwner = 'timeline'
      container.append(chrome, timeline)
    }
    pages.register('chatroom', {
      $schema: CORDISX_PAGE_SCHEMA_V3,
      schemaVersion: 3,
      id: 'room',
      title: { key: 'page.room.title', fallback: 'New room' },
      description: { key: 'page.room.description', fallback: 'Product-owned page.' },
      chrome: 'body-only',
    }, mount)
    navigation.register('chatroom', {
      $schema: CORDISX_ROUTE_SCHEMA_V2,
      schemaVersion: 2,
      id: 'room',
      path: '/main/chatroom',
      outlet: 'main',
      page: 'room',
      title: { key: 'route.room.title', fallback: 'New room' },
      description: { key: 'route.room.description', fallback: 'Open the Host-rendered conversation.' },
    })
    navigation.register('chatroom', {
      id: 'room-app',
      path: '/chatroom',
      outlet: 'app',
      page: 'room',
    })

    expect(() =>
      pages.register('chatroom', {
        id: 'room-with-plugin-chrome',
        title: { key: 'page.room-with-plugin-chrome.title', fallback: 'Room' },
        chrome: 'body-only',
        headerActions: [{
          id: 'duplicate',
          label: { key: 'action.duplicate', fallback: 'Duplicate action' },
          command: { id: 'duplicate' },
        }],
      }, () => undefined)
    ).toThrow(/body-only page room-with-plugin-chrome cannot declare/)
    await expect(navigation.navigate('chatroom', { id: 'room-app' })).rejects.toThrow(/persistent external chrome/)

    await navigation.navigate('chatroom', { id: 'room' })
    const page = dom.window.document.querySelector<HTMLElement>('[data-cordisx-page="chatroom:room"]')!
    expect(page.dataset.cordisxPageChromePolicy).toBe('body-only')
    expect(page.querySelectorAll('[data-cordisx-page-chrome]')).toHaveLength(0)
    expect(page.querySelectorAll('.product-chrome')).toHaveLength(1)
    expect(page.querySelectorAll('[data-agent-conversation-scroll-owner="timeline"]')).toHaveLength(1)
    expect(page.querySelector<HTMLElement>('[data-cordisx-page-body]')?.style.overflow).toBe('hidden')

    await navigation.dispose()
    pages.dispose()
    outlets.dispose()
    dom.window.close()
  })

  it('projects localized route/page metadata and diagnoses legacy omissions without inventing purpose', async () => {
    const pages = new PageRegistry()
    const outlets = new OutletRegistry()
    const navigation = new NavigationRegistry(pages, outlets, fakeI18n(), new TestCodexRouteHistory())
    pages.register('demo', {
      $schema: CORDISX_PAGE_SCHEMA_V3,
      schemaVersion: 3,
      id: 'documented',
      title: { key: 'page.documented.title', fallback: 'Documented page' },
      description: { key: 'page.documented.description', fallback: 'Shows documented content for this workspace.' },
    }, () => undefined)
    navigation.register('demo', {
      $schema: CORDISX_ROUTE_SCHEMA_V2,
      schemaVersion: 2,
      id: 'documented',
      path: '/documented',
      outlet: 'app',
      page: 'documented',
      title: { key: 'route.documented.title', fallback: 'Open documented page' },
      description: { key: 'route.documented.description', fallback: 'Opens documented content from the demo entry.' },
    })
    pages.register('legacy', { id: 'page', title: { key: 'legacy.page', fallback: 'Legacy page' } }, () => undefined)
    navigation.register('legacy', { id: 'route', path: '/legacy', outlet: 'app', page: 'page' })
    expect(() =>
      pages.register('invalid', {
        id: 'description-without-version',
        title: { key: 'invalid.page.title' },
        description: { key: 'invalid.page.description' },
      }, () => undefined)
    ).toThrow('legacy page metadata cannot declare description; use page.v3')
    expect(() =>
      pages.register('invalid', {
        $schema: CORDISX_PAGE_SCHEMA_V3,
        schemaVersion: 3,
        id: 'missing-description',
        title: { key: 'invalid.page.title' },
      }, () => undefined)
    ).toThrow('page.v3 requires localized description metadata')
    expect(() =>
      navigation.register('invalid', {
        $schema: CORDISX_ROUTE_SCHEMA_V2,
        schemaVersion: 2,
        id: 'missing-description',
        path: '/invalid',
        outlet: 'app',
        page: 'missing-description',
        title: { key: 'invalid.route.title' },
      })
    ).toThrow('route.v2 requires localized title and description metadata')

    const snapshot = navigation.snapshot()
    expect(snapshot.routes.find(item => item.qualifiedId === 'demo:documented')?.productMetadata).toEqual({
      title: 'Open documented page',
      description: 'Opens documented content from the demo entry.',
      diagnostics: [],
    })
    expect(snapshot.pages.find(item => item.qualifiedId === 'demo:documented')?.productMetadata).toEqual({
      title: 'Documented page',
      description: 'Shows documented content for this workspace.',
      diagnostics: [],
    })
    expect(snapshot.routes.find(item => item.qualifiedId === 'legacy:route')?.productMetadata).toEqual({
      title: undefined,
      description: undefined,
      diagnostics: [
        expect.objectContaining({ code: 'metadata.missing-title', field: 'title' }),
        expect.objectContaining({ code: 'metadata.missing-description', field: 'description' }),
      ],
    })
    expect(snapshot.pages.find(item => item.qualifiedId === 'legacy:page')?.productMetadata).toEqual({
      title: 'Legacy page',
      description: undefined,
      diagnostics: [expect.objectContaining({ code: 'metadata.missing-description', field: 'description' })],
    })

    await navigation.dispose()
    pages.dispose()
    outlets.dispose()
  })

  it('rebinds the current Codex history entry across a same-route generation replacement', async () => {
    const activation = (revision: number, generation: string): CordisXPluginActivationRecordV1 => ({
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1,
      recordKind: revision === 1 ? 'active' : 'candidate',
      ...(revision === 1 ? {} : { transactionId: 'update-demo' }),
      profileId: 'default',
      revision,
      lastGoodRevision: 1,
      runtimeGeneration: 'runtime-1',
      plugins: [{
        id: 'demo',
        version: '1.0.0',
        digest: `sha256:${(revision === 1 ? 'a' : 'b').repeat(64)}`,
        moduleGeneration: generation,
        enabled: true,
        dependencies: [],
      }],
    })
    const previous = activation(1, 'demo-1')
    const candidate = activation(2, 'demo-2')
    const visibility = new GenerationVisibilityCoordinator(previous)
    const pages = new PageRegistry(visibility)
    const outlets = new OutletRegistry()
    const dom = new JSDOM('<body><main id="app"></main></body>')
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
      path => path === '/settings',
    )
    const history = new TestCodexRouteHistory()
    const navigation = new NavigationRegistry(pages, outlets, fakeI18n(), history)
    const source = 'file:///plugins/demo/index.mjs'
    const oldContext = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'demo',
      [CORDISX_PLUGIN_SOURCE]: source,
      [CORDISX_PLUGIN_GENERATION]: 'demo-1',
    })
    pages.register(oldContext, { id: 'settings', title: { key: 'old' } }, ({ container }) => {
      container.textContent = 'old'
    })
    navigation.register(oldContext, { id: 'settings', path: '/settings', outlet: 'app', page: 'settings' })
    await navigation.navigate('demo', { id: 'settings' })
    const currentHistory = history.snapshot()

    const handle = visibility.begin('update-demo', previous, candidate)
    const candidateContext = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'demo',
      [CORDISX_PLUGIN_SOURCE]: source,
      [CORDISX_PLUGIN_GENERATION]: 'demo-2',
      ...visibility.context(handle, 'demo'),
    })
    pages.register(candidateContext, { id: 'settings', title: { key: 'new' } }, ({ container }) => {
      container.textContent = 'new'
    })
    navigation.register(candidateContext, { id: 'settings', path: '/settings', outlet: 'app', page: 'settings' })
    expect(navigation.snapshot().pages[0]?.metadata.title).toEqual({ key: 'old' })
    expect(navigation.snapshot(visibility.view(candidateContext)).pages[0]?.metadata.title).toEqual({ key: 'new' })
    expect(navigation.snapshot(visibility.view(candidateContext)).routes).toHaveLength(1)
    expect(navigation.agentRuntimeRoutesForOwner({
      source,
      pluginId: 'demo',
      moduleGeneration: 'demo-2',
    }, visibility.view(candidateContext))).toEqual([{ id: 'settings', path: '/settings' }])
    expect(navigation.agentRuntimeRoutesForOwner({ source, pluginId: 'demo', moduleGeneration: 'demo-2' })).toEqual([])

    visibility.publish(visibility.preparePublish(handle, visibility.confirmReadiness(handle)))
    await navigation.settled()
    expect(navigation.snapshot().pages[0]?.metadata.title).toEqual({ key: 'new' })
    expect(navigation.snapshot().routes).toHaveLength(1)
    expect(history.snapshot()).toMatchObject({
      key: currentHistory.key,
      index: currentHistory.index,
      entry: currentHistory.entry,
    })
    expect(dom.window.document.querySelector('[data-cordisx-page="demo:settings"]')?.textContent).toContain('new')
    await navigation.dispose()
    pages.dispose()
    outlets.dispose()
    dom.window.close()
  })

  it('restores from Codex location, distinguishes params, follows native forward, and replaces an uninstalled current route', async () => {
    const dom = new JSDOM('<body><main id="main"></main></body>')
    const pages = new PageRegistry()
    const outlets = new OutletRegistry()
    outlets.declare(
      {
        schemaVersion: 1,
        id: 'main',
        authority: 'host-adapter',
        scope: 'main',
        preferredPlacement: 'portal',
        contextPolicy: 'semantic',
      },
      new FakeOutlet(dom.window.document.getElementById('main')!, 'main:one'),
      path => path.startsWith('/main/'),
    )
    const history = new TestCodexRouteHistory()
    history.push(Object.freeze({
      schemaVersion: 1,
      owner: 'chatroom',
      routeId: 'chatroom:room',
      outlet: 'main',
      path: '/main/rooms/one',
      params: Object.freeze({ roomId: 'one' }),
    }))
    const navigation = new NavigationRegistry(pages, outlets, fakeI18n(), history)
    const mounted: string[] = []
    pages.register('chatroom', { id: 'room', title: { key: 'room' } }, ({ container, params }) => {
      mounted.push(String(params.roomId))
      container.textContent = String(params.roomId)
    })
    const unregisterRoute = navigation.register('chatroom', {
      id: 'room',
      path: '/main/rooms/:roomId',
      outlet: 'main',
      page: 'room',
    })

    await navigation.startHistoryProjection()
    expect(navigation.snapshot().outlets[0]).toMatchObject({ activeRoute: 'chatroom:room', mounted: true })
    expect(dom.window.document.querySelector('[data-cordisx-page="chatroom:room"]')?.textContent).toContain('one')

    await navigation.navigate('chatroom', { id: 'room', params: { roomId: 'two' } })
    expect(history.snapshot()).toMatchObject({
      index: 2,
      entry: { routeId: 'chatroom:room', params: { roomId: 'two' } },
    })
    await navigation.back('chatroom', 'main')
    expect(dom.window.document.querySelector('[data-cordisx-page="chatroom:room"]')?.textContent).toContain('one')
    await history.nativeForward()
    await navigation.settled()
    expect(dom.window.document.querySelector('[data-cordisx-page="chatroom:room"]')?.textContent).toContain('two')
    expect(mounted).toEqual(['one', 'two', 'one', 'two'])

    const indexBeforeUnload = history.snapshot().index
    unregisterRoute()
    await navigation.settled()
    expect(history.snapshot()).toMatchObject({ index: indexBeforeUnload })
    expect(history.snapshot().entry).toBeUndefined()
    expect(navigation.snapshot().outlets[0]).toMatchObject({ mounted: false, presentation: 'inactive' })

    await navigation.dispose()
    pages.dispose()
    outlets.dispose()
    dom.window.close()
  })

  it('projects an exact Browser route checkpoint after a new-document state loss before review boot can select New room', async () => {
    const original = new JSDOM('', { url: 'http://127.0.0.1/' })
    const originalHistory = new BrowserRouteHistoryAdapter(original.window as unknown as Window, true)
    originalHistory.push(Object.freeze({
      schemaVersion: 1,
      owner: 'chatroom',
      routeId: 'chatroom:room',
      outlet: 'main',
      path: '/main/chatroom/room-1',
      params: Object.freeze({ roomId: 'room-1' }),
    }))
    const originalState = original.window.history.state as { readonly key: string; readonly idx: number }

    const dom = new JSDOM(
      '<body><main id="main"></main><nav><div data-sidebar-item="chatroom:chatroom"><button class="cxsi-primary">New room</button></div></nav></body>',
      {
        url: 'http://127.0.0.1/',
      },
    )
    copySessionStorage(original.window.sessionStorage, dom.window.sessionStorage)
    // The new Browser document has retained React's key/index but not the
    // Host route payload; BrowserRouteHistoryAdapter must recover only its
    // own exact checkpoint before registered routes begin projection.
    dom.window.history.replaceState({ key: originalState.key, idx: originalState.idx }, '', '/')
    const history = new BrowserRouteHistoryAdapter(dom.window as unknown as Window, true)
    const pages = new PageRegistry()
    const outlets = new OutletRegistry()
    outlets.declare(
      {
        schemaVersion: 1,
        id: 'main',
        authority: 'host-adapter',
        scope: 'main',
        preferredPlacement: 'portal',
        contextPolicy: 'semantic',
      },
      new FakeOutlet(dom.window.document.getElementById('main')!, 'main:one'),
      path => path.startsWith('/main/'),
    )
    const navigation = new NavigationRegistry(pages, outlets, fakeI18n(), history)
    pages.register('chatroom', { id: 'room', title: { key: 'room' } }, ({ container, params }) => {
      container.textContent = `room:${String(params.roomId)}`
    })
    navigation.register('chatroom', { id: 'room', path: '/main/chatroom/:roomId', outlet: 'main', page: 'room' })

    await navigation.startHistoryProjection()
    let newRoomActivations = 0
    dom.window.document.querySelector('button')?.addEventListener('click', () => {
      newRoomActivations += 1
    })
    activatePlaygroundReviewNavigation(dom.window.document, 'chatroom:chatroom')

    expect(history.snapshot()).toMatchObject({ entry: { routeId: 'chatroom:room', params: { roomId: 'room-1' } } })
    expect(dom.window.document.querySelector('[data-cordisx-page="chatroom:room"]')?.textContent).toContain(
      'room:room-1',
    )
    expect(newRoomActivations).toBe(0)

    await navigation.dispose()
    pages.dispose()
    outlets.dispose()
    history.dispose()
    originalHistory.dispose()
    dom.window.close()
    original.window.close()
  })

  it('holds an exact reloaded Room route while Host review access is pending, then mounts only after authorization and clears terminal denials', async () => {
    const original = new JSDOM('', { url: 'http://127.0.0.1/' })
    const originalHistory = new BrowserRouteHistoryAdapter(original.window as unknown as Window, true)
    originalHistory.push(Object.freeze({
      schemaVersion: 1,
      owner: 'chatroom',
      routeId: 'chatroom:room',
      outlet: 'main',
      path: '/main/chatroom/room-1',
      params: Object.freeze({ roomId: 'room-1' }),
    }))
    const originalState = original.window.history.state as { readonly key: string; readonly idx: number }

    const dom = new JSDOM(
      '<body><main id="main"></main><nav><div data-sidebar-item="chatroom:chatroom"><button class="cxsi-primary">New room</button></div></nav></body>',
      {
        url: 'http://127.0.0.1/',
      },
    )
    copySessionStorage(original.window.sessionStorage, dom.window.sessionStorage)
    dom.window.history.replaceState({ key: originalState.key, idx: originalState.idx }, '', '/')
    const history = new BrowserRouteHistoryAdapter(dom.window as unknown as Window, true)
    const pages = new PageRegistry()
    const outlets = new OutletRegistry()
    outlets.declare(
      {
        schemaVersion: 1,
        id: 'main',
        authority: 'host-adapter',
        scope: 'main',
        preferredPlacement: 'portal',
        contextPolicy: 'semantic',
      },
      new FakeOutlet(dom.window.document.getElementById('main')!, 'main:one'),
      path => path.startsWith('/main/'),
    )
    let accessState: 'pending' | 'allowed' | 'denied' | 'stale' = 'pending'
    const accessDecision = () =>
      accessState === 'allowed'
        ? { policy: 'allow' as const, effectivePolicy: 'allow' as const, authorized: true }
        : accessState === 'pending'
        ? {
          policy: 'inherit' as const,
          effectivePolicy: 'deny' as const,
          authorized: false,
          reason: 'permission.review-pending',
        }
        : accessState === 'denied'
        ? {
          policy: 'deny' as const,
          effectivePolicy: 'deny' as const,
          authorized: false,
          reason: 'permission.denied-persistent',
        }
        : {
          policy: 'inherit' as const,
          effectivePolicy: 'deny' as const,
          authorized: false,
          reason: 'permission.identity-unavailable',
        }
    const access: ExtensionPointAccessResolver = {
      decision: () => accessDecision(),
      surfaceAnchorSupport: () => ({ supported: true }),
      authorizeSurfaceCommand: () => accessDecision(),
      authorizeSurfaceRoute: () => accessDecision(),
      authorizeOutletRoute: () => accessDecision(),
      authorizeOutletPage: () => accessDecision(),
      authorizeOutletPageCommand: () => accessDecision(),
    }
    const navigation = new NavigationRegistry(pages, outlets, fakeI18n(), history, undefined, access)
    pages.register('chatroom', { id: 'room', title: { key: 'room' } }, ({ container, params }) => {
      container.textContent = `room:${String(params.roomId)}`
    })
    navigation.register('chatroom', { id: 'room', path: '/main/chatroom/:roomId', outlet: 'main', page: 'room' })

    await navigation.startHistoryProjection()
    let newRoomActivations = 0
    dom.window.document.querySelector('button')?.addEventListener('click', () => {
      newRoomActivations += 1
    })
    activatePlaygroundReviewNavigation(dom.window.document, 'chatroom:chatroom')
    expect(history.snapshot()).toMatchObject({
      entry: { owner: 'chatroom', routeId: 'chatroom:room', params: { roomId: 'room-1' } },
    })
    expect(dom.window.document.querySelector('[data-cordisx-page="chatroom:room"]')).toBeNull()
    expect(newRoomActivations).toBe(0)

    accessState = 'allowed'
    await navigation.invalidatePointPolicies()
    expect(dom.window.document.querySelector('[data-cordisx-page="chatroom:room"]')?.textContent).toContain(
      'room:room-1',
    )

    accessState = 'denied'
    await navigation.invalidatePointPolicies()
    expect(history.snapshot().entry).toBeUndefined()
    expect(dom.window.document.querySelector('[data-cordisx-page="chatroom:room"]')).toBeNull()

    dom.window.history.pushState(
      {
        __cordisxRouteV1: {
          schemaVersion: 1,
          owner: 'foreign',
          routeId: 'foreign:room',
          outlet: 'main',
          path: '/main/chatroom/room-1',
          params: { roomId: 'room-1' },
        },
      },
      '',
      '/',
    )
    await settle()
    await navigation.settled()
    expect(history.snapshot().entry).toBeUndefined()

    accessState = 'stale'
    dom.window.history.pushState(
      {
        __cordisxRouteV1: {
          schemaVersion: 1,
          owner: 'chatroom',
          routeId: 'chatroom:room',
          outlet: 'main',
          path: '/main/chatroom/room-1',
          params: { roomId: 'room-1' },
        },
      },
      '',
      '/',
    )
    await settle()
    await navigation.settled()
    expect(history.snapshot().entry).toBeUndefined()

    await navigation.dispose()
    pages.dispose()
    outlets.dispose()
    history.dispose()
    originalHistory.dispose()
    dom.window.close()
    original.window.close()
  })

  it('moves one mounted page across same-key anchor replacement and disposes on context switch', async () => {
    const dom = new JSDOM('<body><main id="one"></main><main id="two"></main></body>')
    const pages = new PageRegistry()
    const outlets = new OutletRegistry()
    const controller = new FakeOutlet(dom.window.document.getElementById('one')!)
    outlets.declare(
      {
        schemaVersion: 1,
        id: 'main',
        authority: 'host-adapter',
        scope: 'main',
        preferredPlacement: 'absolute',
        contextPolicy: 'semantic',
      },
      controller,
      path => path.startsWith('/main/'),
    )
    const navigation = new NavigationRegistry(pages, outlets, fakeI18n(), new TestCodexRouteHistory())
    let mounts = 0
    let cleanups = 0
    let aborted = false
    pages.register('demo', { id: 'analytics', title: { key: 'title' } }, (context) => {
      mounts += 1
      context.signal.addEventListener('abort', () => {
        aborted = true
      })
      context.localization.effect(() => () => {
        cleanups += 1
      })
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
}
