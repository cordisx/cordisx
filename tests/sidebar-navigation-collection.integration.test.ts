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
      expect(document.querySelector('.cordisx-navigation > .cordisx-nav-row')?.textContent).toContain('New room')
      const group = document.querySelector<HTMLElement>('[data-navigation-group="navigation-collection:rooms:rooms"]')!
      expect(group.querySelector('[role="heading"]')?.textContent).toBe('Rooms')
      expect([...group.querySelectorAll('.cordisx-nav-row')].map(row => row.textContent)).toEqual(['Latest room', 'Older room'])
      document.documentElement.lang = 'zh-CN'
      await vi.waitFor(() => expect(document.querySelector('[data-navigation-group] [role="heading"]')?.textContent).toBe('房间'))
      document.documentElement.lang = 'en'
      await vi.waitFor(() => expect(document.querySelector('[data-navigation-group] [role="heading"]')?.textContent).toBe('Rooms'))

      const older = [...document.querySelectorAll<HTMLButtonElement>('[data-navigation-group] .cordisx-nav-primary')]
        .find(button => button.textContent === 'Older room')!
      older.click()
      await vi.waitFor(() => {
        const row = [...document.querySelectorAll<HTMLElement>('.cordisx-nav-row')].find(candidate => candidate.textContent === 'Older room')
        expect(row?.dataset.selected).toBe('true')
      })
      expect([...document.querySelectorAll<HTMLElement>('[data-navigation-group] .cordisx-nav-row')].filter(row => row.dataset.selected === 'true')).toHaveLength(1)
      expect([...document.querySelectorAll<HTMLElement>('.cordisx-nav-row')].find(row => row.textContent === 'Latest room')?.dataset.selected).toBe('false')

      const fixture = (dom.window as unknown as {
        __cordisxNavigationCollectionFixture: { replace(next: CordisXNavigationCollectionSnapshot): void }
      }).__cordisxNavigationCollectionFixture
      fixture.replace({
        revision: 2,
        items: [
          { id: 'created', label: { key: 'created', fallback: 'Created room' }, route: { id: 'room', params: { roomId: 'created' } }, order: -10 },
          { id: 'latest', label: { key: 'latest', fallback: 'Latest room' }, route: { id: 'room', params: { roomId: 'latest' } }, order: 0 },
          { id: 'older', label: { key: 'older', fallback: 'Older room' }, route: { id: 'room', params: { roomId: 'older' } }, order: 10 },
        ],
      })
      await vi.waitFor(() => {
        expect([...document.querySelectorAll('[data-navigation-group] .cordisx-nav-row')].map(row => row.textContent))
          .toEqual(['Created room', 'Latest room', 'Older room'])
      })
      const created = [...document.querySelectorAll<HTMLButtonElement>('[data-navigation-group] .cordisx-nav-primary')]
        .find(button => button.textContent === 'Created room')!
      created.click()
      await vi.waitFor(() => expect(
        [...document.querySelectorAll<HTMLElement>('.cordisx-nav-row')].find(row => row.textContent === 'Created room')?.dataset.selected,
      ).toBe('true'))
      expect([...document.querySelectorAll<HTMLElement>('[data-navigation-group] .cordisx-nav-row')]
        .filter(row => row.dataset.selected === 'true')).toHaveLength(1)
      expect(errors).toEqual([])
      expect(warnings).toEqual([])
      await runtime?.dispose()
      runtime = undefined
      expect(document.querySelector('[data-navigation-group]')).toBeNull()
      expect((dom.window as unknown as { __cordisxNavigationCollectionFixture?: unknown }).__cordisxNavigationCollectionFixture).toBeUndefined()
    } finally {
      await runtime?.dispose()
      await new Promise(resolve => setTimeout(resolve, 0))
      dom.window.close()
    }
  }, 20_000)
})
