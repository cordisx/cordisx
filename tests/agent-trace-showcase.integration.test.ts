import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { CORDISX_PAGE_SCHEMA_V3, CORDISX_ROUTE_SCHEMA_V2 } from '../packages/cli/src/contracts.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import type { CordisXConfig } from '../packages/cli/src/launcher/config.js'

interface RuntimeSnapshot {
  readonly plugins: readonly {
    id: string
    status: string
    configuration: {
      schemaKind: string
      applies: string
      revision: number
      value: unknown
      fields: readonly { path: readonly string[]; label?: string; description?: string }[]
    }
  }[]
  readonly registrations: readonly {
    owner: string
    surface: string
    valid: boolean
    authorized: boolean
    rendered: boolean
  }[]
  readonly commands: readonly { owner: string; qualifiedId: string }[]
  readonly navigation: {
    readonly routes: readonly {
      owner: string
      qualifiedId: string
      valid: boolean
      definition: {
        $schema: string
        schemaVersion: number
        id: string
        path: string
        outlet: string
        page: string
        title: { namespace: string; key: string; fallback: string }
        description: { namespace: string; key: string; fallback: string }
      }
    }[]
    readonly pages: readonly {
      owner: string
      qualifiedId: string
      metadata: {
        $schema: string
        schemaVersion: number
        id: string
        title: { namespace: string; key: string; fallback: string }
        description: { namespace: string; key: string; fallback: string }
        icon?: string
        chrome?: string
      }
    }[]
    readonly outlets: readonly {
      id: string
      available: boolean
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
    readonly availability: { readonly status: string; readonly providers: readonly { readonly providerId: string }[] }
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

async function fixture(sessionId: string, options: {
  headerAvailable?: boolean
  mode?: 'fixture' | 'live' | 'historical'
  sibling?: boolean
  overflow?: boolean
  nativePressed?: boolean
} = {}): Promise<{
  dom: JSDOM
  runtime: RuntimeHandle
  nativeConversation: HTMLElement
  thread: HTMLElement
  sessionContent: HTMLElement
}> {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const config: CordisXConfig = {
    version: 1,
    rootDir: projectRoot,
    codex: { debugPort: 9229 },
    providers: [],
    plugins: [
      {
        id: 'agent-trace-showcase',
        entry: path.join(projectRoot, 'packages/agent-trace-showcase/src/index.ts'),
        enabled: true,
        config: { mode: options.mode ?? 'fixture' },
      },
      ...(options.sibling === true ? [{
        id: 'session-header-sibling-fixture',
        entry: path.join(projectRoot, 'tests/fixtures/session-header-sibling-plugin.ts'),
        enabled: true,
        config: {},
      }] : []),
      ...(options.overflow === true ? [{
        id: 'session-header-overflow-fixture',
        entry: path.join(projectRoot, 'tests/fixtures/session-header-overflow-plugin.ts'),
        enabled: true,
        config: {},
      }] : []),
    ],
  }
  const bundle = await buildRendererBundle(config)
  const dom = new JSDOM(`
    <html lang="zh-CN" class="electron-dark"><head><style>
      .codex-toolbar-button { width: 28px; height: 28px; border-radius: 6px; }
      .native-summary-pressed { color: rgb(26, 28, 31); background-color: rgba(26, 28, 31, .05); }
    </style></head><body>
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
            <span id="native-session-tooltip-trigger" data-state="closed" style="display:contents">
              <button id="native-session-menu" class="codex-toolbar-button${options.nativePressed === true ? ' native-summary-pressed' : ''}" aria-pressed="${options.nativePressed === true ? 'true' : 'false'}" title="切换置顶摘要">Session menu</button>
            </span>
          </div>
        </header>
        <section id="native-thread" data-codex-thread-reference-drop-target>
          <div id="native-session-content" data-pip-anchor-host="codex-main-thread" data-app-action-timeline-scroll>
            <div id="native-conversation" data-response-annotation-conversation="${sessionId}">Native conversation</div>
            <div id="native-composer" data-above-composer-conversation-id="${sessionId}"></div>
          </div>
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
  const sessionContent = dom.window.document.getElementById('native-session-content')!
  const sessionHeader = dom.window.document.querySelector<HTMLElement>(
    '[data-testid="app-shell-header-context-menu-surface"]',
  )!
  Object.defineProperty(body, 'getBoundingClientRect', { value: () => rect(0, 0, 1280, 900) })
  Object.defineProperty(main, 'getBoundingClientRect', { value: () => rect(248, 46, 840, 854) })
  Object.defineProperty(thread, 'getBoundingClientRect', { value: () => rect(248, 46, 840, 854) })
  Object.defineProperty(sessionContent, 'getBoundingClientRect', { value: () => rect(248, 46, 840, 854) })
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
    sessionContent,
  }
}

describe('Agent Trace Showcase renderer integration', () => {
  it('uses host-owned toolbar tokens for direct and overflow controls without changing the composer variant', async () => {
    const { dom, runtime } = await fixture('session-toolbar-variants', { overflow: true })
    const seat = dom.window.document.querySelector<HTMLElement>('[data-cordisx-surface-host="session.header.actions"]')!
    const direct = [...seat.querySelectorAll<HTMLButtonElement>(':scope > button')]
    const overflow = seat.querySelector<HTMLDetailsElement>(':scope > details.cordisx-surface-overflow')!
    const summary = overflow.querySelector<HTMLElement>('summary')!
    const native = dom.window.document.getElementById('native-session-menu')!
    const styles = dom.window.document.getElementById('cordisx-structured-styles')?.textContent ?? ''

    expect(direct).toHaveLength(3)
    expect(direct.every(button => button.dataset.cordisxIconControlVariant === 'toolbar')).toBe(true)
    expect(dom.window.getComputedStyle(seat).getPropertyValue('--cordisx-toolbar-action-target-size')).toBe('28px')
    expect(dom.window.getComputedStyle(seat).getPropertyValue('--cordisx-toolbar-action-corner-radius')).toBe('6px')
    expect(dom.window.getComputedStyle(seat).getPropertyValue('--cordisx-toolbar-action-disabled-opacity')).toBe('.4')
    expect(dom.window.getComputedStyle(native).borderRadius).toBe('6px')
    expect(summary.getAttribute('aria-label')).toBe('More actions')
    expect(styles).toContain('--cordisx-toolbar-action-hover-background')
    expect(styles).toContain('--cordisx-toolbar-action-pressed-background')
    expect(styles).toContain('--cordisx-toolbar-action-focus-ring')
    expect(styles).toContain('--cordisx-toolbar-action-disabled-opacity')
    expect(styles).toContain('.cordisx-session-header-actions > .cordisx-surface-overflow > summary')
    expect(styles).toContain('.cordisx-session-header-actions > .cordisx-surface-overflow[open] > summary')
    expect(styles).not.toContain('codex-toolbar-button')

    overflow.open = true
    expect(overflow.open).toBe(true)
    expect(direct.every(button => button.getAttribute('aria-pressed') !== 'true')).toBe(true)
    direct[1]!.disabled = true
    expect(direct[1]!.disabled).toBe(true)

    await runtime.dispose()
  })

  it('renders the exported restart schema through the actual Manager form', async () => {
    const { dom, runtime } = await fixture('session-config-form', { mode: 'historical' })
    const descriptor = runtime.snapshot().plugins.find(plugin => plugin.id === 'agent-trace-showcase')?.configuration
    expect(descriptor).toMatchObject({
      schemaKind: 'schemastery', applies: 'plugin-restart', revision: 0,
      value: { mode: 'historical' },
    })
    expect(descriptor?.fields.map(field => field.path.join('.'))).toEqual([
      'mode', 'historyPageSize', 'timelineWindowSize',
    ])
    expect(descriptor?.fields.map(field => field.label)).toEqual([
      '数据模式', '历史分页大小', '时间线窗口大小',
    ])

    dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!.click()
    await settle(2)
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-id="agent-trace-showcase"]')!.click()
    await settle(2)
    dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="config"]')!.click()
    await settle(2)

    const form = dom.window.document.querySelector<HTMLFormElement>(
      '[data-plugin-config-form="agent-trace-showcase"]',
    )!
    expect(form.closest('[role="tabpanel"]')?.getAttribute('aria-label')).toBe('配置管理')
    expect([...form.querySelectorAll<HTMLElement>('[data-config-path]')].map(field => field.dataset.configPath)).toEqual([
      'mode', 'historyPageSize', 'timelineWindowSize',
    ])
    const mode = form.querySelector<HTMLElement & { selectedValue: string; options: readonly { label: string }[] }>('[data-config-path="mode"] t-select')!
    expect(mode.selectedValue).toBe('historical')
    expect(mode.options.map(option => option.label)).toEqual(['live', 'historical', 'fixture'])
    const pageSize = form.querySelector<HTMLElement & { value: number; min: number; max: number; step: number }>('[data-config-path="historyPageSize"] t-input-number')!
    expect({ value: pageSize.value, min: pageSize.min, max: pageSize.max, step: pageSize.step }).toEqual({
      value: 100, min: 25, max: 500, step: 25,
    })
    const windowSize = form.querySelector<HTMLElement & { value: number; min: number; max: number; step: number }>('[data-config-path="timelineWindowSize"] t-input-number')!
    expect({ value: windowSize.value, min: windowSize.min, max: windowSize.max, step: windowSize.step }).toEqual({
      value: 500, min: 50, max: 500, step: 50,
    })
    expect(form.textContent).toContain('选择实时公开账本、与实时观察合并的 Host 历史导入')
    expect(form.textContent).not.toMatch(/permissionPolicy|sessionId|providerId|profileId|CODEX_HOME|\.jsonl/)
    await runtime.dispose()
  })

  it('isolates each structured header action from a pressed native template and its siblings', async () => {
    const sessionId = 'session-state-isolation'
    const { dom, runtime } = await fixture(sessionId, { sibling: true, nativePressed: true })
    const native = dom.window.document.getElementById('native-session-menu') as HTMLButtonElement
    const seat = dom.window.document.querySelector<HTMLElement>('[data-cordisx-surface-host="session.header.actions"]')!
    seat.style.setProperty('--cordisx-toolbar-action-pressed-background', 'rgba(26, 28, 31, .05)')
    seat.style.setProperty('--cordisx-toolbar-action-pressed-hover-background', 'rgba(26, 28, 31, .1)')
    let buttons = [...seat.querySelectorAll<HTMLButtonElement>(':scope > button')]

    expect(buttons).toHaveLength(2)
    expect(native.getAttribute('aria-pressed')).toBe('true')
    expect(dom.window.getComputedStyle(native).backgroundColor).toBe('rgba(26, 28, 31, 0.05)')
    expect(buttons.every(button => !button.classList.contains('native-summary-pressed'))).toBe(true)
    expect(buttons.map(button => dom.window.getComputedStyle(button).backgroundColor)).toEqual([
      'var(--cordisx-toolbar-action-idle-background)',
      'var(--cordisx-toolbar-action-idle-background)',
    ])
    expect(buttons.map(button => button.dataset.cordisxContributionId)).toEqual([
      'agent-trace-showcase:open-timeline',
      'session-header-sibling-fixture:sibling',
    ])
    expect(buttons.map(button => button.getAttribute('aria-pressed'))).toEqual(['false', 'false'])
    expect(buttons.map(button => button.dataset.cordisxRouteState ?? null)).toEqual(['inactive', 'inactive'])

    buttons[0]!.click()
    await settle(4)
    buttons = [...seat.querySelectorAll<HTMLButtonElement>(':scope > button')]
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true')
    expect(buttons[0]!.dataset.cordisxRouteState).toBe('presented')
    expect(buttons[1]!.getAttribute('aria-pressed')).toBe('false')
    expect(buttons[1]!.dataset.cordisxRouteState).toBe('inactive')
    expect(native.getAttribute('aria-pressed')).toBe('true')
    expect(buttons.map(button => dom.window.getComputedStyle(button).backgroundColor)).toEqual([
      'var(--cordisx-toolbar-action-pressed-background)',
      'var(--cordisx-toolbar-action-idle-background)',
    ])
    expect(seat.style.getPropertyValue('--cordisx-toolbar-action-pressed-background')).toBe('rgba(26, 28, 31, .05)')

    buttons[1]!.click()
    await settle(4)
    buttons = [...seat.querySelectorAll<HTMLButtonElement>(':scope > button')]
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('false')
    expect(buttons[0]!.dataset.cordisxRouteState).toBe('inactive')
    expect(buttons[1]!.getAttribute('aria-pressed')).toBe('true')
    expect(buttons[1]!.dataset.cordisxRouteState).toBe('presented')
    expect(buttons.map(button => dom.window.getComputedStyle(button).backgroundColor)).toEqual([
      'var(--cordisx-toolbar-action-idle-background)',
      'var(--cordisx-toolbar-action-pressed-background)',
    ])

    buttons[1]!.focus()
    expect(dom.window.document.activeElement).toBe(buttons[1])
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('false')
    expect(buttons[1]!.getAttribute('aria-pressed')).toBe('true')

    buttons[1]!.dataset.state = 'open'
    buttons[1]!.disabled = true
    expect(buttons[0]!.dataset.state).toBeUndefined()
    expect(buttons[0]!.disabled).toBe(false)
    expect(dom.window.getComputedStyle(buttons[0]!).opacity).toBe('1')
    expect(buttons[1]!.disabled).toBe(true)
    delete buttons[1]!.dataset.state
    buttons[1]!.disabled = false

    buttons[0]!.click()
    await settle(4)
    buttons = [...seat.querySelectorAll<HTMLButtonElement>(':scope > button')]
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true')
    expect(buttons[1]!.getAttribute('aria-pressed')).toBe('false')

    const nativeParent = native.closest<HTMLElement>('#native-session-actions')!
    const replacementParent = nativeParent.cloneNode(true) as HTMLElement
    replacementParent.querySelector('[data-cordisx-surface-host]')?.remove()
    nativeParent.replaceWith(replacementParent)
    await settle(4)
    const replacementNative = replacementParent.querySelector<HTMLButtonElement>('#native-session-menu')!
    expect(replacementNative).not.toBe(native)
    expect(native.isConnected).toBe(false)
    expect(replacementNative.getAttribute('aria-pressed')).toBe('true')
    expect(seat.isConnected).toBe(true)
    expect(seat.parentElement).toBe(replacementParent)
    expect(seat.nextElementSibling?.id).toBe('native-session-tooltip-trigger')
    expect([...seat.querySelectorAll(':scope > button')]).toEqual(buttons)
    expect(buttons.every(button => !button.classList.contains('native-summary-pressed'))).toBe(true)

    await runtime.setPluginBlocked('session-header-sibling-fixture', true)
    await settle(4)
    expect(seat.querySelectorAll(':scope > button')).toHaveLength(1)
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true')
    expect(replacementNative.isConnected).toBe(true)
    await runtime.setPluginBlocked('session-header-sibling-fixture', false)
    await settle(4)
    expect(seat.querySelectorAll(':scope > button')).toHaveLength(2)
    expect(seat.querySelector<HTMLButtonElement>('[data-cordisx-contribution-id="agent-trace-showcase:open-timeline"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(seat.querySelector<HTMLButtonElement>('[data-cordisx-contribution-id="session-header-sibling-fixture:sibling"]')?.getAttribute('aria-pressed')).toBe('false')

    const styles = dom.window.document.getElementById('cordisx-structured-styles')?.textContent ?? ''
    expect(styles).toContain('--cordisx-toolbar-outer-group-gap: 6px')
    expect(styles).toContain('--cordisx-toolbar-action-gap: 6px')
    expect(styles).toContain('--cordisx-toolbar-action-pressed-background: color-mix(in oklab,var(--color-text,currentColor) 5%,transparent)')
    expect(styles).toContain('--cordisx-toolbar-action-pressed-hover-background: color-mix(in oklab,var(--color-text,currentColor) 10%,transparent)')
    expect(styles).toContain('[aria-pressed="true"][data-cordisx-route-state="presented"]')
    expect(styles).not.toContain('[data-cordisx-route-state="presented"] ~')
    expect(styles).not.toContain('--color-background-elevated-secondary,rgba(127,127,127,.08)')
    expect(styles).toContain('.cordisx-session-header-actions')
    expect(styles).toContain('margin-inline-end: var(--cordisx-toolbar-outer-group-gap)')
    expect(runtime.snapshot().navigation.outlets.find(item => item.id === 'session.content')).toMatchObject({
      activeRoute: 'agent-trace-showcase:session.timeline',
      presentation: 'presented',
    })

    await runtime.dispose()
    expect(seat.isConnected).toBe(false)
    expect(replacementNative.isConnected).toBe(true)
  })

  it('mounts a session-scoped fixture page without owning native shell DOM', async () => {
    const sessionId = 'session-a'
    const { dom, runtime, nativeConversation, thread, sessionContent } = await fixture(sessionId)
    const nativeParent = nativeConversation.parentElement
    const nativeUrl = dom.window.location.href

    expect(runtime.snapshot().plugins).toEqual([
      expect.objectContaining({ id: 'agent-trace-showcase', status: 'active' }),
    ])
    expect(runtime.snapshot().commands).toEqual([])
    expect(runtime.snapshot().navigation.routes).toEqual([
      expect.objectContaining({
        qualifiedId: 'agent-trace-showcase:session.timeline',
        valid: true,
        definition: {
          $schema: CORDISX_ROUTE_SCHEMA_V2,
          schemaVersion: 2,
          id: 'session.timeline',
          path: '/sessions/:sessionId/agent-trace',
          outlet: 'session.content',
          page: 'session.timeline',
          title: {
            namespace: 'agent-trace-showcase', key: 'route.timeline.title', fallback: 'Open Agent Trace',
          },
          description: {
            namespace: 'agent-trace-showcase', key: 'route.timeline.description',
            fallback: 'Use the conversation header action to open the Agent Trace Timeline for the active session.',
          },
        },
      }),
    ])
    expect(runtime.snapshot().navigation.pages).toEqual([
      expect.objectContaining({
        qualifiedId: 'agent-trace-showcase:session.timeline',
        metadata: {
          $schema: CORDISX_PAGE_SCHEMA_V3,
          schemaVersion: 3,
          id: 'session.timeline',
          title: {
            namespace: 'agent-trace-showcase', key: 'page.timeline.title', fallback: 'Agent Trace Timeline',
          },
          description: {
            namespace: 'agent-trace-showcase', key: 'page.timeline.description',
            fallback: 'Inspect input, model, tool, delivery, and prompt-contribution events for the active Agent session.',
          },
          icon: 'host:history',
          chrome: 'body-only',
        },
      }),
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
    expect(entrySeat.nextElementSibling?.id).toBe('native-session-tooltip-trigger')
    expect(dom.window.document.getElementById('native-session-tooltip-trigger')?.parentElement?.id).toBe('native-session-actions')
    expect(dom.window.document.getElementById('native-session-tooltip-trigger')?.querySelector('[data-cordisx-surface-host]')).toBeNull()
    expect(dom.window.document.getElementById('native-session-menu')?.parentElement?.id).toBe('native-session-tooltip-trigger')
    expect(entrySeat.dataset.cordisxNoDrag).toBe('true')
    expect(entryButton.className).not.toContain('codex-toolbar-button')
    expect(entryButton.className).toContain('cordisx-toolbar-action')
    expect(entryButton.dataset.cordisxIconControlVariant).toBe('toolbar')
    expect(entryButton.classList.contains('cordisx-icon-only-control')).toBe(true)
    expect(dom.window.getComputedStyle(entryButton).getPropertyValue('--cordisx-icon-only-glyph-size')).toBe('16px')
    expect(entryButton.textContent).toBe('')
    expect(entryButton.getAttribute('aria-label')).toBe('打开 Agent Trace 时间线')
    expect(entryButton.dataset.cordisxTooltip).toBe('打开 Agent Trace 时间线')
    expect(entryButton.dataset.cordisxNoDrag).toBe('true')
    expect(entryButton.draggable).toBe(false)
    expect(entryButton.getAttribute('draggable')).toBe('false')
    expect(entryButton.getAttribute('aria-pressed')).toBe('false')
    expect(dom.window.document.getElementById('cordisx-structured-styles')?.textContent)
      .toContain('[data-cordisx-no-drag="true"], [data-cordisx-no-drag="true"] *')
    const entryIcon = entryButton.querySelector<HTMLElement>('[data-host-icon="host:history"]')!
    const entryGlyph = entryIcon.querySelector<SVGElement>('svg')!
    expect(entryIcon.matches('[data-cordisx-no-drag="true"] *')).toBe(true)
    expect(entryGlyph.matches('[data-cordisx-no-drag="true"] *')).toBe(true)
    expect(dom.window.document.getElementById('native-header-action')?.textContent).toBe('Native action')

    entryButton.focus()
    await new Promise(resolve => setTimeout(resolve, 675))
    const tooltip = dom.window.document.querySelector<HTMLElement>('.cordisx-host-tooltip')!
    expect(tooltip.parentElement).toBe(dom.window.document.body)
    expect(tooltip.getAttribute('role')).toBe('tooltip')
    expect(tooltip.textContent).toBe('打开 Agent Trace 时间线')
    expect(entryButton.getAttribute('aria-describedby')).toBe(tooltip.id)
    expect(dom.window.document.getElementById('native-session-tooltip-trigger')?.contains(tooltip)).toBe(false)
    entryButton.blur()
    expect(dom.window.document.querySelector('.cordisx-host-tooltip')).toBeNull()

    let nativeActivations = 0
    dom.window.document.getElementById('native-session-menu')?.addEventListener('click', () => { nativeActivations += 1 })
    entryButton.click()
    await settle(4)
    expect(nativeActivations).toBe(0)
    const invocationDiagnostics = runtime.snapshot().extensionPoints.accessDiagnostics.slice(-3).map(item => ({
      operation: item.request.operation,
      generation: item.request.generation,
      authorized: item.authorized,
    }))
    expect(invocationDiagnostics).toEqual([
      { operation: 'surface.route.navigate', generation: expect.any(String), authorized: true },
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
    expect(entrySeat.querySelector('button')).toBe(entryButton)
    expect(entryButton.getAttribute('aria-pressed')).toBe('true')
    const page = dom.window.document.querySelector<HTMLElement>('[data-cordisx-page="agent-trace-showcase:session.timeline"]')!
    expect(page.dataset.cordisxPageChromePolicy).toBe('body-only')
    expect(page.getAttribute('aria-label')).toBe('Agent Trace 时间线')
    expect(page.querySelector('[data-cordisx-page-chrome]')).toBeNull()
    expect(page.querySelector('[data-cordisx-page-title]')).toBeNull()
    expect(page.querySelector('button[aria-label="Close"]')).toBeNull()
    expect(page.firstElementChild?.getAttribute('data-cordisx-page-body')).toBe('true')
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

    entryButton.focus()
    entryButton.click()
    await settle(4)
    expect(dom.window.document.querySelector('[data-agent-trace-showcase]')).toBeNull()
    expect(entryButton.getAttribute('aria-pressed')).toBe('false')
    expect(dom.window.document.activeElement).toBe(entryButton)
    entryButton.click()
    await settle(4)
    expect(entryButton.getAttribute('aria-pressed')).toBe('true')
    const reopenedPage = dom.window.document.querySelector<HTMLElement>('[data-cordisx-page="agent-trace-showcase:session.timeline"]')!
    reopenedPage.querySelector<HTMLButtonElement>('.cxt-clear')!.focus()
    reopenedPage.querySelector<HTMLButtonElement>('.cxt-clear')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    }))
    await settle(4)
    expect(dom.window.document.querySelector('[data-agent-trace-showcase]')).toBeNull()
    expect(entryButton.getAttribute('aria-pressed')).toBe('false')
    expect(dom.window.document.activeElement).toBe(entryButton)
    entryButton.click()
    await settle(4)
    const remountedPage = dom.window.document.querySelector<HTMLElement>('[data-cordisx-page="agent-trace-showcase:session.timeline"]')!

    const outletContainer = remountedPage.parentElement!
    const replacementSessionContent = sessionContent.cloneNode(true) as HTMLElement
    Object.defineProperty(replacementSessionContent, 'getBoundingClientRect', { value: () => rect(248, 46, 840, 854) })
    sessionContent.replaceWith(replacementSessionContent)
    await settle(4)
    expect(runtime.snapshot().navigation.outlets.find(item => item.id === 'session.content')).toMatchObject({
      activeRoute: 'agent-trace-showcase:session.timeline',
      contextKey: `session:${sessionId}`,
      mounted: true,
      presentation: 'presented',
    })
    expect(remountedPage.parentElement).toBe(outletContainer)
    expect(remountedPage.isConnected).toBe(true)
    expect(dom.window.document.getElementById('native-session-content')).toBe(replacementSessionContent)

    remountedPage.querySelector<HTMLButtonElement>('[data-demo-kind="system-prompt-context"]')!.click()
    await settle(2)
    expect(remountedPage.querySelector('.cxt-integrity')?.textContent).toContain('loaded 18/26')
    const generated = [...remountedPage.querySelectorAll<HTMLElement>('.cxt-row')].at(-1)!
    generated.click()
    expect(remountedPage.querySelector('.cxt-detail-scroll')?.textContent).toContain('agent-trace-showcase@0.1.0')
    expect(remountedPage.querySelector('.cxt-detail-scroll')?.textContent).toContain('fixture-generation-7')

    await expect(runtime.navigate('agent-trace-showcase', {
      id: 'session.timeline', params: { sessionId: 'session-b' },
    })).rejects.toThrow(/does not match native session session-a/)
    expect(dom.window.location.href).toBe(nativeUrl)

    entryButton.click()
    await settle(4)
    expect(dom.window.document.querySelector('[data-agent-trace-showcase]')).toBeNull()
    expect(entryButton.getAttribute('aria-pressed')).toBe('false')
    expect(dom.window.document.getElementById('native-conversation')?.isConnected).toBe(true)
    entryButton.click()
    await settle(4)
    expect(entryButton.getAttribute('aria-pressed')).toBe('true')
    expect(dom.window.document.querySelector('[data-agent-trace-showcase]')).not.toBeNull()
    await runtime.dispose()
    expect(entryButton.isConnected).toBe(false)
    expect(dom.window.document.querySelector('[data-agent-trace-showcase]')).toBeNull()
    expect(dom.window.document.querySelector('[data-cordisx-page]')).toBeNull()
    entryButton.click()
    await settle(2)
    expect(dom.window.document.querySelector('[data-agent-trace-showcase]')).toBeNull()
  })

  it('cleans the route, page, subscriptions, and fixture generation on block and session change', async () => {
    const { dom, runtime } = await fixture('session-a')
    const firstGenerationEntry = dom.window.document.querySelector<HTMLButtonElement>(
      '[data-cordisx-surface-host="session.header.actions"] button',
    )!
    await runtime.navigate('agent-trace-showcase', { id: 'session.timeline', params: { sessionId: 'session-a' } })
    await settle(2)
    expect(dom.window.document.querySelector('[data-agent-trace-showcase]')).not.toBeNull()
    expect(firstGenerationEntry.getAttribute('aria-pressed')).toBe('true')

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
    expect(runtime.snapshot().commands).toEqual([])
    expect(runtime.snapshot().registrations).toEqual([
      expect.objectContaining({ surface: 'session.header.actions', rendered: true }),
    ])
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="session.header.actions"]')).not.toBeNull()
    const restoredEntry = dom.window.document.querySelector<HTMLButtonElement>(
      '[data-cordisx-surface-host="session.header.actions"] button',
    )!
    expect(restoredEntry).not.toBe(firstGenerationEntry)
    expect(restoredEntry.getAttribute('aria-pressed')).toBe('false')
    expect(runtime.snapshot().platform).toMatchObject({
      mode: 'unavailable', secondConnectionCreated: false, rawBridgeExposed: false,
    })
    expect(runtime.snapshot().permissions.find(item => item.capability === 'agent.events.read')).toMatchObject({
      availability: { status: 'supported', providers: [{ providerId: 'host-agent-events' }] },
    })
    expect(runtime.snapshot().permissions.find(item => item.capability === 'agent.history.read')).toMatchObject({
      availability: { status: 'unavailable', providers: [{ providerId: 'host-agent-history' }] },
    })

    const selected = dom.window.document.getElementById('selected-thread')!
    selected.removeAttribute('data-app-action-sidebar-thread-selected')
    await settle(4)
    expect(runtime.snapshot().navigation.outlets.find(item => item.id === 'session.content')).toMatchObject({
      available: false, mounted: false,
    })
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="session.header.actions"]')).toBeNull()
    restoredEntry.click()
    await settle(2)
    expect(dom.window.document.querySelector('[data-agent-trace-showcase]')).toBeNull()
    selected.setAttribute('data-app-action-sidebar-thread-selected', 'true')
    await settle(4)
    const reselectedEntry = dom.window.document.querySelector<HTMLButtonElement>(
      '[data-cordisx-surface-host="session.header.actions"] button',
    )!
    expect(reselectedEntry).not.toBe(restoredEntry)

    await runtime.navigate('agent-trace-showcase', { id: 'session.timeline', params: { sessionId: 'session-a' } })
    const conversation = dom.window.document.getElementById('native-conversation')!
    const composer = dom.window.document.getElementById('native-composer')!
    selected.setAttribute('data-app-action-sidebar-thread-id', 'local:session-b')
    conversation.setAttribute('data-response-annotation-conversation', 'session-b')
    composer.setAttribute('data-above-composer-conversation-id', 'session-b')
    await settle(4)
    expect(runtime.snapshot().navigation.outlets.find(item => item.id === 'session.content')).toMatchObject({ mounted: false })
    expect(dom.window.document.querySelector('[data-agent-trace-showcase]')).toBeNull()
    expect(reselectedEntry.getAttribute('aria-pressed')).toBe('false')
    await expect(runtime.navigate('agent-trace-showcase', {
      id: 'session.timeline', params: { sessionId: 'session-a' },
    })).rejects.toThrow(/does not match native session session-b/)
    await runtime.navigate('agent-trace-showcase', {
      id: 'session.timeline', params: { sessionId: 'session-b' },
    })
    expect(dom.window.document.querySelector('[data-agent-trace-showcase]')).not.toBeNull()
    expect(dom.window.document.querySelector('.cxt-integrity')?.textContent).toContain('fixture')

    await runtime.dispose()
    expect(dom.window.document.querySelector('[data-cordisx-page]')).toBeNull()
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="session.header.actions"]')).toBeNull()
    reselectedEntry.click()
    await settle(2)
    expect(dom.window.document.querySelector('[data-agent-trace-showcase]')).toBeNull()
  })

  it('reports an inactive supported seat as current context without a fallback control', async () => {
    const { dom, runtime } = await fixture('session-a', { headerAvailable: false })
    expect(runtime.snapshot().registrations).toEqual([
      expect.objectContaining({
        surface: 'session.header.actions', pending: true, rendered: false,
        authorized: true, currentContext: 'inactive', availabilityCode: 'anchor.unresolved',
      }),
    ])
    expect(dom.window.document.querySelector('[data-cordisx-surface-host="session.header.actions"]')).toBeNull()
    expect(dom.window.document.querySelector('[data-agent-trace-showcase]')).toBeNull()
    dom.window.document.getElementById('selected-thread')?.remove()
    await settle(3)
    expect(runtime.snapshot().registrations).toEqual([
      expect.objectContaining({
        surface: 'session.header.actions', authorized: true, pending: true,
        currentContext: 'not-mounted', availabilityCode: 'session.not-mounted',
      }),
    ])
    await runtime.dispose()
  })

  it('applies ask, deny, and allow to exact-session history reads without a fallback importer', async () => {
    const { dom, runtime } = await fixture('session-history-permission', { mode: 'historical' })
    expect(runtime.snapshot().permissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: 'agent.history.read', policy: 'ask' }),
    ]))
    await runtime.setPermissionPolicy('agent-trace-showcase', 'agent.events.read', 'allow')
    await runtime.setPermissionPolicy('agent-trace-showcase', 'agent.history.read', 'deny')
    const entry = dom.window.document.querySelector<HTMLButtonElement>(
      '[data-cordisx-surface-host="session.header.actions"] button',
    )!
    entry.click()
    await settle(20)
    let page = dom.window.document.querySelector<HTMLElement>('[data-agent-trace-showcase="true"]')!
    expect(page.querySelector<HTMLElement>('.cxt-integrity')?.title).toContain('permission-denied')
    expect(runtime.snapshot().permissions.find(item => item.capability === 'agent.history.read')).toMatchObject({
      policy: 'deny', lastRequested: { agentSessionId: 'session-history-permission' },
    })

    entry.click()
    await settle(4)
    await runtime.setPermissionPolicy('agent-trace-showcase', 'agent.history.read', 'allow')
    entry.click()
    await settle(20)
    page = dom.window.document.querySelector<HTMLElement>('[data-agent-trace-showcase="true"]')!
    expect(page.querySelector<HTMLElement>('.cxt-integrity')?.title).toContain('adapter-unavailable: Agent history is unavailable')
    expect(page.querySelector('.cxt-integrity')?.textContent).toContain('live')
    expect(dom.window.document.querySelector('[data-cordisx-history-path]')).toBeNull()
    await runtime.dispose()
  })

  it('binds public v2 ledger and controls to each host-issued session without crossing A/B data', async () => {
    const { dom, runtime } = await fixture('session-a', { mode: 'live' })
    expect(runtime.snapshot().permissions).toEqual(expect.arrayContaining([
      ...['agent.events.read', 'agent.history.read', 'agent.messages.append', 'agent.prompt.section', 'agent.prompt.context'].map(capability => expect.objectContaining({
        identity: expect.objectContaining({ id: 'agent-trace-showcase' }), capability, policy: 'ask',
      })),
    ]))
    for (const capability of ['agent.events.read', 'agent.history.read', 'agent.messages.append', 'agent.prompt.section', 'agent.prompt.context']) {
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
    const sessionBEntry = dom.window.document.querySelector<HTMLButtonElement>(
      '[data-cordisx-surface-host="session.header.actions"] button',
    )!
    expect(sessionBEntry.getAttribute('aria-pressed')).toBe('false')

    sessionBEntry.click()
    await settle(20)
    page = dom.window.document.querySelector<HTMLElement>('[data-agent-trace-showcase="true"]')!
    expect(page).not.toBeNull()
    expect(runtime.snapshot().navigation.outlets.find(item => item.id === 'session.content')).toMatchObject({
      contextKey: 'session:session-b', mounted: true,
    })
    expect(sessionBEntry.getAttribute('aria-pressed')).toBe('true')
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
