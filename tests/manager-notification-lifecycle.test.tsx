import React, { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarketplaceCatalogPlugin, MarketplaceModel } from '../packages/cli/src/renderer/marketplace.js'
import {
  installNotificationHost,
  notificationCenterForDocument,
} from '../packages/cli/src/renderer/notifications/host.js'
import { managerModel, managerSnapshot, reactManagerFixture } from './helpers/react-manager.js'

vi.mock('../packages/cli/src/renderer/host-ui/BrandMark.js', () => ({
  BrandMark: () => <span data-brand-mark="true" />,
  createBrandMarkElement: (document: Document) => document.createElement('span'),
}))

const plugin = {
  id: 'example',
  identity: 'example@1.0.0',
  version: '1.0.0',
  schemaVersion: 7,
  source: 'https://example.test/plugin',
  feedUrl: 'https://example.test/feed.json',
  feedName: 'Example feed',
  feedFallbackLocale: 'en',
  feedLocalizations: {},
  feedHomepage: 'https://example.test/',
  fallbackLocale: 'en',
  name: 'Example',
  description: 'Example plugin',
  localizations: {},
  license: 'MIT',
  compatibility: { cordisx: '^0.1.0' },
  authors: [{ name: 'Example' }],
  keywords: [],
  artifact: {
    packageName: '@example/plugin',
    packageNamespace: '@example',
    publisherIdentity: 'npm:@example',
    downloadUrl: 'https://registry.example/plugin.tgz',
    integrity: `sha256:${'a'.repeat(64)}`,
  },
} as MarketplaceCatalogPlugin

function marketplace(plugins: readonly MarketplaceCatalogPlugin[] = []): MarketplaceModel {
  return {
    snapshot: () => ({
      sources: [],
      sourceRecords: [],
      sourceStates: [],
      plugins,
      duplicates: [],
      loading: false,
      revalidating: false,
    }),
    subscribe: () => () => {},
    reload: async () => {},
    dispose() {},
  } as MarketplaceModel
}

afterEach(() => vi.restoreAllMocks())

describe('Manager-owned notification surfaces', () => {
  it('opens notification rules inside Manager history and closes without a detached dialog', async () => {
    const fixture = reactManagerFixture()
    const { ManagerApp } = await import('../packages/cli/src/renderer/manager/ManagerApp.js')
    let disposeNotifications!: () => void
    await act(async () => {
      disposeNotifications = installNotificationHost(fixture.document, 'test')
    })
    const seat = fixture.document.createElement('span')
    fixture.document.body.append(seat)
    try {
      await fixture.render(
        <ManagerApp model={managerModel()} marketplace={marketplace()} triggerSeat={seat} />,
      )
      await fixture.click('[data-cordisx-manager-trigger]')
      await fixture.click('[data-tab="notifications"]')
      expect(fixture.document.querySelector('[data-cordisx-manager-modal] [data-notification-rules-page]'))
        .not.toBeNull()
      expect(fixture.document.querySelector('[data-notification-rules-page]')?.textContent)
        .toContain('No muted notifications')
      expect(fixture.document.querySelector('dialog.cxn-rules')).toBeNull()
      expect(fixture.document.querySelector('[data-tab="notifications"]')?.getAttribute('aria-current')).toBe('page')

      await fixture.click('.cxr-header [aria-label="Back"]')
      expect(fixture.document.querySelector('[data-notification-rules-page]')).toBeNull()
      expect(fixture.document.querySelector('[data-unified-plugins-page="true"]')).not.toBeNull()

      await act(async () => {
        fixture.document.querySelector<HTMLElement>('[data-tab="notifications"]')!.click()
        await Promise.resolve()
      })
      await fixture.click('.cxr-header [aria-label="Close CordisX Manager"]')
      expect(fixture.document.querySelector('[data-cordisx-manager-modal]')).toBeNull()
      expect(fixture.document.querySelector('[data-notification-rules-page]')).toBeNull()

      await act(async () => {
        notificationCenterForDocument(fixture.document)!.manage()
        await Promise.resolve()
      })
      expect(fixture.document.querySelector('[data-notification-rules-page]')).not.toBeNull()
      await fixture.click('.cxr-header [aria-label="Close CordisX Manager"]')
      await act(async () => {
        fixture.document.querySelector<HTMLElement>('[data-cordisx-manager-trigger]')!.click()
        await Promise.resolve()
      })
      expect(fixture.document.querySelectorAll('[data-cordisx-manager-modal]')).toHaveLength(1)
      expect(fixture.document.querySelectorAll('[data-notification-rules-page]')).toHaveLength(1)
    } finally {
      await act(async () => disposeNotifications())
      await fixture.dispose()
    }
  })

  it('dismisses install feedback with its Manager session without aborting or leaking late failures', async () => {
    const fixture = reactManagerFixture()
    const { ManagerApp } = await import('../packages/cli/src/renderer/manager/ManagerApp.js')
    let disposeNotifications!: () => void
    await act(async () => {
      disposeNotifications = installNotificationHost(fixture.document, 'test')
    })
    const seat = fixture.document.createElement('span')
    fixture.document.body.append(seat)
    const pending: Array<{ readonly signal: AbortSignal; reject(error: Error): void }> = []
    const inspect = vi.fn((_request, signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => pending.push({ signal, reject }))
    )
    const snapshot = managerSnapshot({
      pluginLifecycle: { profileId: 'test', revision: 1, runtimeGeneration: 'runtime', operationsAvailable: true },
    })
    try {
      await fixture.render(
        <ManagerApp
          model={managerModel(snapshot, { inspectMarketplaceArtifact: inspect, requestPluginLifecycle: vi.fn() })}
          marketplace={marketplace([plugin])}
          triggerSeat={seat}
        />,
      )
      await fixture.click('[data-cordisx-manager-trigger]')
      await fixture.click('[data-tab="marketplace"]')
      await fixture.click('[data-marketplace-plugin="example"] [aria-label="Install"]')
      expect(pending[0]?.signal.aborted).toBe(false)

      await fixture.click('.cxr-header [aria-label="Close CordisX Manager"]')
      expect(pending[0]?.signal.aborted).toBe(false)
      await act(async () => {
        pending[0]!.reject(new Error('late install failure'))
        await new Promise(resolve => fixture.dom.window.setTimeout(resolve, 0))
      })
      expect(fixture.document.querySelector('.cxn-card')).toBeNull()

      await fixture.click('[data-cordisx-manager-trigger]')
      expect(fixture.document.querySelector('.cxn-card')).toBeNull()
      await fixture.click('[data-marketplace-plugin="example"] [aria-label="Install"]')
      await act(async () => {
        pending[1]!.reject(new Error('visible install failure'))
        await new Promise(resolve => fixture.dom.window.setTimeout(resolve, 0))
      })
      expect(fixture.document.querySelectorAll('.cxn-card')).toHaveLength(1)
      expect(fixture.document.querySelector('.cxn-card')?.textContent).toContain('visible install failure')

      await fixture.click('.cxr-header [aria-label="Close CordisX Manager"]')
      expect(fixture.document.querySelector('.cxn-card')).toBeNull()
      await fixture.click('[data-cordisx-manager-trigger]')
      expect(fixture.document.querySelector('.cxn-card')).toBeNull()
      await fixture.click('[data-marketplace-plugin="example"] [aria-label="Install"]')
      await act(async () => {
        pending[2]!.reject(new Error('visible install failure'))
        await new Promise(resolve => fixture.dom.window.setTimeout(resolve, 0))
      })
      expect(fixture.document.querySelectorAll('.cxn-card')).toHaveLength(1)
    } finally {
      await act(async () => disposeNotifications())
      await fixture.dispose()
    }
  })
})
