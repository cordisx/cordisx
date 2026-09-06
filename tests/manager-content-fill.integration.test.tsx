import { CORDISX_PAGE_SCHEMA_V3, CORDISX_ROUTE_SCHEMA_V2 } from '../packages/cli/src/contracts.js'
import React from 'react'
import { PanZoomCanvas } from '../packages/cli/src/renderer/host-ui/PanZoomCanvas.js'
import { ManagerContentPage } from '../packages/cli/src/renderer/manager/pages/ManagerContentPage.js'
import { REACT_MANAGER_STYLES } from '../packages/cli/src/renderer/manager/styles.js'
import { NavigationRegistry, OutletRegistry, PageRegistry } from '../packages/cli/src/renderer/navigation.js'
import { installSharedReactRuntime } from '../packages/cli/src/renderer/react-runtime.js'
import { HostContextStore } from '../packages/cli/src/renderer/validation.js'
import { describe, expect, it, vi } from 'vitest'
import { TestCodexRouteHistory } from './helpers/codex-route-history.js'
import { managerModel, managerRouter, reactManagerFixture } from './helpers/react-manager.js'
import { fakeI18n, FakeOutlet } from './suites/navigation.fixtures.js'

const TEAM_FIXTURE_STYLES = `
.team-fill-fixture{display:grid;width:100%;height:100%;min-height:0;grid-template-rows:auto minmax(0,1fr);overflow:hidden}
.team-fill-groups,.team-fill-chart{height:100%;min-height:0}
.team-fill-tree{display:grid;height:100%;min-height:0;grid-template-rows:auto minmax(0,1fr)}
`

function TeamFillFixture() {
  return (
    <div className="team-fill-fixture">
      <div>Team controls</div>
      <div className="team-fill-groups">
        <div className="team-fill-chart">
          <div className="team-fill-tree">
            <div>Canvas controls</div>
            <PanZoomCanvas fill aria-label="Team architecture">
              <div style={{ width: 480, height: 228 }}>Team hierarchy</div>
            </PanZoomCanvas>
          </div>
        </div>
      </div>
    </div>
  )
}

describe('Manager content fill layout', () => {
  it('preserves the real ManagerContentPage mount chain under one 767px Host seat', async () => {
    const fixture = reactManagerFixture()
    const style = fixture.document.createElement('style')
    style.textContent = `${REACT_MANAGER_STYLES}\n${TEAM_FIXTURE_STYLES}`
    fixture.document.head.append(style)
    const shared = installSharedReactRuntime(fixture.document)
    const contexts = new HostContextStore()
    const pages = new PageRegistry()
    const outlets = new OutletRegistry()
    const i18n = fakeI18n()
    const seatFor = i18n.seatFor.bind(i18n)
    Object.assign(i18n, {
      subscribeInternal: () => () => {},
      seatFor: (...args: Parameters<typeof i18n.seatFor>) => {
        const seat = seatFor(...args)
        const snapshot = seat.getSnapshot()
        return Object.freeze({ ...seat, getSnapshot: () => snapshot })
      },
    })
    const navigation = new NavigationRegistry(
      pages,
      outlets,
      i18n,
      new TestCodexRouteHistory(),
      contexts,
    )
    const outletContainer = fixture.document.createElement('div')
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
      new FakeOutlet(outletContainer, 'manager:fill'),
      path => path.startsWith('/manager/extensions/'),
    )
    pages.register('team', {
      $schema: CORDISX_PAGE_SCHEMA_V3,
      schemaVersion: 3,
      id: 'architecture',
      title: { key: 'team.title', fallback: 'Team architecture' },
      description: { key: 'team.description', fallback: 'Team hierarchy' },
      icon: 'host:hierarchy',
      chrome: 'standard',
    }, shared.defineReactPage(TeamFillFixture))
    navigation.register('team', {
      $schema: CORDISX_ROUTE_SCHEMA_V2,
      schemaVersion: 2,
      id: 'architecture',
      path: '/manager/extensions/team',
      outlet: 'manager.content',
      page: 'architecture',
      title: { key: 'team.title', fallback: 'Team architecture' },
      description: { key: 'team.description', fallback: 'Team hierarchy' },
    })
    const reference = { id: 'architecture' } as const
    expect(navigation.managerSettingsNavigationRoute('team', 'architecture')).toMatchObject({ state: 'available' })
    const router = managerRouter({ kind: 'manager-content', id: 'team:architecture', reference })
    let mountFailure: unknown
    const model = managerModel(undefined, {
      mountManagerContent: async (_id, _reference, container) => {
        try {
          return await navigation.mountManagerContent('team', reference, 'team:architecture', container)
        } catch (error) {
          mountFailure = error
          throw error
        }
      },
      closeManagerContent: () => navigation.closeManagerContent(),
    })
    try {
      await fixture.render(
        <div className="cxr-root">
          <main className="cxr-content" style={{ height: 767, padding: 0 }}>
            <ManagerContentPage model={model} router={router} locale="en" />
          </main>
        </div>,
      )
      await vi.waitFor(() => {
        if (mountFailure !== undefined) throw mountFailure
        expect(fixture.document.querySelector('[data-fill="true"]')).not.toBeNull()
      })

      const panel = fixture.element('.cxr-manager-content-panel')
      const seat = fixture.element('.cxr-manager-content-seat')
      const page = fixture.element('[data-cordisx-manager-page]')
      const body = fixture.element('[data-cordisx-manager-page-body]')
      const team = fixture.element('.team-fill-fixture')
      const canvas = fixture.element('.cxr-ui-pan-zoom-canvas')
      expect(panel.firstElementChild).toBe(seat)
      expect(seat.firstElementChild).toBe(page)
      expect(page.lastElementChild).toBe(body)
      expect(body.classList.contains('cxr-react-root')).toBe(true)
      expect(body.firstElementChild).toBe(team)
      expect(team.contains(canvas)).toBe(true)
      expect(canvas.dataset.fill).toBe('true')
      expect(body.matches('.cxr-react-root:has(.cxr-ui-pan-zoom-canvas[data-fill="true"])')).toBe(true)

      expect(fixture.element('.cxr-content').style.height).toBe('767px')
      expect(fixture.dom.window.getComputedStyle(panel).display).toBe('flex')
      expect(fixture.dom.window.getComputedStyle(panel).overflow).toBe('hidden')
      expect(fixture.dom.window.getComputedStyle(seat).flexGrow).toBe('1')
      expect(fixture.dom.window.getComputedStyle(seat).overflow).toBe('hidden')
      expect(fixture.dom.window.getComputedStyle(page).height).toBe('100%')
      expect(fixture.dom.window.getComputedStyle(body).height).toBe('100%')
      expect(fixture.dom.window.getComputedStyle(canvas).height).toBe('100%')
    } finally {
      await fixture.render(null)
      await navigation.dispose()
      outlets.dispose()
      pages.dispose()
      contexts.dispose()
      shared.dispose()
      style.remove()
      await fixture.dispose()
    }
  })

  it('keeps ordinary Manager content on the scrolling layout', async () => {
    const fixture = reactManagerFixture()
    const style = fixture.document.createElement('style')
    style.textContent = REACT_MANAGER_STYLES
    fixture.document.head.append(style)
    const reference = { id: 'ordinary' } as const
    const router = managerRouter({ kind: 'manager-content', id: 'demo:ordinary', reference })
    const model = managerModel(undefined, {
      mountManagerContent: async (_id, _reference, container) => {
        const body = container.ownerDocument.createElement('p')
        body.dataset.ordinaryManagerContent = 'true'
        body.textContent = 'Ordinary scrolling page'
        container.append(body)
        const abort = new AbortController()
        return {
          owner: 'demo',
          contributionId: 'demo:ordinary',
          routeId: 'demo:ordinary',
          pageId: 'demo:ordinary',
          signal: abort.signal,
          abort: () => abort.abort(),
          dispose: async () => body.remove(),
        }
      },
      closeManagerContent: async () => {},
    })
    try {
      await fixture.render(
        <div className="cxr-root">
          <main className="cxr-content" style={{ height: 767, padding: 0 }}>
            <ManagerContentPage model={model} router={router} locale="en" />
          </main>
        </div>,
      )
      await vi.waitFor(() => expect(fixture.document.querySelector('[data-ordinary-manager-content]')).not.toBeNull())
      const panel = fixture.element('.cxr-manager-content-panel')
      const seat = fixture.element('.cxr-manager-content-seat')
      expect(fixture.dom.window.getComputedStyle(panel).display).toBe('block')
      expect(fixture.dom.window.getComputedStyle(panel).overflow).toBe('auto')
      expect(fixture.dom.window.getComputedStyle(seat).flexGrow).toBe('')
    } finally {
      await fixture.dispose()
      style.remove()
    }
    expect(REACT_MANAGER_STYLES).toContain(
      '.cxr-manager-content-panel { min-width: 0; min-height: 0; flex: 1; overflow: auto;',
    )
    expect(REACT_MANAGER_STYLES).toContain(
      '.cxr-manager-content-panel:has(.cxr-ui-pan-zoom-canvas[data-fill="true"]) { display: flex;',
    )
    expect(REACT_MANAGER_STYLES).toContain(
      '[data-cordisx-manager-page]:has(.cxr-ui-pan-zoom-canvas[data-fill="true"]) > [data-cordisx-manager-page-body] { grid-row: 2; height: 100%;',
    )
  })
})
