import React, { act } from 'react'
import { describe, expect, it } from 'vitest'
import {
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_PAGE_SCHEMA_V4,
  CORDISX_ROUTE_SCHEMA_V2,
  type CordisXPageMetadata,
  type CordisXPageMetadataV4,
} from '../packages/cli/src/contracts.js'
import { NavigationRegistry, OutletRegistry, PageRegistry } from '../packages/cli/src/renderer/navigation.js'
import { installSharedReactRuntime } from '../packages/cli/src/renderer/react-runtime.js'
import { TestCodexRouteHistory } from './helpers/codex-route-history.js'
import { reactManagerFixture } from './helpers/react-manager.js'
import { fakeI18n, FakeOutlet } from './suites/navigation.fixtures.js'

const metadata: CordisXPageMetadataV4 = {
  $schema: CORDISX_PAGE_SCHEMA_V4,
  schemaVersion: 4,
  id: 'game',
  title: { key: 'title', fallback: 'Game' },
  description: { key: 'description', fallback: 'Play a game' },
  icon: 'host:info',
  chrome: 'standard',
}

describe('page v4 content inset', () => {
  it.each([undefined, 'standard', 'none'] as const)(
    'retains the standard header and projects %s body inset through both mount paths',
    async contentInset => {
      const fixture = reactManagerFixture()
      const shared = installSharedReactRuntime(fixture.document)
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
      const navigation = new NavigationRegistry(pages, outlets, i18n, new TestCodexRouteHistory())
      const seat = fixture.document.createElement('main')
      fixture.document.body.append(seat)
      const managerSeat = fixture.document.createElement('div')
      fixture.document.body.append(managerSeat)
      outlets.declare(
        {
          schemaVersion: 1,
          id: 'app',
          authority: 'host-adapter',
          scope: 'renderer',
          preferredPlacement: 'absolute',
          contextPolicy: 'generation',
        },
        new FakeOutlet(seat),
        path => path.startsWith('/game'),
      )
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
        new FakeOutlet(managerSeat, 'manager:game'),
        path => path.startsWith('/manager/extensions/'),
      )
      pages.register('demo', {
        ...metadata,
        ...(contentInset === undefined ? {} : { contentInset }),
      }, shared.defineReactPage(() => <div style={{ padding: 8 }}>Board boundary</div>))
      navigation.register('demo', { id: 'game', path: '/game', outlet: 'app', page: 'game' })
      navigation.register('demo', {
        $schema: CORDISX_ROUTE_SCHEMA_V2,
        schemaVersion: 2,
        id: 'manager-game',
        path: '/manager/extensions/game',
        outlet: 'manager.content',
        page: 'game',
        title: metadata.title,
        description: metadata.description,
      })
      const checkBody = (body: HTMLElement) => {
        expect(body.classList.contains('cxr-react-root')).toBe(true)
        expect(body.dataset.cordisxPageContentInset).toBe(contentInset ?? 'standard')
        expect(fixture.dom.window.getComputedStyle(body).padding).toBe(contentInset === 'none' ? '0px' : '16px')
        expect(fixture.dom.window.getComputedStyle(body.firstElementChild!).padding).toBe('8px')
      }
      try {
        await act(async () => {
          await navigation.navigate('demo', { id: 'game' })
        })
        checkBody(fixture.element('[data-cordisx-page-body]'))
        expect(fixture.element('[data-cordisx-page-title]').textContent).toBe('Game')

        await act(async () => {
          await navigation.mountManagerContent('demo', { id: 'manager-game' }, 'demo:manager-game', managerSeat)
        })
        checkBody(fixture.element('[data-cordisx-manager-page-body]'))
        expect(fixture.document.querySelector('[data-cordisx-manager-page] header')).toBeNull()
        expect(fixture.element('[data-cordisx-page-title]').textContent).toBe('Game')
      } finally {
        await act(async () => {
          await navigation.dispose()
        })
        shared.dispose()
        outlets.dispose()
        pages.dispose()
        await fixture.dispose()
      }
    },
  )

  it('rejects unversioned, old-version and arbitrary inset values before mounting', () => {
    const pages = new PageRegistry()
    try {
      for (
        const invalid of [
          { id: 'legacy', title: metadata.title, contentInset: 'none' },
          { ...metadata, $schema: CORDISX_PAGE_SCHEMA_V3, schemaVersion: 3, contentInset: 'none' },
          ...['16px', 0, null, {}].map(contentInset => ({ ...metadata, contentInset })),
        ]
      ) {
        expect(() => pages.register('demo', invalid as CordisXPageMetadata, () => undefined)).toThrow(/content.?inset/i)
      }
    } finally {
      pages.dispose()
    }
  })
})
