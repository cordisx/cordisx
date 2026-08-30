import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import type { CordisXNavigationCollectionSnapshot } from '../packages/cli/src/contracts.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { exactDomPermissionPolicies, installPermissionPolicyBridge } from './helpers/dom-permission.js'

describe('sidebar navigation collections', () => {
  it('renders the production Host bundle with isolated compact visuals and exact route params', async () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const baseConfig = await loadConfig(path.join(projectRoot, 'cordisx.config.example.json'))
    const entry = path.join(projectRoot, 'tests/fixtures/navigation-collection-plugin.ts')
    const config = {
      ...baseConfig,
      plugins: [{ id: 'navigation-collection', entry, enabled: true, config: {} }],
    }
    const bundle = await buildRendererBundle(config, {
      playground: true,
      generation: 'navigation-collection-test',
      profileId: 'playground',
      permission: {
        profileId: 'playground',
        bridgeToken: '6'.repeat(64),
        policies: exactDomPermissionPolicies('playground', [{
          id: 'navigation-collection',
          entry,
          pointIds: ['sidebar.navigation.items', 'main'],
        }]),
      },
    })
    const dom = new JSDOM(`<!doctype html><html lang="en"><head></head><body>
      <aside>
        <nav data-cordisx-playground-surface="sidebar.navigation.items"></nav>
        <section data-native-recent-tasks><h2>Recent tasks</h2><button>Existing task</button></section>
      </aside>
      <main data-cordisx-playground-seat="app"></main>
      <main data-cordisx-playground-seat="main"></main>
      <main data-cordisx-playground-seat="session.content"></main>
    </body></html>`, { runScripts: 'dangerously', url: 'http://127.0.0.1/' })
    const errors: unknown[][] = []
    const warnings: unknown[][] = []
    dom.window.console.error = (...values: unknown[]) => { errors.push(values) }
    dom.window.console.warn = (...values: unknown[]) => { warnings.push(values) }
    installPermissionPolicyBridge(dom.window)
    let runtime: { snapshot(): unknown; dispose(): Promise<void> } | undefined
    try {
      dom.window.eval(bundle)
      await vi.waitFor(() => {
        expect(dom.window.document.documentElement.dataset.cordisxReady).toBe('true')
        runtime = (dom.window as unknown as { __cordisxRuntime?: typeof runtime }).__cordisxRuntime
        const count = dom.window.document.querySelectorAll('.cordisx-nav-row').length
        if (count !== 3) throw new Error(JSON.stringify({ count, snapshot: runtime?.snapshot(), errors, warnings, html: dom.window.document.body.innerHTML }))
      }, { timeout: 5_000, interval: 10 })
      const document = dom.window.document
      const recentTasks = document.querySelector<HTMLElement>('[data-native-recent-tasks]')!
      const recentTasksMarkup = recentTasks.outerHTML
      expect(document.querySelector('.cordisx-navigation > .cordisx-nav-row')?.textContent).toContain('New room')
      expect(document.querySelector('.cordisx-navigation > .cordisx-nav-row .cordisx-room-composite-seat')).toBeNull()
      expect(document.querySelector('.cordisx-navigation > .cordisx-nav-row .cordisx-host-icon')).not.toBeNull()
      const group = document.querySelector<HTMLElement>('[data-navigation-group="navigation-collection:rooms:rooms"]')!
      expect(group.querySelector('[role="heading"]')?.textContent).toBe('Rooms')
      expect([...group.querySelectorAll('.cordisx-nav-row')].map(row => row.querySelector('.cxsi-title')?.textContent)).toEqual(['Latest room', 'Older room'])
      expect([...group.querySelectorAll<HTMLElement>('.cxrv-composite')].map(visual => visual.dataset.roomCompositeCategory)).toEqual(['1', '2'])
      expect([...group.querySelectorAll<HTMLElement>('.cxrv-composite')].map(visual => visual.textContent)).toEqual(['LE', 'REWR'])
      const structuredStyles = document.querySelectorAll<HTMLStyleElement>('#cordisx-structured-styles')
      expect(structuredStyles).toHaveLength(1)
      expect(structuredStyles[0]?.textContent).toContain('.cordisx-nav-primary > .cordisx-room-composite-seat.cxsi-icon')
      const initialSeat = group.querySelector<HTMLElement>('.cordisx-room-composite-seat')!
      const initialComposite = initialSeat.querySelector<HTMLElement>('.cxrv-composite')!
      const seatStyle = dom.window.getComputedStyle(initialSeat)
      const compositeComputedStyle = dom.window.getComputedStyle(initialComposite)
      expect(seatStyle.position).toBe('relative')
      expect(seatStyle.display).toBe('block')
      expect([seatStyle.width, seatStyle.minWidth, seatStyle.maxWidth]).toEqual(['16px', '16px', '16px'])
      expect([seatStyle.height, seatStyle.minHeight, seatStyle.maxHeight]).toEqual(['16px', '16px', '16px'])
      expect(seatStyle.backgroundColor).toBe('rgba(0, 0, 0, 0)')
      expect([seatStyle.borderTopWidth, seatStyle.paddingTop, seatStyle.gap, seatStyle.boxShadow]).toEqual(['0px', '0px', '0px', 'none'])
      expect(compositeComputedStyle.position).toBe('absolute')
      expect([compositeComputedStyle.width, compositeComputedStyle.height, compositeComputedStyle.overflow]).toEqual(['16px', '16px', 'hidden'])
      expect([compositeComputedStyle.backgroundColor, compositeComputedStyle.borderTopWidth, compositeComputedStyle.paddingTop, compositeComputedStyle.gap, compositeComputedStyle.boxShadow])
        .toEqual(['rgba(0, 0, 0, 0)', '0px', '0px', '0px', 'none'])
      document.documentElement.lang = 'zh-CN'
      await vi.waitFor(() => expect(document.querySelector('[data-navigation-group] [role="heading"]')?.textContent).toBe('房间'))
      document.documentElement.lang = 'en'
      await vi.waitFor(() => expect(document.querySelector('[data-navigation-group] [role="heading"]')?.textContent).toBe('Rooms'))

      const older = [...document.querySelectorAll<HTMLButtonElement>('[data-navigation-group] .cordisx-nav-primary')]
        .find(button => button.querySelector('.cxsi-title')?.textContent === 'Older room')!
      older.click()
      await vi.waitFor(() => {
        const row = [...document.querySelectorAll<HTMLElement>('.cordisx-nav-row')]
          .find(candidate => candidate.querySelector('.cxsi-title')?.textContent === 'Older room')
        expect(row?.dataset.selected).toBe('true')
      })
      expect([...document.querySelectorAll<HTMLElement>('[data-navigation-group] .cordisx-nav-row')].filter(row => row.dataset.selected === 'true')).toHaveLength(1)
      expect([...document.querySelectorAll<HTMLElement>('.cordisx-nav-row')]
        .find(row => row.querySelector('.cxsi-title')?.textContent === 'Latest room')?.dataset.selected).toBe('false')

      const fixture = (dom.window as unknown as {
        __cordisxNavigationCollectionFixture: { replace(next: CordisXNavigationCollectionSnapshot): void }
      }).__cordisxNavigationCollectionFixture
      fixture.replace({
        revision: 2,
        items: [
          { id: 'created', label: { key: 'created', fallback: 'Created room' }, leadingVisual: { kind: 'room-composite-avatar', participants: [] }, route: { id: 'room', params: { roomId: 'created' } }, order: -10 },
          { id: 'latest', label: { key: 'latest', fallback: 'Latest room' }, leadingVisual: { kind: 'room-composite-avatar', participants: [{ participantId: 'lead' }] }, route: { id: 'room', params: { roomId: 'latest' } }, order: 0 },
          { id: 'older', label: { key: 'older', fallback: 'Older room' }, leadingVisual: { kind: 'room-composite-avatar', participants: [{ participantId: 'reviewer' }, { participantId: 'writer' }] }, route: { id: 'room', params: { roomId: 'older' } }, order: 10 },
        ],
      })
      await vi.waitFor(() => {
        expect([...document.querySelectorAll('[data-navigation-group] .cordisx-nav-row')].map(row => row.querySelector('.cxsi-title')?.textContent))
          .toEqual(['Created room', 'Latest room', 'Older room'])
      })
      const created = [...document.querySelectorAll<HTMLButtonElement>('[data-navigation-group] .cordisx-nav-primary')]
        .find(button => button.querySelector('.cxsi-title')?.textContent === 'Created room')!
      created.click()
      await vi.waitFor(() => expect(
        [...document.querySelectorAll<HTMLElement>('.cordisx-nav-row')]
          .find(row => row.querySelector('.cxsi-title')?.textContent === 'Created room')?.dataset.selected,
      ).toBe('true'))
      expect([...document.querySelectorAll<HTMLElement>('[data-navigation-group] .cordisx-nav-row')]
        .filter(row => row.dataset.selected === 'true')).toHaveLength(1)

      fixture.replace({
        revision: 3,
        items: [
          { id: 'room-0', label: { key: 'same', fallback: 'Same room' }, leadingVisual: { kind: 'room-composite-avatar', participants: [] }, route: { id: 'room', params: { roomId: 'room-0' } }, order: 0 },
          { id: 'room-1', label: { key: 'same', fallback: 'Same room' }, leadingVisual: { kind: 'room-composite-avatar', participants: [{ participantId: 'alpha' }] }, route: { id: 'room', params: { roomId: 'room-1' } }, order: 1 },
          { id: 'room-2', label: { key: 'same', fallback: 'Same room' }, leadingVisual: { kind: 'room-composite-avatar', participants: [{ participantId: 'bravo' }, { participantId: 'charlie' }] }, route: { id: 'room', params: { roomId: 'room-2' } }, order: 2 },
          { id: 'room-3', label: { key: 'same', fallback: 'Same room' }, leadingVisual: { kind: 'room-composite-avatar', participants: [{ participantId: 'delta' }, { participantId: 'echo' }, { participantId: 'foxtrot' }] }, route: { id: 'room', params: { roomId: 'room-3' } }, order: 3 },
          { id: 'room-4', label: { key: 'same', fallback: 'Same room' }, leadingVisual: { kind: 'room-composite-avatar', participants: [{ participantId: 'golf' }, { participantId: 'hotel' }, { participantId: 'india' }, { participantId: 'juliet' }, { participantId: 'kilo' }] }, route: { id: 'room', params: { roomId: 'room-4' } }, order: 4 },
        ],
      })
      await vi.waitFor(() => expect([...document.querySelectorAll<HTMLElement>('[data-navigation-group] .cxrv-composite')]
        .map(visual => visual.dataset.roomCompositeCategory)).toEqual(['0', '1', '2', '3', '4+']))
      const sameRows = [...document.querySelectorAll<HTMLElement>('[data-navigation-group] .cordisx-nav-row')]
      expect(sameRows.map(row => row.querySelector('.cxsi-title')?.textContent)).toEqual(Array(5).fill('Same room'))
      expect(sameRows.map(row => row.querySelector('.cxrv-composite')?.textContent)).toEqual(['', 'AL', 'BRCH', 'DEECFO', 'GOHOIN+2'])
      expect(document.querySelectorAll('#cordisx-structured-styles')).toHaveLength(1)
      for (const participant of document.querySelectorAll<HTMLElement>('[data-navigation-group] .cxrv-participant')) {
        const participantStyle = dom.window.getComputedStyle(participant)
        expect(participantStyle.position).toBe('absolute')
        expect(participantStyle.borderRadius).toBe('50%')
        expect(Number.parseFloat(participantStyle.width)).toBeLessThanOrEqual(16)
        expect(Number.parseFloat(participantStyle.height)).toBeLessThanOrEqual(16)
      }
      sameRows[2]!.querySelector<HTMLButtonElement>('.cordisx-nav-primary')!.click()
      await vi.waitFor(() => expect(sameRows[2]!.dataset.selected).toBe('true'))
      expect(sameRows.filter(row => row.dataset.selected === 'true')).toEqual([sameRows[2]])
      expect(recentTasks.outerHTML).toBe(recentTasksMarkup)
      expect(recentTasks.querySelector('.cordisx-room-composite-seat, .cxrv-composite, .cxrv-participant')).toBeNull()
      expect(errors).toEqual([])
      expect(warnings).toEqual([])
      await runtime?.dispose()
      runtime = undefined
      expect(document.querySelector('[data-navigation-group]')).toBeNull()
      expect(document.querySelector('.cordisx-room-composite-seat')).toBeNull()
      expect(document.getElementById('cordisx-structured-styles')).toBeNull()
      expect(document.querySelector('style[data-cordisx-agent-avatar-style]')).toBeNull()
      expect((dom.window as unknown as { __cordisxNavigationCollectionFixture?: unknown }).__cordisxNavigationCollectionFixture).toBeUndefined()
    } finally {
      await runtime?.dispose()
      await new Promise(resolve => setTimeout(resolve, 0))
      dom.window.close()
    }
  }, 20_000)
})
