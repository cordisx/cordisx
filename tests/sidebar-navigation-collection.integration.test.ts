import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import type { CordisXNavigationCollectionSnapshotV3 } from '../packages/cli/src/contracts.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { exactDomPermissionPolicies, installPermissionPolicyBridge } from './helpers/dom-permission.js'
import {
  activatePlaygroundReviewNavigation,
  authorizePlaygroundReviewNavigation,
} from '../packages/cli/src/playground/client/review-navigation.js'

function copySessionStorage(source: Storage, target: Storage): void {
  for (let index = 0; index < source.length; index += 1) {
    const key = source.key(index)
    if (key !== null) target.setItem(key, source.getItem(key)!)
  }
}

interface PlaygroundReloadRuntime {
  snapshot(): {
    readonly navigation: { readonly outlets: readonly { readonly id: string; readonly activeRoute?: string }[] }
  }
  navigate(owner: string, reference: Readonly<{ id: string; params?: Readonly<Record<string, string>> }>): Promise<void>
  setExtensionPointPolicies(
    source: string,
    pluginId: string,
    policies: readonly { readonly pointId: string; readonly policy: 'inherit' | 'allow' | 'deny' }[],
  ): Promise<void>
  dispose(): Promise<void>
}

function playgroundMarkup(): string {
  return `<!doctype html><html lang="en"><head></head><body>
    <aside><nav data-cordisx-playground-surface="sidebar.navigation.items"></nav></aside>
    <main data-cordisx-playground-seat="app"></main>
    <main data-cordisx-playground-seat="main"></main>
    <main data-cordisx-playground-seat="session.content"></main>
  </body></html>`
}

const imageVisual = () => ({
  kind: 'image' as const,
  image: {
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/raster-image-snapshot.v1.schema.json' as const,
    contract: 'cordisx.raster-image-snapshot/v1' as const,
    schemaVersion: 1 as const,
    mediaType: 'image/png' as const,
    encoding: 'base64' as const,
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    width: 1,
    height: 1,
  },
})

describe('sidebar navigation collections', () => {
  it(
    'keeps an exact restored Room history entry pending through review authorization in a fresh Playground document and rejects revoked, foreign, and stale entries',
    async () => {
      const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
      const baseConfig = await loadConfig(path.join(projectRoot, 'cordisx.config.example.json'))
      const entry = path.join(projectRoot, 'tests/fixtures/navigation-collection-plugin.ts')
      const source = pathToFileURL(entry).href
      const config = {
        ...baseConfig,
        plugins: [{ id: 'navigation-collection', entry, enabled: true, config: {} }],
      }
      const bundle = await buildRendererBundle(config, {
        playground: true,
        generation: 'navigation-collection-reload-pending',
        profileId: 'playground',
        permission: { profileId: 'playground', bridgeToken: '7'.repeat(64), policies: [] },
      })
      const first = new JSDOM(playgroundMarkup(), { runScripts: 'dangerously', url: 'http://127.0.0.1/' })
      const reloaded = new JSDOM(playgroundMarkup(), { runScripts: 'dangerously', url: 'http://127.0.0.1/' })
      let firstRuntime: PlaygroundReloadRuntime | undefined
      let reloadedRuntime: PlaygroundReloadRuntime | undefined
      try {
        installPermissionPolicyBridge(first.window)
        first.window.eval(bundle)
        await vi.waitFor(() => {
          expect(first.window.document.documentElement.dataset.cordisxReady).toBe('true')
          firstRuntime = (first.window as unknown as { __cordisxRuntime?: PlaygroundReloadRuntime }).__cordisxRuntime
          expect(firstRuntime).toBeDefined()
        })
        await firstRuntime!.setExtensionPointPolicies(source, 'navigation-collection', [
          { pointId: 'sidebar.navigation.items', policy: 'allow' },
          { pointId: 'main', policy: 'allow' },
        ])
        await firstRuntime!.navigate('navigation-collection', { id: 'room', params: { roomId: 'room-1' } })
        await vi.waitFor(() =>
          expect(firstRuntime!.snapshot().navigation.outlets.find(outlet => outlet.id === 'main'))
            .toMatchObject({ activeRoute: 'navigation-collection:room' })
        )
        const state = first.window.history.state as {
          readonly key: string
          readonly idx: number
          readonly __cordisxRouteV1?: unknown
        }
        expect(state.__cordisxRouteV1).toMatchObject({
          routeId: 'navigation-collection:room',
          params: { roomId: 'room-1' },
        })
        copySessionStorage(first.window.sessionStorage, reloaded.window.sessionStorage)
        reloaded.window.history.replaceState({ key: state.key, idx: state.idx }, '', '/')
        await firstRuntime!.dispose()
        firstRuntime = undefined

        installPermissionPolicyBridge(reloaded.window)
        reloaded.window.eval(bundle)
        await vi.waitFor(() => {
          expect(reloaded.window.document.documentElement.dataset.cordisxReady).toBe('true')
          reloadedRuntime =
            (reloaded.window as unknown as { __cordisxRuntime?: PlaygroundReloadRuntime }).__cordisxRuntime
          expect(reloadedRuntime).toBeDefined()
        })
        expect(reloaded.window.history.state.__cordisxRouteV1).toMatchObject({
          routeId: 'navigation-collection:room',
          params: { roomId: 'room-1' },
        })
        expect(reloadedRuntime!.snapshot().navigation.outlets.find(outlet => outlet.id === 'main')?.activeRoute)
          .toBeUndefined()

        activatePlaygroundReviewNavigation(reloaded.window.document, 'navigation-collection:new-room')
        await authorizePlaygroundReviewNavigation(
          reloadedRuntime! as unknown as Parameters<typeof authorizePlaygroundReviewNavigation>[0],
          'navigation-collection:new-room',
        )
        await vi.waitFor(() =>
          expect(reloadedRuntime!.snapshot().navigation.outlets.find(outlet => outlet.id === 'main'))
            .toMatchObject({ activeRoute: 'navigation-collection:room' })
        )

        await reloadedRuntime!.setExtensionPointPolicies(source, 'navigation-collection', [{
          pointId: 'main',
          policy: 'deny',
        }])
        await vi.waitFor(() => {
          expect(reloaded.window.history.state.__cordisxRouteV1).toBeUndefined()
          expect(reloadedRuntime!.snapshot().navigation.outlets.find(outlet => outlet.id === 'main')?.activeRoute)
            .toBeUndefined()
        })

        reloaded.window.history.pushState(
          {
            __cordisxRouteV1: {
              schemaVersion: 1,
              owner: 'foreign',
              routeId: 'foreign:room',
              outlet: 'main',
              path: '/main/rooms/room-1',
              params: { roomId: 'room-1' },
            },
          },
          '',
          '/',
        )
        await vi.waitFor(() => expect(reloaded.window.history.state.__cordisxRouteV1).toBeUndefined())

        reloaded.window.history.pushState(
          {
            __cordisxRouteV1: {
              schemaVersion: 1,
              owner: 'navigation-collection',
              routeId: 'navigation-collection:stale',
              outlet: 'main',
              path: '/main/rooms/room-1',
              params: { roomId: 'room-1' },
            },
          },
          '',
          '/',
        )
        await vi.waitFor(() => expect(reloaded.window.history.state.__cordisxRouteV1).toBeUndefined())
      } finally {
        await firstRuntime?.dispose()
        await reloadedRuntime?.dispose()
        first.window.close()
        reloaded.window.close()
      }
    },
    30_000,
  )

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
    const dom = new JSDOM(
      `<!doctype html><html lang="en"><head></head><body>
      <aside>
        <nav data-cordisx-playground-surface="sidebar.navigation.items"></nav>
        <section data-native-recent-tasks><h2>Recent tasks</h2><button>Existing task</button></section>
      </aside>
      <main data-cordisx-playground-seat="app"></main>
      <main data-cordisx-playground-seat="main"></main>
      <main data-cordisx-playground-seat="session.content"></main>
    </body></html>`,
      { runScripts: 'dangerously', url: 'http://127.0.0.1/' },
    )
    const errors: unknown[][] = []
    const warnings: unknown[][] = []
    dom.window.console.error = (...values: unknown[]) => {
      errors.push(values)
    }
    dom.window.console.warn = (...values: unknown[]) => {
      warnings.push(values)
    }
    installPermissionPolicyBridge(dom.window)
    const writeText = vi.fn(async (_value: string) => {})
    Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, value: { writeText } })
    let runtime: { snapshot(): unknown; dispose(): Promise<void> } | undefined
    try {
      dom.window.eval(bundle)
      await vi.waitFor(() => {
        expect(dom.window.document.documentElement.dataset.cordisxReady).toBe('true')
        runtime = (dom.window as unknown as { __cordisxRuntime?: typeof runtime }).__cordisxRuntime
        const count = dom.window.document.querySelectorAll('.cordisx-nav-row').length
        if (count !== 3) {
          throw new Error(
            JSON.stringify({
              count,
              snapshot: runtime?.snapshot(),
              errors,
              warnings,
              html: dom.window.document.body.innerHTML,
            }),
          )
        }
      }, { timeout: 5_000, interval: 10 })
      const document = dom.window.document
      const recentTasks = document.querySelector<HTMLElement>('[data-native-recent-tasks]')!
      const recentTasksMarkup = recentTasks.outerHTML
      const structuredStyles = document.getElementById('cordisx-structured-styles')?.textContent ?? ''
      expect(document.querySelectorAll('#cordisx-structured-styles')).toHaveLength(1)
      expect(structuredStyles).toContain('.cordisx-nav-primary > .cordisx-navigation-image-seat.cxsi-icon')
      expect(structuredStyles).not.toContain('room-composite')
      expect(document.querySelector('.cordisx-navigation > .cordisx-nav-row')?.textContent).toContain('New room')
      expect(document.querySelector('.cordisx-navigation > .cordisx-nav-row .cordisx-navigation-image-seat')).toBeNull()
      expect(document.querySelector('.cordisx-navigation > .cordisx-nav-row .cordisx-host-icon')).not.toBeNull()
      const group = document.querySelector<HTMLElement>('[data-navigation-group="navigation-collection:rooms:rooms"]')!
      expect(group.querySelector('[role="heading"]')?.textContent).toBe('Rooms')
      expect([...group.querySelectorAll('.cordisx-nav-row')].map(row => row.querySelector('.cxsi-title')?.textContent))
        .toEqual(['Latest room', 'Older room'])
      expect(group.querySelectorAll('.cordisx-navigation-image-seat')).toHaveLength(2)
      const imageSeat = group.querySelector<HTMLElement>('.cordisx-navigation-image-seat')!
      const image = imageSeat.querySelector<HTMLImageElement>('img')!
      expect(image.getAttribute('alt')).toBe('')
      expect(image.getAttribute('aria-hidden')).toBe('true')
      expect(image.src).toMatch(/^data:image\/png;base64,/u)
      expect(dom.window.getComputedStyle(imageSeat).width).toBe('16px')
      expect(dom.window.getComputedStyle(imageSeat).height).toBe('16px')
      document.documentElement.lang = 'zh-CN'
      await vi.waitFor(() =>
        expect(document.querySelector('[data-navigation-group] [role="heading"]')?.textContent).toBe('房间')
      )
      document.documentElement.lang = 'en'
      await vi.waitFor(() =>
        expect(document.querySelector('[data-navigation-group] [role="heading"]')?.textContent).toBe('Rooms')
      )

      const latestRow = [...document.querySelectorAll<HTMLElement>('[data-navigation-group] .cordisx-nav-row')]
        .find(row => row.querySelector('.cxsi-title')?.textContent === 'Latest room')!
      latestRow.querySelector<HTMLButtonElement>('[aria-label="Pin"]')!.click()
      await vi.waitFor(() =>
        expect(
          (dom.window as unknown as { __cordisxNavigationCollectionFixture: { commands: string[] } })
            .__cordisxNavigationCollectionFixture.commands,
        ).toEqual(['pin'])
      )
      const refreshedLatestRow = [...document.querySelectorAll<HTMLElement>('[data-navigation-group] .cordisx-nav-row')]
        .find(row => row.querySelector('.cxsi-title')?.textContent === 'Latest room')!
      refreshedLatestRow.querySelector<HTMLButtonElement>('.cordisx-navigation-more-action')!.click()
      document.querySelector<HTMLButtonElement>('[aria-label="Copy ID"]')!.click()
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('latest'))
      refreshedLatestRow.querySelector<HTMLButtonElement>('.cordisx-navigation-more-action')!.click()
      document.querySelector<HTMLButtonElement>('[aria-label="Delete"]')!.click()
      const dialog = document.querySelector<HTMLElement>('.cordisx-navigation-confirm')!
      expect(dialog.getAttribute('aria-modal')).toBe('true')
      expect(dialog.textContent).toContain('Delete room?')
      ;[...dialog.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Delete')!
        .click()
      await vi.waitFor(() =>
        expect(
          (dom.window as unknown as { __cordisxNavigationCollectionFixture: { commands: string[] } })
            .__cordisxNavigationCollectionFixture.commands,
        ).toEqual(['pin', 'delete'])
      )
      expect(document.querySelector('.cordisx-navigation-confirm')).toBeNull()

      const older = [...document.querySelectorAll<HTMLButtonElement>('[data-navigation-group] .cordisx-nav-primary')]
        .find(button => button.querySelector('.cxsi-title')?.textContent === 'Older room')!
      older.click()
      await vi.waitFor(() => {
        const row = [...document.querySelectorAll<HTMLElement>('.cordisx-nav-row')]
          .find(candidate => candidate.querySelector('.cxsi-title')?.textContent === 'Older room')
        expect(row?.dataset.selected).toBe('true')
      })
      expect(
        [...document.querySelectorAll<HTMLElement>('[data-navigation-group] .cordisx-nav-row')].filter(row =>
          row.dataset.selected === 'true'
        ),
      ).toHaveLength(1)
      expect(
        [...document.querySelectorAll<HTMLElement>('.cordisx-nav-row')]
          .find(row => row.querySelector('.cxsi-title')?.textContent === 'Latest room')?.dataset.selected,
      ).toBe('false')

      const fixture = (dom.window as unknown as {
        __cordisxNavigationCollectionFixture: {
          replace(next: CordisXNavigationCollectionSnapshotV3): void
          commands: string[]
        }
      }).__cordisxNavigationCollectionFixture
      fixture.replace({
        revision: 2,
        items: [
          {
            id: 'created',
            label: { key: 'created', fallback: 'Created room' },
            leadingVisual: imageVisual(),
            route: { id: 'room', params: { roomId: 'created' } },
            order: -10,
          },
          {
            id: 'latest',
            label: { key: 'latest', fallback: 'Latest room' },
            leadingVisual: imageVisual(),
            route: { id: 'room', params: { roomId: 'latest' } },
            order: 0,
          },
          {
            id: 'older',
            label: { key: 'older', fallback: 'Older room' },
            leadingVisual: imageVisual(),
            route: { id: 'room', params: { roomId: 'older' } },
            order: 10,
          },
        ],
      })
      await vi.waitFor(() => {
        expect(
          [...document.querySelectorAll('[data-navigation-group] .cordisx-nav-row')].map(row =>
            row.querySelector('.cxsi-title')?.textContent
          ),
        )
          .toEqual(['Created room', 'Latest room', 'Older room'])
      })
      const created = [...document.querySelectorAll<HTMLButtonElement>('[data-navigation-group] .cordisx-nav-primary')]
        .find(button => button.querySelector('.cxsi-title')?.textContent === 'Created room')!
      created.click()
      await vi.waitFor(() =>
        expect(
          [...document.querySelectorAll<HTMLElement>('.cordisx-nav-row')]
            .find(row => row.querySelector('.cxsi-title')?.textContent === 'Created room')?.dataset.selected,
        ).toBe('true')
      )
      expect([...document.querySelectorAll<HTMLElement>('[data-navigation-group] .cordisx-nav-row')]
        .filter(row => row.dataset.selected === 'true')).toHaveLength(1)

      fixture.replace({
        revision: 3,
        items: [
          {
            id: 'room-0',
            label: { key: 'same', fallback: 'Same room' },
            leadingVisual: imageVisual(),
            route: { id: 'room', params: { roomId: 'room-0' } },
            order: 0,
          },
          {
            id: 'room-1',
            label: { key: 'same', fallback: 'Same room' },
            leadingVisual: imageVisual(),
            route: { id: 'room', params: { roomId: 'room-1' } },
            order: 1,
          },
          {
            id: 'room-2',
            label: { key: 'same', fallback: 'Same room' },
            leadingVisual: imageVisual(),
            route: { id: 'room', params: { roomId: 'room-2' } },
            order: 2,
          },
          {
            id: 'room-3',
            label: { key: 'same', fallback: 'Same room' },
            leadingVisual: imageVisual(),
            route: { id: 'room', params: { roomId: 'room-3' } },
            order: 3,
          },
          {
            id: 'room-4',
            label: { key: 'same', fallback: 'Same room' },
            leadingVisual: imageVisual(),
            route: { id: 'room', params: { roomId: 'room-4' } },
            order: 4,
          },
        ],
      })
      await vi.waitFor(() =>
        expect(document.querySelectorAll('[data-navigation-group] .cordisx-navigation-image-seat')).toHaveLength(5)
      )
      const sameRows = [...document.querySelectorAll<HTMLElement>('[data-navigation-group] .cordisx-nav-row')]
      expect(sameRows.map(row => row.querySelector('.cxsi-title')?.textContent)).toEqual(Array(5).fill('Same room'))
      expect(sameRows.every(row => row.querySelector('img[aria-hidden="true"]') !== null)).toBe(true)
      sameRows[2]!.querySelector<HTMLButtonElement>('.cordisx-nav-primary')!.click()
      await vi.waitFor(() => expect(sameRows[2]!.dataset.selected).toBe('true'))
      expect(sameRows.filter(row => row.dataset.selected === 'true')).toEqual([sameRows[2]])
      expect(recentTasks.outerHTML).toBe(recentTasksMarkup)
      expect(recentTasks.querySelector('.cordisx-navigation-image-seat')).toBeNull()
      expect(errors).toEqual([])
      expect(warnings).toEqual([])
      await runtime?.dispose()
      runtime = undefined
      expect(document.querySelector('[data-navigation-group]')).toBeNull()
      expect(document.querySelector('.cordisx-navigation-image-seat')).toBeNull()
      expect(document.getElementById('cordisx-structured-styles')).toBeNull()
      expect(document.querySelector('style[data-cordisx-agent-avatar-style]')).toBeNull()
      expect(
        (dom.window as unknown as { __cordisxNavigationCollectionFixture?: unknown })
          .__cordisxNavigationCollectionFixture,
      ).toBeUndefined()

      const collision = new JSDOM(
        `<!doctype html><html lang="en"><head></head><body>
        <aside><nav data-cordisx-playground-surface="sidebar.navigation.items"></nav></aside>
        <main data-cordisx-playground-seat="app"></main>
        <main data-cordisx-playground-seat="main"></main>
        <main data-cordisx-playground-seat="session.content"></main>
      </body></html>`,
        { runScripts: 'dangerously', url: 'http://127.0.0.1/' },
      )
      const collisionErrors: unknown[][] = []
      collision.window.console.error = (...values: unknown[]) => {
        collisionErrors.push(values)
      }
      installPermissionPolicyBridge(collision.window)
      const foreignStyle = collision.window.document.createElement('style')
      foreignStyle.id = 'cordisx-structured-styles'
      foreignStyle.textContent = '.foreign-owner { display: block; }'
      collision.window.document.head.append(foreignStyle)
      collision.window.eval(bundle)
      await vi.waitFor(() =>
        expect(collisionErrors.flat().join(' ')).toContain(
          'CordisX structured styles are already owned by another renderer',
        )
      )
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
