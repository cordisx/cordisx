import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import type { CordisXNavigationCollectionSnapshot } from '../packages/cli/src/contracts.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { exactDomPermissionPolicies, installPermissionPolicyBridge } from './helpers/dom-permission.js'

describe('sidebar navigation collections', () => {
  it('renders a Host-owned group, atomically inserts rows, and selects exact route params', async () => {
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
      <aside><nav data-cordisx-playground-surface="sidebar.navigation.items"></nav></aside>
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
      const structuredStyles = document.getElementById('cordisx-structured-styles')?.textContent ?? ''
      expect(document.querySelectorAll('#cordisx-structured-styles')).toHaveLength(1)
      expect(structuredStyles).toContain('.cordisx-room-composite-seat { position: relative;')
      expect(structuredStyles).toContain('.cxrv-composite { position: absolute;')
      expect(structuredStyles).toContain('.cxrv-participant, .cxrv-overflow { position: absolute;')
      expect(document.querySelector('.cordisx-navigation > .cordisx-nav-row')?.textContent).toContain('New room')
      expect(document.querySelector('.cordisx-navigation > .cordisx-nav-row .cordisx-room-composite-seat')).toBeNull()
      expect(document.querySelector('.cordisx-navigation > .cordisx-nav-row .cordisx-host-icon')).not.toBeNull()
      const group = document.querySelector<HTMLElement>('[data-navigation-group="navigation-collection:rooms:rooms"]')!
      expect(group.querySelector('[role="heading"]')?.textContent).toBe('Rooms')
      expect([...group.querySelectorAll('.cordisx-nav-row')].map(row => row.querySelector('.cxsi-title')?.textContent)).toEqual(['Latest room', 'Older room'])
      expect([...group.querySelectorAll<HTMLElement>('.cxrv-composite')].map(visual => visual.dataset.roomCompositeCategory)).toEqual(['1', '2'])
      expect([...group.querySelectorAll<HTMLElement>('.cxrv-composite')].map(visual => visual.textContent)).toEqual(['LE', 'REWR'])
      const compositeSeat = group.querySelector<HTMLElement>('.cordisx-room-composite-seat')!
      const composite = compositeSeat.querySelector<HTMLElement>('.cxrv-composite')!
      const participant = composite.querySelector<HTMLElement>('.cxrv-participant')!
      expect(dom.window.getComputedStyle(compositeSeat).position).toBe('relative')
      expect(dom.window.getComputedStyle(compositeSeat).width).toBe('16px')
      expect(dom.window.getComputedStyle(compositeSeat).height).toBe('16px')
      expect(dom.window.getComputedStyle(compositeSeat).padding).toBe('0px')
      expect(dom.window.getComputedStyle(compositeSeat).borderTopWidth).toBe('0px')
      expect(dom.window.getComputedStyle(compositeSeat).gap).toBe('0')
      expect(dom.window.getComputedStyle(compositeSeat).backgroundColor).toBe('rgba(0, 0, 0, 0)')
      expect(dom.window.getComputedStyle(compositeSeat).boxShadow).toBe('none')
      expect(dom.window.getComputedStyle(composite).position).toBe('absolute')
      expect(dom.window.getComputedStyle(composite).gap).toBe('0')
      expect(dom.window.getComputedStyle(participant).position).toBe('absolute')
      expect(dom.window.getComputedStyle(participant).borderRadius).toBe('50%')
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
      sameRows[2]!.querySelector<HTMLButtonElement>('.cordisx-nav-primary')!.click()
      await vi.waitFor(() => expect(sameRows[2]!.dataset.selected).toBe('true'))
      expect(sameRows.filter(row => row.dataset.selected === 'true')).toEqual([sameRows[2]])
      expect(errors).toEqual([])
      expect(warnings).toEqual([])
      await runtime?.dispose()
      runtime = undefined
      expect(document.querySelector('[data-navigation-group]')).toBeNull()
      expect(document.querySelector('.cordisx-room-composite-seat')).toBeNull()
      expect(document.getElementById('cordisx-structured-styles')).toBeNull()
      expect(document.querySelector('style[data-cordisx-agent-avatar-style]')).toBeNull()
      expect((dom.window as unknown as { __cordisxNavigationCollectionFixture?: unknown }).__cordisxNavigationCollectionFixture).toBeUndefined()

      const collision = new JSDOM(`<!doctype html><html lang="en"><head></head><body>
        <aside><nav data-cordisx-playground-surface="sidebar.navigation.items"></nav></aside>
        <main data-cordisx-playground-seat="app"></main>
        <main data-cordisx-playground-seat="main"></main>
        <main data-cordisx-playground-seat="session.content"></main>
      </body></html>`, { runScripts: 'dangerously', url: 'http://127.0.0.1/' })
      const collisionErrors: unknown[][] = []
      collision.window.console.error = (...values: unknown[]) => { collisionErrors.push(values) }
      installPermissionPolicyBridge(collision.window)
      const foreignStyle = collision.window.document.createElement('style')
      foreignStyle.id = 'cordisx-structured-styles'
      foreignStyle.textContent = '.foreign-owner { display: block; }'
      collision.window.document.head.append(foreignStyle)
      collision.window.eval(bundle)
      await vi.waitFor(() => expect(collisionErrors.flat().join(' ')).toContain('CordisX structured styles are already owned by another renderer'))
      expect(collision.window.document.querySelectorAll('#cordisx-structured-styles')).toHaveLength(1)
      expect(collision.window.document.getElementById('cordisx-structured-styles')).toBe(foreignStyle)
      expect(foreignStyle.textContent).toBe('.foreign-owner { display: block; }')
      expect((collision.window as unknown as { __cordisxRuntime?: unknown }).__cordisxRuntime).toBeUndefined()
      collision.window.close()
    } finally {
      await runtime?.dispose()
      await new Promise(resolve => setTimeout(resolve, 0))
      dom.window.close()
    }
  }, 20_000)
})
