import { JSDOM } from 'jsdom'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { createPermissionPolicyRecord } from '../../packages/cli/src/permissions.js'
import {
  activatePlaygroundReviewNavigation,
  authorizePlaygroundReviewNavigation,
} from '../../packages/cli/src/playground/client/review-navigation.js'
import {
  clearPlaygroundSimulatorSessionRegistry,
  subscribePlaygroundTaskLocation,
} from '../../packages/cli/src/playground/client/task-details-navigation.js'
import { defaultUiPlaygroundConfig } from '../../packages/cli/src/playground/defaults.js'
import { startUiPlayground } from '../../packages/cli/src/playground/server.js'
import { createPlaygroundSession } from '../../packages/cli/src/playground/session.js'
import { createSidebarItem } from '../../packages/cli/src/renderer/host-ui/SidebarItem.js'
import { exactDomPermissionPolicies } from '../helpers/dom-permission.js'
import { defaultPluginIds } from './ui-playground.fixtures.js'

export function registerNavigationTests() {
  it('authorizes only the exact review contribution owner on the sidebar navigation point', async () => {
    const calls: unknown[][] = []
    const runtime = {
      snapshot: () => ({
        plugins: [
          { id: 'chatroom', source: 'file:///plugins/chatroom.ts', status: 'active' },
          { id: 'other', source: 'file:///plugins/other.ts', status: 'active' },
        ],
        registrations: [
          {
            owner: 'other',
            qualifiedId: 'other:row',
            surface: 'sidebar.navigation.items',
            authorized: false,
            pointPolicyReason: 'permission.review-pending',
          },
          {
            owner: 'chatroom',
            qualifiedId: 'chatroom:chatroom',
            surface: 'sidebar.navigation.items',
            authorized: false,
            pointPolicyReason: 'permission.review-pending',
            item: { route: { id: 'new-room' } },
          },
        ],
        navigation: { routes: [{ owner: 'chatroom', id: 'new-room', definition: { outlet: 'main' } }] },
      }),
      setExtensionPointPolicies: async (...args: unknown[]) => {
        calls.push(args)
      },
    }
    await authorizePlaygroundReviewNavigation(runtime, 'chatroom:chatroom')
    expect(calls).toEqual([['file:///plugins/chatroom.ts', 'chatroom', [
      { pointId: 'sidebar.navigation.items', policy: 'allow' },
      { pointId: 'main', policy: 'allow' },
    ]]])
  })

  it('authorizes the exact Manager root in a fresh review and preserves explicit denial', async () => {
    const calls: unknown[][] = []
    const root = {
      owner: 'game',
      qualifiedId: 'game:manager',
      surface: 'manager.settings.navigation-items',
      authorized: false,
      pointPolicyReason: 'permission.review-pending',
      item: { route: { id: 'home' } },
    }
    const runtime = {
      snapshot: () => ({
        plugins: [{ id: 'game', source: 'file:///game.ts', status: 'active' }],
        registrations: [
          {
            owner: 'game',
            qualifiedId: 'game:home',
            surface: 'sidebar.navigation.items',
            authorized: true,
            item: { route: { id: 'home' } },
          },
          root,
          { ...root, owner: 'other', qualifiedId: 'other:manager' },
        ],
        navigation: {
          routes: [{ owner: 'game', id: 'home', authorized: true, definition: { outlet: 'manager.content' } }],
        },
      }),
      setExtensionPointPolicies: async (...args: unknown[]) => {
        calls.push(args)
      },
    }
    await authorizePlaygroundReviewNavigation(runtime, 'game:home')
    expect(calls).toEqual([['file:///game.ts', 'game', [{
      pointId: 'manager.settings.navigation-items',
      policy: 'allow',
    }]]])
    calls.length = 0
    root.pointPolicyReason = 'permission.policy-denied'
    await authorizePlaygroundReviewNavigation(runtime, 'game:home')
    expect(calls).toEqual([])
    root.authorized = true
    await authorizePlaygroundReviewNavigation(runtime, 'game:home')
    expect(calls).toEqual([])
  })

  it('does not override an explicit denial or authorize a non-sidebar review contribution', async () => {
    const calls: unknown[][] = []
    const runtime = {
      snapshot: () => ({
        plugins: [{ id: 'chatroom', source: 'file:///plugins/chatroom.ts', status: 'active' }],
        registrations: [
          {
            owner: 'chatroom',
            qualifiedId: 'chatroom:chatroom',
            surface: 'sidebar.navigation.items',
            authorized: false,
            pointPolicyReason: 'permission.policy-denied',
          },
          {
            owner: 'chatroom',
            qualifiedId: 'chatroom:toolbar',
            surface: 'workspace.toolbar.items',
            authorized: false,
            pointPolicyReason: 'permission.review-pending',
          },
        ],
        navigation: { routes: [] },
      }),
      setExtensionPointPolicies: async (...args: unknown[]) => {
        calls.push(args)
      },
    }
    await authorizePlaygroundReviewNavigation(runtime, 'chatroom:chatroom')
    await authorizePlaygroundReviewNavigation(runtime, 'chatroom:toolbar')
    expect(calls).toEqual([])
  })

  it('fails closed when the runtime rejects the atomic review policy replacement', async () => {
    const calls: unknown[][] = []
    const runtime = {
      snapshot: () => ({
        plugins: [{ id: 'chatroom', source: 'file:///plugins/chatroom.ts', status: 'active' }],
        registrations: [{
          owner: 'chatroom',
          qualifiedId: 'chatroom:chatroom',
          surface: 'sidebar.navigation.items',
          authorized: false,
          pointPolicyReason: 'permission.review-pending',
          item: { route: { id: 'new-room' } },
        }],
        navigation: { routes: [{ owner: 'chatroom', id: 'new-room', definition: { outlet: 'main' } }] },
      }),
      setExtensionPointPolicies: async (...args: unknown[]) => {
        calls.push(args)
        throw new Error('atomic policy replacement unavailable')
      },
    }
    await expect(authorizePlaygroundReviewNavigation(runtime, 'chatroom:chatroom')).rejects.toThrow(
      'atomic policy replacement unavailable',
    )
    expect(calls).toEqual([['file:///plugins/chatroom.ts', 'chatroom', [
      { pointId: 'sidebar.navigation.items', policy: 'allow' },
      { pointId: 'main', policy: 'allow' },
    ]]])
  })

  it('restores the Host outlet before a Room route projects during Task history back and forward', async () => {
    const dom = new JSDOM(
      '<!doctype html><body><div id="root"><main data-host-seats><div data-cordisx-playground-seat="main"></div></main></div></body>',
      {
        url: 'http://127.0.0.1/',
      },
    )
    const roomEntry = {
      key: 'room',
      idx: 1,
      __cordisxRouteV1: {
        schemaVersion: 1,
        owner: 'chatroom',
        routeId: 'chatroom:room',
        outlet: 'main',
        params: { roomId: 'room-1' },
      },
    }
    dom.window.history.replaceState(roomEntry, '', '/')
    const root = dom.window.document.getElementById('root')!
    const dispose = subscribePlaygroundTaskLocation(dom.window, taskId => {
      root.innerHTML = taskId === undefined
        ? '<main data-host-seats><div data-cordisx-playground-seat="main"></div></main>'
        : `<main data-playground-simulator="true">${taskId}</main>`
    })
    dom.window.addEventListener('popstate', () => {
      const route = dom.window.history.state?.__cordisxRouteV1
      const outlet = dom.window.document.querySelector('[data-cordisx-playground-seat="main"]')
      if (route?.params?.roomId === 'room-1' && outlet !== null) {
        outlet.innerHTML = '<article data-room-page="room-1">Room one</article>'
      }
    })

    dom.window.history.pushState({ key: 'task', idx: 2 }, '', '/playground/simulator/tasks/Lead')
    dom.window.dispatchEvent(new dom.window.Event('cordisx:host-task-details-navigation'))
    expect(dom.window.document.querySelector('[data-playground-simulator]')?.textContent).toBe('Lead')

    dom.window.history.back()
    await new Promise(resolve => dom.window.addEventListener('popstate', resolve, { once: true }))
    expect(dom.window.document.querySelector('[data-room-page="room-1"]')?.textContent).toBe('Room one')
    dom.window.history.forward()
    await new Promise(resolve => dom.window.addEventListener('popstate', resolve, { once: true }))
    expect(dom.window.document.querySelector('[data-playground-simulator]')?.textContent).toBe('Lead')
    dom.window.history.back()
    await new Promise(resolve => dom.window.addEventListener('popstate', resolve, { once: true }))
    expect(dom.window.document.querySelectorAll('[data-room-page="room-1"]')).toHaveLength(1)

    dispose()
    dom.window.close()
  })

  it('resets only namespaced Simulator session registries', () => {
    const dom = new JSDOM('', { url: 'http://127.0.0.1/' })
    dom.window.sessionStorage.setItem('cordisx.playground.simulator/v1:playground:chatroom', '{"tasks":[1]}')
    dom.window.sessionStorage.setItem('cordisx.playground.simulator/v1:other:plugin', '{"tasks":[2]}')
    dom.window.sessionStorage.setItem('cordisx.unrelated.session', 'keep')
    clearPlaygroundSimulatorSessionRegistry(dom.window.sessionStorage)
    expect(dom.window.sessionStorage.getItem('cordisx.playground.simulator/v1:playground:chatroom')).toBeNull()
    expect(dom.window.sessionStorage.getItem('cordisx.playground.simulator/v1:other:plugin')).toBeNull()
    expect(dom.window.sessionStorage.getItem('cordisx.unrelated.session')).toBe('keep')
    dom.window.close()
  })

  it('enters an exact configured review navigation row without selecting a debug fixture', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-review-navigation-'))
    const configPath = path.join(root, 'cordisx.config.json')
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        playground: { name: 'External review', reviewNavigationItem: 'chatroom:chatroom' },
        plugins: [],
      }),
    )
    const session = await createPlaygroundSession(configPath)
    expect(session.fixture).toEqual({
      name: 'External review',
      source: 'cordisx.config.json',
      reviewNavigationItem: 'chatroom:chatroom',
    })

    const dom = new JSDOM(
      '<!doctype html><body><nav data-cordisx-playground-surface="sidebar.navigation.items"></nav></body>',
      { url: 'http://127.0.0.1/' },
    )
    let exactActivations = 0
    let adjacentActivations = 0
    const dispose = activatePlaygroundReviewNavigation(dom.window.document, session.fixture.reviewNavigationItem!)
    const adjacent = createSidebarItem(dom.window.document, {
      id: 'chatroom:other',
      label: 'Other',
      onActivate: () => {
        adjacentActivations += 1
      },
    })
    const exact = createSidebarItem(dom.window.document, {
      id: 'chatroom:chatroom',
      label: 'New room',
      onActivate: () => {
        exactActivations += 1
      },
    })
    dom.window.document.querySelector('nav')?.append(adjacent.element, exact.element)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(exactActivations).toBe(1)
    expect(adjacentActivations).toBe(0)
    dispose()
    dom.window.close()
    await session.close()
    await rm(root, { recursive: true, force: true })
  })

  it('preserves existing plugin and Host task history entries during review boot', () => {
    const plugin = new JSDOM(
      '<!doctype html><body><nav><div data-sidebar-item="chatroom:chatroom"><button class="cxsi-primary">New room</button></div></nav></body>',
      { url: 'http://127.0.0.1/' },
    )
    plugin.window.history.replaceState(
      {
        __cordisxRouteV1: {
          schemaVersion: 1,
          owner: 'chatroom',
          routeId: 'chatroom:room',
          outlet: 'main',
          params: { roomId: 'room-2' },
        },
      },
      '',
      '/',
    )
    let pluginActivations = 0
    plugin.window.document.querySelector('button')?.addEventListener('click', () => {
      pluginActivations += 1
    })
    activatePlaygroundReviewNavigation(plugin.window.document, 'chatroom:chatroom')
    expect(pluginActivations).toBe(0)
    expect(plugin.window.history.state.__cordisxRouteV1.params.roomId).toBe('room-2')
    plugin.window.close()

    const task = new JSDOM(
      '<!doctype html><body><nav><div data-sidebar-item="chatroom:chatroom"><button class="cxsi-primary">New room</button></div></nav></body>',
      {
        url: 'http://127.0.0.1/playground/simulator/tasks/Simulator%20Task%201',
      },
    )
    let taskActivations = 0
    task.window.document.querySelector('button')?.addEventListener('click', () => {
      taskActivations += 1
    })
    activatePlaygroundReviewNavigation(task.window.document, 'chatroom:chatroom')
    expect(taskActivations).toBe(0)
    expect(task.window.location.pathname).toBe('/playground/simulator/tasks/Simulator%20Task%201')
    task.window.close()
  })

  it('rejects a non-qualified Playground review navigation target', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-review-navigation-invalid-'))
    const configPath = path.join(root, 'cordisx.config.json')
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        playground: { reviewNavigationItem: 'chatroom' },
        plugins: [],
      }),
    )
    await expect(createPlaygroundSession(configPath)).rejects.toThrow(
      'playground.reviewNavigationItem must be an exact owner-qualified contribution id',
    )
    await rm(root, { recursive: true, force: true })
  })

  it('renders the official Manager BrandMark through the same Host SidebarItem primitive', async () => {
    const [app, manager, styles] = await Promise.all([
      readFile(path.resolve('packages/cli/src/playground/client/App.tsx'), 'utf8'),
      readFile(path.resolve('packages/cli/src/renderer/manager/ManagerApp.tsx'), 'utf8'),
      readFile(path.resolve('packages/cli/src/playground/client/styles.css'), 'utf8'),
    ])

    expect(app).toContain(
      '<span className="pg-manager-anchor" data-cordisx-playground-manager-trigger aria-hidden="true" />',
    )
    expect(app.match(/data-cordisx-playground-manager-trigger/g)).toHaveLength(1)
    expect(app.indexOf('data-cordisx-playground-manager-trigger')).toBeLessThan(app.indexOf('action.new'))
    expect(manager).toContain("id: 'host.manager'")
    expect(manager).toContain("secondary: 'UI Playground'")
    expect(manager).toContain('iconElement: createBrandMarkElement')
    expect(manager).toContain('const item = createSidebarItem(')
    expect(styles).not.toContain('.pg-brand-row')
    expect(styles).toContain('.pg-sidebar .cxsi-brand-mark')
    expect(styles).not.toContain('.pg-sidebar-footer .cxr-trigger-seat')
    expect(styles).toContain(
      'html[data-theme="light"] .pg-sidebar .cxsi-brand-mark > .cxr-brand-mark-light { display: block; }',
    )
  })

  it('uses one Host sidebar primitive and one accessible sidebar environment menu', async () => {
    const [app, seats, styles, adapter, rendererLayout, rendererInteractions, menu, environment] = await Promise.all([
      readFile(path.resolve('packages/cli/src/playground/client/App.tsx'), 'utf8'),
      readFile(path.resolve('packages/cli/src/playground/client/components/HostSeats.tsx'), 'utf8'),
      readFile(path.resolve('packages/cli/src/playground/client/styles.css'), 'utf8'),
      readFile(path.resolve('packages/cli/src/renderer/adapter.ts'), 'utf8'),
      readFile(path.resolve('packages/cli/src/renderer/adapter/renderer-layout.ts'), 'utf8'),
      readFile(path.resolve('packages/cli/src/renderer/adapter/renderer-interactions.ts'), 'utf8'),
      readFile(path.resolve('packages/cli/src/renderer/host-ui/HostMenu.tsx'), 'utf8'),
      readFile(path.resolve('packages/cli/src/playground/client/environment.ts'), 'utf8'),
    ])
    expect(app).toContain('createSidebarItem(document')
    expect(adapter).toContain("from './adapter/renderer-layout.js'")
    expect(adapter).toContain('new StructuredSurfaceRenderer(')
    expect(rendererLayout).toContain('extends StructuredSurfaceInteractions')
    expect(rendererLayout).toContain("from './renderer-interactions.js'")
    expect(rendererLayout).toContain('this.renderNavigation(')
    expect(rendererInteractions).toContain('createSidebarItem(this.document')
    expect(app).toContain('id="action.new"')
    expect(app).toContain('data-cordisx-playground-surface="sidebar.navigation.items"')
    expect(app).toContain('secondary={en ?')
    expect(styles).toContain('.pg-sidebar .cxsi-primary { display: grid; width: 100%;')
    expect(styles).toContain('.pg-sidebar .cxsi-copy, .pg-sidebar .cxsi-actions')
    expect(seats).not.toContain('pg-workspace-toolbar')
    expect(seats).not.toContain('AgentConversationRenderer')
    expect(seats).toContain('Product pages are supplied only by plugins')
    expect(seats).not.toContain('pg-session-header')
    expect(seats).not.toContain('pg-timeline')
    expect(seats).not.toContain('pg-composer')
    expect(styles).not.toContain('.pg-workspace-toolbar')
    expect(styles).not.toContain('.pg-session-header')
    expect(styles).not.toContain('.pg-timeline')
    expect(styles).not.toContain('.pg-composer')
    expect(app).not.toContain('pg-devtools')
    expect(styles).not.toContain('.pg-devtools')
    expect(app.match(/className="pg-sidebar-control"/g)).toHaveLength(1)
    expect(menu).toContain('aria-haspopup="menu"')
    expect(menu).toContain("event.key === 'Escape'")
    expect(menu).toContain("event.key === 'ArrowDown' || event.key === 'ArrowRight'")
    expect(environment).toContain('new HostThemeProjection(document)')
    expect(environment).toContain('new DocumentLocaleAdapter(document)')
  })

  it('keeps review tasks in one Recent tasks section and excludes Playground fixtures', async () => {
    const [app, seats, styles, viteServer] = await Promise.all([
      readFile(path.resolve('packages/cli/src/playground/client/App.tsx'), 'utf8'),
      readFile(path.resolve('packages/cli/src/playground/client/components/HostSeats.tsx'), 'utf8'),
      readFile(path.resolve('packages/cli/src/playground/client/styles.css'), 'utf8'),
      readFile(path.resolve('packages/cli/src/playground/vite/server.ts'), 'utf8'),
    ])
    expect(app.match(/id="pg-recent-task-list-title"/g)).toHaveLength(1)
    expect(styles).toContain('.pg-recent-task-list > [data-recent-task-row] .cxsi-icon { border-radius: 50%; }')
    expect(app).toContain("en ? 'Recent tasks' : '最近任务'")
    expect(app).toContain("en ? 'No recent tasks.' : '暂无最近任务。'")
    expect(app).toContain("en ? 'Scenario' : '场景'")
    expect(app).toContain('data-recent-task-row')
    expect(app).toContain('icon="host:history"')
    expect(app).not.toContain('HostAgentAvatar')
    expect(app).not.toContain('task.effective.avatar')
    expect(app).toContain('onClickCapture={preparePluginNavigation}')
    expect(app).toContain('flushSync(() => setSimulatorTaskId(undefined))')
    expect(app).toContain('subscribePlaygroundTaskLocation(window')
    expect(app).toContain('clearPlaygroundSimulatorSessionRegistry(sessionStorage)')
    expect(app).not.toContain('playgroundEnvironment.resetPreferences()')
    expect(app).not.toContain('localStorage.clear()')
    expect(app).toContain('fixture.reviewNavigationItem === undefined')
    expect(app).toContain("en ? 'Playground fixtures' : 'Playground 测试场景'")
    expect(app).not.toContain('pg-simulator-task-list')
    expect(app).toContain('fixture.reviewNavigationItem === undefined')
    expect(seats).toContain('Product pages are supplied only by plugins')
    expect(seats).not.toContain('AgentConversationRenderer')
    expect(styles).not.toContain('插件导航贡献会显示在这里')
    expect(viteServer).toContain("url.pathname === '/api/documents'")
    expect(viteServer).toContain('session.handleOwnerDocumentRequest(await requestBody(request))')
  })

  it('renders brand, built-in, contributed, and recent rows with one readable semantic primitive', async () => {
    const styles = await readFile(path.resolve('packages/cli/src/playground/client/styles.css'), 'utf8')
    const dom = new JSDOM(
      `<!doctype html><html data-theme="dark"><head><style>${styles}</style></head><body><aside class="pg-sidebar"></aside></body></html>`,
      { url: 'http://127.0.0.1/' },
    )
    let activations = 0
    const brandMark = dom.window.document.createElement('span')
    brandMark.className = 'cxsi-brand-mark'
    const brand = createSidebarItem(dom.window.document, {
      id: 'brand',
      label: 'CordisX',
      secondary: 'UI Playground',
      iconElement: brandMark,
      onActivate: () => {
        activations += 1
      },
    })
    const single = createSidebarItem(dom.window.document, {
      id: 'built-in',
      label: 'Playground',
      icon: 'host:playground',
      onActivate: () => {
        activations += 1
      },
    })
    const recent = createSidebarItem(dom.window.document, {
      id: 'recent',
      label: 'Room',
      secondary: 'Latest task',
      icon: 'host:history',
      selected: true,
      onActivate: () => {
        activations += 1
      },
    })
    dom.window.document.querySelector('.pg-sidebar')?.append(brand.element, single.element, recent.element)
    expect(brand.primary.classList.contains('cxsi-primary')).toBe(true)
    expect(single.primary.classList.contains('cxsi-primary')).toBe(true)
    expect(recent.primary.classList.contains('cxsi-primary')).toBe(true)
    expect(brand.element.dataset.variant).toBe('two-line')
    expect(single.element.dataset.variant).toBe('single-line')
    expect(recent.element.dataset.variant).toBe('two-line')
    expect(recent.element.dataset.selected).toBe('true')
    const darkUnselected = dom.window.getComputedStyle(single.primary).color
    const darkSelected = dom.window.getComputedStyle(recent.primary).color
    expect(darkUnselected).toBe('var(--pg-muted)')
    expect(darkSelected).toBe('var(--pg-text)')
    expect(dom.window.getComputedStyle(dom.window.document.documentElement).getPropertyValue('--pg-muted').trim()).toBe(
      '#999',
    )
    expect(dom.window.getComputedStyle(dom.window.document.documentElement).getPropertyValue('--pg-text').trim()).toBe(
      '#ececec',
    )
    expect(single.primary.querySelector('svg')?.getAttribute('fill') ?? '').not.toMatch(/black|#000(?:000)?/i)
    expect(
      [...single.primary.querySelectorAll('[fill], [stroke]')].map(node =>
        `${node.getAttribute('fill')} ${node.getAttribute('stroke')}`
      ).join(' '),
    ).not.toMatch(/black|#000(?:000)?/i)
    dom.window.document.documentElement.dataset.theme = 'light'
    expect(dom.window.getComputedStyle(single.primary).color).toBe('var(--pg-muted)')
    expect(dom.window.getComputedStyle(recent.primary).color).toBe('var(--pg-text)')
    expect(dom.window.getComputedStyle(dom.window.document.documentElement).getPropertyValue('--pg-muted').trim()).toBe(
      '#6f6f6b',
    )
    expect(dom.window.getComputedStyle(dom.window.document.documentElement).getPropertyValue('--pg-text').trim()).toBe(
      '#202020',
    )
    brand.primary.click()
    single.primary.click()
    recent.primary.click()
    expect(activations).toBe(3)
    recent.setSelected(true, true)
    expect(recent.primary.getAttribute('aria-current')).toBe('page')
    recent.setDisabled(true)
    expect(recent.primary.getAttribute('aria-disabled')).toBe('true')
    recent.setDisabled(false)
    recent.dispose()
    recent.primary.click()
    expect(activations).toBe(3)
    expect(dom.window.document.querySelector('[data-sidebar-item="recent"]')).toBeNull()
    dom.window.close()
  })

  it('serves a loopback production renderer bundle and removes isolated state on close', async () => {
    const source = await readFile(defaultUiPlaygroundConfig, 'utf8')
    const playground = await startUiPlayground({ configPath: defaultUiPlaygroundConfig })
    try {
      expect(playground.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
      const page = await fetch(playground.url).then(response => response.text())
      expect(page).toContain('data-cordisx-playground-manager-trigger')
      expect(page).toContain('Comprehensive UI demos')
      expect(page).toContain('data-pg-plugin-count')
      expect(page).toContain('npm run dev:ui -- --config')
      expect(page).toContain('__cordisxServiceConfigRequestV1')
      expect(page).toContain('__cordisxChannelCredentialRequestV1')
      const bundle = await fetch(`${playground.url}api/bundle`).then(response => response.text())
      expect(bundle).toContain('hostKind: "playground"')
      expect(bundle).toContain('installCordisX')
      expect(bundle).toContain('pluginBundleSnapshot:')
      expect(bundle).toContain('Workflow Essentials')
      const serviceConfigToken = /serviceConfigBridgeToken: "([a-f0-9]{64})"/.exec(bundle)?.[1]
      const generation = /generation: "(playground-[a-f0-9]+)"/.exec(bundle)?.[1]
      expect(serviceConfigToken).toBeDefined()
      expect(generation).toBeDefined()
      const serviceList = await fetch(`${playground.url}api/service-config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          token: serviceConfigToken,
          requestId: 'playground-service-list',
          operation: 'list',
          pluginId: 'channel',
          scope: { profileId: 'playground', generation },
        }),
      }).then(response => response.json()) as { ok: boolean; value?: Array<{ writable?: boolean }> }
      expect(serviceList.ok).toBe(true)
      expect(serviceList.value?.[0]?.writable).toBe(true)
      const materialized = path.join(playground.homeDir, 'config', 'playground.config.json')
      const materializedInitial = await readFile(materialized, 'utf8')
      expect(JSON.parse(materializedInitial).plugins.map((plugin: { id: string }) => plugin.id)).toEqual(
        defaultPluginIds,
      )
      await writeFile(materialized, '{"version":1,"plugins":[]}\n')
      await fetch(`${playground.url}api/reset`, { method: 'POST' }).then(response => expect(response.ok).toBe(true))
      expect(await readFile(materialized, 'utf8')).toBe(materializedInitial)
      expect(await readFile(defaultUiPlaygroundConfig, 'utf8')).toBe(source)
    } finally {
      const home = playground.homeDir
      await playground.close()
      await expect(access(home)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  }, 30_000)

  it('applies explicit narrow preview permissions without claiming an AgentLoop backend', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-playground-permissions-'))
    const entry = path.resolve('tests/fixtures/agent-loop-runtime-plugin.ts')
    const identity = { source: pathToFileURL(entry).href, id: 'agent-loop-runtime' }
    const policies = (['tasks.create', 'tasks.content.read', 'turns.submit'] as const).map(capability =>
      createPermissionPolicyRecord({
        profileId: 'playground',
        identity,
        capability,
        scope: { providers: ['gateway-a'] },
        policy: 'allow',
      })
    )
    const configPath = path.join(root, 'cordisx.config.json')
    await writeFile(
      configPath,
      `${
        JSON.stringify({
          version: 1,
          plugins: [{ id: identity.id, entry, enabled: true, config: {} }],
          playground: { permissionPolicies: policies },
        })
      }\n`,
    )
    const playground = await startUiPlayground({ configPath })
    try {
      const bundle = await fetch(`${playground.url}api/bundle`).then(response => response.text())
      const dom = new JSDOM(
        '<!doctype html><html><body><nav data-cordisx-playground-surface="sidebar.navigation.items"></nav></body></html>',
        {
          runScripts: 'dangerously',
          url: playground.url,
        },
      )
      try {
        Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
        Object.defineProperty(dom.window, 'structuredClone', { value: globalThis.structuredClone })
        dom.window.eval(bundle)
        await (dom.window as unknown as { __cordisxBoot?: Promise<unknown> }).__cordisxBoot
        const snapshot = (dom.window as unknown as {
          __cordisxRuntime?: {
            snapshot(): {
              plugins: readonly { id: string; status: string; blockedReason?: string }[]
              permissions: readonly { capability: string; policy: string; availability: { status: string } }[]
            }
            dispose(): Promise<void>
          }
        }).__cordisxRuntime?.snapshot()
        expect(snapshot?.plugins).toEqual([expect.objectContaining({ id: identity.id, status: 'active' })])
        expect(
          snapshot?.permissions.map(item => ({
            capability: item.capability,
            policy: item.policy,
            availability: item.availability.status,
          })),
        ).toEqual([
          { capability: 'tasks.create', policy: 'allow', availability: 'unavailable' },
          { capability: 'tasks.content.read', policy: 'allow', availability: 'unavailable' },
          { capability: 'turns.submit', policy: 'allow', availability: 'unavailable' },
        ])
        await (dom.window as unknown as { __cordisxRuntime?: { dispose(): Promise<void> } }).__cordisxRuntime?.dispose()
      } finally {
        dom.window.close()
      }
    } finally {
      await playground.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('materializes exact v3 DOM review permissions without downgrading them', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-playground-dom-permissions-'))
    const entry = path.resolve('tests/fixtures/agent-loop-runtime-plugin.ts')
    const policies = exactDomPermissionPolicies('playground', [{
      id: 'agent-loop-runtime',
      entry,
      pointIds: ['sidebar.navigation.items', 'main'],
    }])
    const configPath = path.join(root, 'cordisx.config.json')
    await writeFile(
      configPath,
      `${
        JSON.stringify({
          version: 1,
          plugins: [{ id: 'agent-loop-runtime', entry, enabled: true, config: {} }],
          playground: { permissionPolicies: policies },
        })
      }\n`,
    )
    const session = await createPlaygroundSession(configPath)
    try {
      const materialized = JSON.parse(
        await readFile(path.join(session.homeDir, 'config', 'playground.home.json'), 'utf8'),
      ) as {
        permissions: readonly unknown[]
      }
      expect(materialized.permissions).toEqual(policies)
    } finally {
      await session.close()
      await rm(root, { recursive: true, force: true })
    }
  })
}
