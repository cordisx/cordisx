import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import type { CordisXConfig } from '../packages/cli/src/launcher/config.js'

interface RuntimeSnapshot {
  readonly plugins: readonly { id: string; status: string }[]
  readonly registrations: readonly {
    owner: string
    surface: string
    valid: boolean
    authorized: boolean
    rendered: boolean
  }[]
  readonly commands: readonly { owner: string; qualifiedId: string }[]
  readonly navigation: {
    readonly routes: readonly { owner: string; qualifiedId: string; valid: boolean }[]
    readonly pages: readonly { owner: string; qualifiedId: string }[]
    readonly outlets: readonly {
      id: string
      contextKey?: string
      activeRoute?: string
      mounted: boolean
      presentation: 'inactive' | 'presented' | 'suspended'
    }[]
  }
  readonly platform: {
    readonly mode: string
    readonly secondConnectionCreated: boolean
    readonly rawBridgeExposed: boolean
  }
  readonly permissions: readonly {
    readonly identity: { readonly id: string }
    readonly capability: string
    readonly policy: 'allow' | 'ask' | 'deny'
    readonly lastRequested?: { readonly agentSessionId?: string }
  }[]
  readonly extensionPoints: {
    readonly accessDiagnostics: readonly {
      readonly request: { readonly operation: string; readonly generation: string }
      readonly authorized: boolean
    }[]
  }
}

interface RuntimeHandle {
  snapshot(): RuntimeSnapshot
  execute(owner: string, reference: { id: string; arguments?: unknown }): Promise<unknown>
  navigate(owner: string, reference: { id: string; params?: Record<string, string> }): Promise<void>
  setPermissionPolicy(id: string, capability: string, policy: 'allow' | 'ask' | 'deny'): Promise<void>
  setPluginBlocked(id: string, blocked: boolean): Promise<void>
  dispose(): Promise<void>
}

async function settle(rounds = 1): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left, y: top, left, top, right: left + width, bottom: top + height,
    width, height, toJSON: () => ({}),
  } as DOMRect
}

async function fixture(sessionId: string, options: { headerAvailable?: boolean; mode?: 'fixture' | 'live' } = {}): Promise<{
  dom: JSDOM
  runtime: RuntimeHandle
  nativeConversation: HTMLElement
  thread: HTMLElement
}> {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const config: CordisXConfig = {
    version: 1,
    rootDir: projectRoot,
    codex: { debugPort: 9229 },
    providers: [],
    plugins: [{
      id: 'agent-trace-showcase',
      entry: path.join(projectRoot, 'packages/agent-trace-showcase/src/index.ts'),
      enabled: true,
      config: options.mode === 'live'
        ? { mode: 'live' }
        : { mode: 'fixture', sessionId, permissionPolicy: 'allow' },
    }],
  }
  const bundle = await buildRendererBundle(config)
  const dom = new JSDOM(`
    <html lang="en" class="electron-dark"><head></head><body>
      <div class="sidebar-header"><button id="workspace-switcher" aria-haspopup="menu">Codex</button></div>
      <header data-app-shell-application-menu-bar>
        <div data-test-id="header-shell-slot"><button id="native-header-action">Native action</button></div>
      </header>
      <aside>
        <div data-app-action-sidebar-scroll>
          <button
            id="selected-thread"
            data-app-action-sidebar-thread-selected="true"
            data-app-action-sidebar-thread-host-id="local"
            data-app-action-sidebar-thread-id="local:${sessionId}"
          ></button>
        </div>
      </aside>
      <main data-app-shell-main-content-layout="thread-edge-scroll">
        <header data-testid="app-shell-header-context-menu-surface" style="display:flex">
          <div id="native-session-title">Current session</div>
          <div id="native-session-actions" style="display:flex">
            <button id="native-session-menu" class="codex-toolbar-button">Session menu</button>
          </div>
        </header>
        <section id="native-thread" data-codex-thread-reference-drop-target>
          <div id="native-conversation" data-response-annotation-conversation="${sessionId}">Native conversation</div>
          <div id="native-composer" data-above-composer-conversation-id="${sessionId}"></div>
        </section>
      </main>
      <aside id="native-right-panel" data-pip-home-surface="thread-summary-panel"></aside>
    </body></html>
  `, { runScripts: 'dangerously', url: 'https://codex.local/native' })
  Object.defineProperty(dom.window, 'structuredClone', { configurable: true, value: structuredClone })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', {
    configurable: true,
    value: () => ({ length: 1 }),
  })
  const body = dom.window.document.body
  const main = dom.window.document.querySelector<HTMLElement>('main')!
  const thread = dom.window.document.getElementById('native-thread')!
  const sessionHeader = dom.window.document.querySelector<HTMLElement>(
    '[data-testid="app-shell-header-context-menu-surface"]',
  )!
  Object.defineProperty(body, 'getBoundingClientRect', { value: () => rect(0, 0, 1280, 900) })
  Object.defineProperty(main, 'getBoundingClientRect', { value: () => rect(248, 46, 840, 854) })
  Object.defineProperty(thread, 'getBoundingClientRect', { value: () => rect(248, 46, 840, 854) })
  if (options.headerAvailable !== false) {
    Object.defineProperty(sessionHeader, 'getBoundingClientRect', { value: () => rect(248, 46, 840, 46) })
  }

  dom.window.eval(bundle)
  for (let attempt = 0; attempt < 50 && dom.window.document.documentElement.dataset.cordisxReady !== 'true'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const runtime = (dom.window as unknown as { __cordisxRuntime?: RuntimeHandle }).__cordisxRuntime
  if (runtime === undefined) throw new Error('CordisX runtime did not boot')
  return {
    dom,
    runtime,
    nativeConversation: dom.window.document.getElementById('native-conversation')!,
    thread,
  }
}

describe('Agent Trace Showcase renderer integration', () => {
  it('mounts a session-scoped fixture page without owning native shell DOM', async () => {
    const sessionId = 'session-a'
    const { dom, runtime, nativeConversation, thread } = await fixture(sessionId)
    const nativeParent = nativeConversation.parentElement
    const nativeUrl = dom.window.location.href

    expect(runtime.snapshot().plugins).toEqual([
      expect.objectContaining({ id: 'agent-trace-showcase', status: 'active' }),
    ])
    expect(runtime.snapshot().commands).toEqual([
      expect.objectContaining({ qualifiedId: 'agent-trace-showcase:open-timeline' }),
    ])
    expect(runtime.snapshot().navigation.routes).toEqual([
      expect.objectContaining({ qualifiedId: 'agent-trace-showcase:session.timeline', valid: true }),
    ])
    expect(runtime.snapshot().navigation.pages).toEqual([
      expect.objectContaining({ qualifiedId: 'agent-trace-showcase:session.timeline' }),
    ])
    expect(runtime.snapshot().registrations.filter(item => item.owner === 'agent-trace-showcase')).toEqual([
      expect.objectContaining({
        surface: 'session.header.actions', valid: true, authorized: true, rendered: true,
      }),
    ])
    const entrySeat = dom.window.document.querySelector<HTMLElement>(
      '[data-cordisx-surface-host="session.header.actions"]',
    )!
    const entryButton = entrySeat.querySelector<HTMLButtonElement>('button')!
    expect(entrySeat.parentElement?.id).toBe('native-session-actions')
    expect(entrySeat.nextElementSibling?.id).toBe('native-session-menu')
    expect(dom.window.document.getElementById('native-session-menu')?.parentElement?.id).toBe('native-session-actions')
    expect(entrySeat.dataset.cordisxNoDrag).toBe('true')
    expect(entryButton.className).toContain('codex-toolbar-button')
    expect(entryButton.textContent).toBe('')
    expect(entryButton.getAttribute('aria-label')).toBe('Open Agent Trace Timeline')
    expect(entryButton.dataset.cordisxTooltip).toBe('Open Agent Trace Timeline')
    expect(dom.window.document.getElementById('cordisx-structured-styles')?.textContent)
      .toContain('[data-cordisx-no-drag="true"]')
    expect(entryButton.querySelector('[data-host-icon="host:history"] svg')).not.toBeNull()
    expect(dom.window.document.getElementById('native-header-action')?.textContent).toBe('Native action')

    await expect(runtime.execute('agent-trace-showcase', {
      id: 'open-timeline', arguments: { sessionId, hostContext: { identity: { agent: { sessionKey: sessionId } } } },
    })).rejects.toThrow(/host-issued current Agent session identity is unavailable/)
    expect(dom.window.document.querySelector('[data-agent-trace-showcase]')).toBeNull()

    entryButton.click()
    await settle(4)
    const invocationDiagnostics = runtime.snapshot().extensionPoints.accessDiagnostics.slice(-3).map(item => ({
      operation: item.request.operation,
      generation: item.request.generation,
      authorized: item.authorized,
    }))
    expect(invocationDiagnostics).toEqual([
      { operation: 'surface.command.invoke', generation: expect.any(String), authorized: true },
      { operation: 'outlet.route.navigate', generation: expect.any(String), authorized: true },
      { operation: 'outlet.page.mount', generation: expect.any(String), authorized: true },
    ])
    expect(new Set(invocationDiagnostics.map(item => item.generation)).size).toBe(1)
    const outlet = runtime.snapshot().navigation.outlets.find(item => item.id === 'session.content')
    expect(outlet).toMatchObject({
      activeRoute: 'agent-trace-showcase:session.timeline',
      contextKey: `session:${sessionId}`,
      mounted: true,
      presentation: 'presented',
    })
    const page = dom.window.document.querySelector<HTMLElement>('[data-cordisx-page="agent-trace-showcase:session.timeline"]')!
    expect(page.querySelector('[data-agent-trace-showcase="true"]')).not.toBeNull()
    expect(page.textContent).toContain('Overview')
    expect(page.textContent).toContain('fixture')
    expect(page.querySelectorAll('.cxt-row')).toHaveLength(16)
    expect(page.querySelectorAll('.cxt-lane-labels span')).toHaveLength(4)
    expect(page.parentElement?.dataset.cordisxPageOutlet).toBe('session.content')
    expect(dom.window.location.href).toBe(nativeUrl)
    expect(nativeConversation.parentElement).toBe(nativeParent)
    expect(nativeConversation.textContent).toBe('Native conversation')
    expect(page.parentElement?.parentElement).toBe(dom.window.document.body)
    expect(page.parentElement?.style.left).toBe('248px')
    expect(page.parentElement?.style.top).toBe('46px')
    expect(thread.contains(page)).toBe(false)
    expect(dom.window.document.getElementById('native-right-panel')).not.toBeNull()

    page.querySelector<HTMLButtonElement>('[data-demo-kind="system-prompt-context"]')!.click()
    await settle(2)
    expect(page.querySelector('.cxt-integrity')?.textContent).toContain('loaded 18/26')
    const generated = [...page.querySelectorAll<HTMLElement>('.cxt-row')].at(-1)!
    generated.click()
    expect(page.querySelector('.cxt-detail-scroll')?.textContent).toContain('agent-trace-showcase@0.1.0')
    expect(page.querySelector('.cxt-detail-scroll')?.textContent).toContain('fixture-generation-7')

    await expect(runtime.navigate('agent-trace-showcase', {
      id: 'session.timeline', params: { sessionId: 'session-b' },
    })).rejects.toThrow(/does not match native session session-a/)
    expect(dom.window.location.href).toBe(nativeUrl)

    page.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click()
    await settle(2)
    expect(dom.window.document.querySelector('[data-agent-trace-showcase]')).toBeNull()
    expect(nativeConversation.isConnected).toBe(true)
    await runtime.dispose()
  })

  it('cleans the route, page, subscriptions, and fixture generation on block and session change', async () => {
    const { dom, runtime } = await fixture('session-a')
    const firstGenerationEntry = dom.window.document.querySelector<HTMLButtonElement>(
      '[data-cordisx-surface-host="session.header.actions"] button',
    )!
    await runtime.navigate('agent-trace-showcase', { id: 'session.timeline', params: { sessionId: 'session-a' } })
    expect(dom.window.document.querySelector('[data-agent-trace-showcase]')).not.toBeNull()

    await runtime.setPluginBlocked('agent-trace-showcase', true)
    expect(runtime.snapshot().plugins[0]?.status).toBe('blocked')
    expect(runtime.snapshot().commands).toEqual([])
    expect(runtime.snapshot().registrations).toEqual([
      expect.objectContaining({
        surface: 'session.header.actions', visible: false, rendered: false,
        error: 'owning plugin is inactive',
      }),
    ])
    expect(runtime.snapshot().navigation.routes).toEqual([])
    expect(runtime.snapshot().navigation.pages).toEqual([])
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="session.header.actions"]')).toBeNull()
    firstGenerationEntry.click()
    await settle(2)
    expect(dom.window.document.querySelector('[data-agent-trace-showcase]')).toBeNull()
    expect(dom.window.document.querySelector('[data-agent-trace-showcase]')).toBeNull()

    await runtime.setPluginBlocked('agent-trace-showcase', false)
    expect(runtime.snapshot().plugins[0]?.status).toBe('active')
    expect(runtime.snapshot().commands).toHaveLength(1)
    expect(runtime.snapshot().registrations).toEqual([
      expect.objectContaining({ surface: 'session.header.actions', rendered: true }),
    ])
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="session.header.actions"]')).not.toBeNull()
    const restoredEntry = dom.window.document.querySelector<HTMLButtonElement>(
      '[data-cordisx-surface-host="session.header.actions"] button',
    )!
    expect(restoredEntry).not.toBe(firstGenerationEntry)
    expect(runtime.snapshot().platform).toMatchObject({
      mode: 'unavailable', secondConnectionCreated: false, rawBridgeExposed: false,
    })

    await runtime.navigate('agent-trace-showcase', { id: 'session.timeline', params: { sessionId: 'session-a' } })
    const selected = dom.window.document.getElementById('selected-thread')!
    const conversation = dom.window.document.getElementById('native-conversation')!
    const composer = dom.window.document.getElementById('native-composer')!
    selected.setAttribute('data-app-action-sidebar-thread-id', 'local:session-b')
    conversation.setAttribute('data-response-annotation-conversation', 'session-b')
    composer.setAttribute('data-above-composer-conversation-id', 'session-b')
    await settle(4)
    expect(runtime.snapshot().navigation.outlets.find(item => item.id === 'session.content')).toMatchObject({ mounted: false })
    expect(dom.window.document.querySelector('[data-agent-trace-showcase]')).toBeNull()
    await expect(runtime.navigate('agent-trace-showcase', {
      id: 'session.timeline', params: { sessionId: 'session-a' },
    })).rejects.toThrow(/does not match native session session-b/)
    await expect(runtime.navigate('agent-trace-showcase', {
      id: 'session.timeline', params: { sessionId: 'session-b' },
    })).rejects.toThrow(/provider session session-a does not match route session session-b/)
    expect(dom.window.document.querySelector('[data-agent-trace-showcase]')).toBeNull()

    await runtime.dispose()
    expect(dom.window.document.querySelector('[data-cordisx-page]')).toBeNull()
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="session.header.actions"]')).toBeNull()
    restoredEntry.click()
    await settle(2)
    expect(dom.window.document.querySelector('[data-agent-trace-showcase]')).toBeNull()
  })

  it('keeps an unavailable native seat pending and refuses direct identity spoofing', async () => {
    const { dom, runtime } = await fixture('session-a', { headerAvailable: false })
    expect(runtime.snapshot().registrations).toEqual([
      expect.objectContaining({
        surface: 'session.header.actions', pending: true, rendered: false,
        availabilityCode: 'anchor-unresolved',
      }),
    ])
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="session.header.actions"]')).toBeNull()
    await expect(runtime.execute('agent-trace-showcase', {
      id: 'open-timeline',
      arguments: { sessionId: 'session-a', hostContext: { identity: { agent: { sessionKey: 'session-a' } } } },
    })).rejects.toThrow(/host-issued current Agent session identity is unavailable/)
    expect(dom.window.document.querySelector('[data-agent-trace-showcase]')).toBeNull()
    await runtime.dispose()
  })

  it('binds public v2 ledger and controls to each host-issued session without crossing A/B data', async () => {
    const { dom, runtime } = await fixture('session-a', { mode: 'live' })
    expect(runtime.snapshot().permissions).toEqual(expect.arrayContaining([
      ...['agent.events.read', 'agent.messages.append', 'agent.prompt.section', 'agent.prompt.context'].map(capability => expect.objectContaining({
        identity: expect.objectContaining({ id: 'agent-trace-showcase' }), capability, policy: 'ask',
      })),
    ]))
    for (const capability of ['agent.events.read', 'agent.messages.append', 'agent.prompt.section', 'agent.prompt.context']) {
      await runtime.setPermissionPolicy('agent-trace-showcase', capability, 'allow')
    }

    dom.window.document.querySelector<HTMLButtonElement>(
      '[data-cordisx-surface-host="session.header.actions"] button',
    )!.click()
    await settle(20)
    let page = dom.window.document.querySelector<HTMLElement>('[data-agent-trace-showcase="true"]')!
    expect(page).not.toBeNull()
    expect(page.querySelector('.cxt-badge')?.textContent).toBe('partial')
    expect(page.querySelector('.cxt-integrity')?.textContent).toContain('cordisx.agent-events/v2')
    expect([...page.querySelectorAll<HTMLButtonElement>('[data-demo-kind]')].every(button => !button.disabled)).toBe(true)
    page.querySelector<HTMLButtonElement>('[data-demo-kind="inject"]')!.click()
    page.querySelector<HTMLButtonElement>('[data-demo-kind="system-prompt-section"]')!.click()
    await settle(20)
    expect(page.textContent).toContain('agent.inject')
    expect(page.textContent).toContain('system-prompt.section')
    expect(page.textContent).toContain('failed')
    expect(runtime.snapshot().permissions.find(item => item.capability === 'agent.messages.append')).toMatchObject({
      policy: 'allow', lastRequested: { agentSessionId: 'session-a' },
    })
    page.querySelector<HTMLButtonElement>('.cxt-clear')!.click()
    await settle(5)
    expect(page.textContent).toContain('released')

    const selected = dom.window.document.getElementById('selected-thread')!
    const conversation = dom.window.document.getElementById('native-conversation')!
    const composer = dom.window.document.getElementById('native-composer')!
    selected.setAttribute('data-app-action-sidebar-thread-id', 'local:session-b')
    conversation.setAttribute('data-response-annotation-conversation', 'session-b')
    composer.setAttribute('data-above-composer-conversation-id', 'session-b')
    await settle(5)
    expect(dom.window.document.querySelector('[data-agent-trace-showcase]')).toBeNull()

    dom.window.document.querySelector<HTMLButtonElement>(
      '[data-cordisx-surface-host="session.header.actions"] button',
    )!.click()
    await settle(20)
    page = dom.window.document.querySelector<HTMLElement>('[data-agent-trace-showcase="true"]')!
    expect(page).not.toBeNull()
    expect(runtime.snapshot().navigation.outlets.find(item => item.id === 'session.content')).toMatchObject({
      contextKey: 'session:session-b', mounted: true,
    })
    expect(runtime.snapshot().permissions.find(item => item.capability === 'agent.events.read')).toMatchObject({ policy: 'allow' })

    await runtime.setPluginBlocked('agent-trace-showcase', true)
    expect(dom.window.document.querySelector('[data-agent-trace-showcase]')).toBeNull()
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="session.header.actions"]')).toBeNull()
    await runtime.setPluginBlocked('agent-trace-showcase', false)
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="session.header.actions"] button')).not.toBeNull()
    await runtime.dispose()
    expect(dom.window.document.querySelector('[data-agent-trace-showcase]')).toBeNull()
  })
})
