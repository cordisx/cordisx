import React, { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { PluginManagementSnapshot } from '../packages/cli/src/management/contracts.js'
import { BrowserMarketplaceModel, OFFICIAL_MARKETPLACE_SOURCE } from '../packages/cli/src/renderer/marketplace.js'
import type { ManagerPluginManagementBinding } from '../packages/cli/src/renderer/manager/model/plugin-management.js'
import { installNotificationHost } from '../packages/cli/src/renderer/notifications/host.js'
import { reactManagerFixture } from './helpers/react-manager.js'

const feed = {
  schemaVersion: 2,
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v2.schema.json',
  fallbackLocale: 'en',
  name: 'Fixture',
  homepage: 'https://fixture.example/',
  plugins: [],
}

function managementSnapshot(): PluginManagementSnapshot {
  return {
    profileId: 'test',
    revision: 7,
    sources: [{
      url: OFFICIAL_MARKETPLACE_SOURCE,
      enabled: true,
      official: true,
      removable: false,
      local: { name: 'Managed Marketplace', description: 'Shared profile source' },
    }],
    hiddenCatalogEntries: [{ sourceUrl: OFFICIAL_MARKETPLACE_SOURCE, pluginId: 'hidden-demo' }],
    migrations: { legacyBrowserSourcesV2: true },
    runtime: { kind: 'active', runtimeGeneration: 'runtime' },
    activationRevision: 1,
    plugins: [],
  }
}

describe('React Marketplace source controls', () => {
  it('uses shared management snapshot and revisioned mutations without browser-store writes', async () => {
    const fixture = reactManagerFixture()
    const { MarketplaceSourcesPage } = await import(
      '../packages/cli/src/renderer/manager/pages/MarketplaceSourcesPage.js'
    )
    const marketplace = new BrowserMarketplaceModel(
      undefined,
      async () => ({ ok: true, status: 200, text: async () => JSON.stringify(feed) }),
    )
    await marketplace.reload()
    const snapshot = managementSnapshot()
    const mutate = vi.fn().mockImplementation(async request => ({
      status: 'applied' as const,
      request,
      snapshot,
      pendingActivation: false,
    }))
    const binding: ManagerPluginManagementBinding = {
      query: vi.fn(async () => snapshot),
      subscribe: vi.fn(() => () => {}),
      mutate,
      migrateLegacySources: vi.fn(async () => ({ migrated: false, clearLegacyStorage: false, snapshot })),
    }
    try {
      await fixture.render(
        <MarketplaceSourcesPage
          marketplace={marketplace}
          locale="en"
          pluginManagement={binding}
          managementSnapshot={snapshot}
        />,
      )
      const source = fixture.element(`[data-marketplace-source="${OFFICIAL_MARKETPLACE_SOURCE}"]`)
      expect(source.textContent).toContain('Managed Marketplace')
      expect(source.textContent).toContain('Shared profile source')
      await fixture.click('.t-switch')
      expect(mutate).toHaveBeenCalledWith({
        kind: 'source-set-enabled',
        url: OFFICIAL_MARKETPLACE_SOURCE,
        enabled: false,
      }, 7)
      await fixture.click('[aria-haspopup="menu"]')
      const remove = [...fixture.document.querySelectorAll<HTMLElement>('.t-dropdown__item')]
        .find(item => item.textContent?.includes('Remove source'))
      expect(remove?.classList.contains('t-dropdown__item--disabled')).toBe(true)
      expect(fixture.document.querySelector('[aria-label="Restore hidden-demo"]')).toBeNull()
    } finally {
      await fixture.dispose()
      marketplace.dispose()
    }
  })

  it('shows an honest unavailable state when the binding is absent', async () => {
    const fixture = reactManagerFixture()
    const { MarketplaceSourcesPage } = await import(
      '../packages/cli/src/renderer/manager/pages/MarketplaceSourcesPage.js'
    )
    const marketplace = new BrowserMarketplaceModel(undefined, async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(feed),
    }))
    try {
      await fixture.render(
        <MarketplaceSourcesPage marketplace={marketplace} locale="en" />,
      )
      expect(fixture.document.body.textContent).toContain('Plugin management is unavailable')
    } finally {
      await fixture.dispose()
      marketplace.dispose()
    }
  })

  it('preserves management query failures as a diagnostic error', async () => {
    const fixture = reactManagerFixture()
    const { MarketplaceSourcesPage } = await import(
      '../packages/cli/src/renderer/manager/pages/MarketplaceSourcesPage.js'
    )
    const marketplace = new BrowserMarketplaceModel(undefined, async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(feed),
    }))
    try {
      await fixture.render(
        <MarketplaceSourcesPage
          marketplace={marketplace}
          locale="en"
          pluginManagement={{} as ManagerPluginManagementBinding}
          managementError="bridge timed out"
        />,
      )
      expect(fixture.document.querySelector('[data-plugin-management-error="true"]')?.textContent).toContain(
        'bridge timed out',
      )
    } finally {
      await fixture.dispose()
      marketplace.dispose()
    }
  })

  it('reports source retry failures through Host notifications', async () => {
    const fixture = reactManagerFixture()
    const shadows: ShadowRoot[] = []
    const attach = fixture.dom.window.HTMLElement.prototype.attachShadow
    const shadowSpy = vi.spyOn(fixture.dom.window.HTMLElement.prototype, 'attachShadow').mockImplementation(
      function(this: HTMLElement, options) {
        const shadow = attach.call(this, options)
        shadows.push(shadow)
        return shadow
      },
    )
    let disposeNotifications!: () => void
    await act(async () => {
      disposeNotifications = installNotificationHost(fixture.document, 'test')
    })
    fixture.dom.window.HTMLDialogElement.prototype.showModal = function() {
      this.setAttribute('open', '')
    }
    fixture.dom.window.HTMLDialogElement.prototype.close = function() {
      this.removeAttribute('open')
    }
    const { dialogCenterForDocument, installDialogHost } = await import(
      '../packages/cli/src/renderer/dialogs/host.js'
    )
    const disposeDialogs = installDialogHost(fixture.document)
    const { MarketplaceSourcesPage } = await import(
      '../packages/cli/src/renderer/manager/pages/MarketplaceSourcesPage.js'
    )
    const marketplace = new BrowserMarketplaceModel(undefined, async () => ({
      ok: false,
      status: 503,
      text: async () => 'Unavailable',
    }))
    await marketplace.reload()
    const snapshot = managementSnapshot()
    const reloadSource = vi.spyOn(marketplace, 'reloadSource').mockRejectedValue(new Error('Source refresh failed'))
    const binding: ManagerPluginManagementBinding = {
      query: vi.fn(async () => snapshot),
      subscribe: vi.fn(() => () => {}),
      mutate: vi.fn(),
      migrateLegacySources: vi.fn(async () => ({ migrated: false, clearLegacyStorage: false, snapshot })),
    }
    try {
      await fixture.render(
        <MarketplaceSourcesPage
          marketplace={marketplace}
          locale="en"
          pluginManagement={binding}
          managementSnapshot={snapshot}
        />,
      )
      await fixture.click('[aria-label^="View source error"]')
      expect(dialogCenterForDocument(fixture.document)!.visible()[0]!.chrome.title).toBe('Source error')
      await act(async () => {
        shadows.at(-1)!.querySelector<HTMLButtonElement>('[data-action=confirm]')!.click()
        await new Promise(resolve => fixture.dom.window.setTimeout(resolve, 0))
      })
      expect(reloadSource).toHaveBeenCalledExactlyOnceWith(OFFICIAL_MARKETPLACE_SOURCE)
      expect(fixture.document.querySelector('.cxr-page > [role="status"]')).toBeNull()
      expect(fixture.document.querySelector('.cxn-card')?.textContent).toContain('Plugin management action failed')
      expect(fixture.document.querySelector('.cxn-card')?.textContent).toContain('Source refresh failed')
    } finally {
      await act(async () => disposeDialogs())
      await act(async () => disposeNotifications())
      shadowSpy.mockRestore()
      await fixture.dispose()
      marketplace.dispose()
    }
  })
})
