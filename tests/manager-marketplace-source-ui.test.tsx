import React from 'react'
import { describe, expect, it } from 'vitest'
import { BrowserMarketplaceModel, OFFICIAL_MARKETPLACE_SOURCE } from '../packages/cli/src/renderer/marketplace.js'
import { reactManagerFixture } from './helpers/react-manager.js'

const feed = {
  schemaVersion: 2,
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v2.schema.json',
  fallbackLocale: 'en',
  name: 'Fixture',
  homepage: 'https://fixture.example/',
  plugins: [],
}

describe('React Marketplace source controls', () => {
  it('validates on confirmation, saves normalized URLs and local names, toggles sources and protects the official source', async () => {
    const fixture = reactManagerFixture()
    const { MarketplaceSourcesPage } = await import(
      '../packages/cli/src/renderer/manager/pages/MarketplaceSourcesPage.js'
    )
    const marketplace = new BrowserMarketplaceModel(
      fixture.dom.window.localStorage,
      async () => ({ ok: true, status: 200, text: async () => JSON.stringify(feed) }),
    )
    await marketplace.reload()
    try {
      await fixture.render(<MarketplaceSourcesPage marketplace={marketplace} locale="en" />)
      expect(
        fixture.element(`[data-marketplace-source="${OFFICIAL_MARKETPLACE_SOURCE}"] [aria-label^="删除"]`).classList
          .contains('t-is-disabled'),
      ).toBe(true)
      await fixture.click('.cxr-page-head button')
      expect(fixture.document.querySelector('.cxr-dialog-form [role="alert"]')).toBeNull()
      await fixture.type('.cxr-dialog-form input', 'invalid-source')
      await fixture.click('.t-dialog__footer .t-button--theme-primary')
      expect(fixture.document.querySelector('.cxr-dialog-form [role="alert"]')?.textContent).toMatch(/\S/u)
      await fixture.type('.cxr-dialog-form input', ' https://community.example/feed.json ')
      await fixture.type('.cxr-dialog-form label:nth-child(2) input', ' Community ')
      await fixture.click('.t-dialog__footer .t-button--theme-primary')
      const saved = marketplace.snapshot().sourceRecords.find(source =>
        source.url === 'https://community.example/feed.json'
      )
      expect(saved).toMatchObject({ enabled: true, local: { name: 'Community' } })
      await fixture.click('[data-marketplace-source="https://community.example/feed.json"] .t-switch')
      expect(marketplace.snapshot().sourceRecords.find(source => source.url === saved!.url)?.enabled).toBe(false)
      await fixture.click('[data-marketplace-source="https://community.example/feed.json"] [aria-label^="删除"]')
      expect(marketplace.snapshot().sourceRecords.some(source => source.url === saved!.url)).toBe(false)
      expect(marketplace.snapshot().sourceRecords.some(source => source.url === OFFICIAL_MARKETPLACE_SOURCE)).toBe(true)
    } finally {
      await fixture.dispose()
      marketplace.dispose()
    }
  })
})
