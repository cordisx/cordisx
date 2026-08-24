import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { MARKETPLACE_SOURCES_KEY } from '../packages/cli/src/renderer/marketplace.js'
import { installCordisXManager, type ManagerModel, type ManagerSnapshot } from '../packages/cli/src/renderer/manager.js'

const SOURCE = 'https://marketplace.example/feed.json'
const PLUGIN_SCHEMA_V2 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-plugin.v2.schema.json'
const FEED_SCHEMA_V2 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v2.schema.json'

const feed = {
  $schema: FEED_SCHEMA_V2,
  schemaVersion: 2,
  fallbackLocale: 'en',
  name: 'CordisX Marketplace',
  localizations: { 'zh-CN': { name: 'CordisX 插件商店' } },
  homepage: 'https://marketplace.example/',
  plugins: [{
    $schema: PLUGIN_SCHEMA_V2,
    schemaVersion: 2,
    id: 'slot-showcase',
    fallbackLocale: 'en',
    name: 'Slot Showcase',
    description: 'Shows structured CordisX extension points.',
    localizations: {
      'zh-CN': {
        name: '点位展示',
        description: '展示结构化 CordisX 扩展点。',
        authors: ['CordisX 团队'],
        keywords: ['扩展点', '界面'],
      },
    },
    version: '1.2.3',
    source: 'https://github.com/cordisx/slot-showcase',
    homepage: 'https://cordisx.github.io/',
    license: 'MIT',
    compatibility: { cordisx: '^0.1.0' },
    authors: [{ name: 'CordisX Team', url: 'https://cordisx.github.io/' }],
    keywords: ['extensions', 'ui'],
  }],
}

function snapshot(locale: 'en' | 'zh-CN'): ManagerSnapshot {
  return {
    version: 'test',
    plugins: [],
    registrations: [],
    commands: [],
    navigation: { routes: [], pages: [], outlets: [] },
    localization: { locale, direction: 'ltr', version: locale === 'en' ? 2 : 1 },
    localeCatalogs: [],
    localizationDiagnostics: [],
    platform: {
      hostId: 'codex-desktop', hostName: 'Codex Desktop', mode: 'unavailable',
      supportedCapabilities: [], diagnostics: [], secondConnectionCreated: false, rawBridgeExposed: false,
    },
    permissions: [],
  }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('Manager Marketplace product list', () => {
  it('uses the standard clickable card, locale projection/search, and no permanent trust warning', async () => {
    const dom = new JSDOM('<!doctype html><html class="electron-dark"><head></head><body></body></html>', { url: 'https://codex.local/' })
    dom.window.localStorage.setItem(MARKETPLACE_SOURCES_KEY, JSON.stringify([SOURCE]))
    let requests = 0
    Object.defineProperty(dom.window, 'fetch', {
      configurable: true,
      value: async () => {
        requests += 1
        return { ok: true, status: 200, text: async () => JSON.stringify(feed) }
      },
    })
    let state = snapshot('zh-CN')
    const listeners = new Set<() => void>()
    const model: ManagerModel = {
      snapshot: () => state,
      setPluginBlocked: async () => {},
      setPermissionPolicy: async () => {},
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    }
    const dispose = installCordisXManager(dom.window.document, model)
    try {
      dom.window.document.querySelector<HTMLButtonElement>('[data-tab="marketplace"]')!.click()
      for (let attempt = 0; attempt < 20 && dom.window.document.querySelector('[data-marketplace-plugin]') === null; attempt += 1) await settle()

      const card = dom.window.document.querySelector<HTMLElement>('[data-marketplace-plugin="slot-showcase"]')!
      const primary = card.querySelector<HTMLButtonElement>(':scope > .cxm-plugin-primary')!
      expect(card.tagName).toBe('DIV')
      expect(card.getAttribute('role')).toBe('listitem')
      expect(primary).not.toBeNull()
      expect(primary.querySelector('.cxm-plugin-icon')).not.toBeNull()
      expect(primary.querySelector('.cxm-plugin-name')?.textContent).toBe('点位展示')
      expect(primary.querySelector('.cxm-plugin-description')?.textContent).toBe('展示结构化 CordisX 扩展点。')
      expect(primary.querySelector('.cxm-plugin-meta-version')?.textContent).toBe('v1.2.3')
      expect(primary.querySelector('.cxm-plugin-meta-source')?.textContent).toBe('CordisX 插件商店')
      expect(card.querySelector('.cxm-chevron')).toBeNull()
      expect(dom.window.document.body.textContent).not.toContain('商店收录、schema 校验和页面展示都不代表')
      expect(dom.window.document.body.textContent).not.toContain('Shows structured CordisX extension points.')

      const styles = [...dom.window.document.querySelectorAll('style')].map(item => item.textContent ?? '').join('\n')
      expect(styles).toContain('.cxm-plugin-primary { display: flex;')
      expect(styles).toContain('padding: 12px')
      expect(styles).toContain('.cxm-plugin-meta-source { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }')
      expect(styles).toContain('.cxm-card-grid, .cxm-detail-grid, .cxm-plugin-list { grid-template-columns: 1fr; }')

      const search = dom.window.document.querySelector<HTMLInputElement>('[data-list-search="marketplace"] input')!
      search.value = 'Slot Showcase'
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect(dom.window.document.querySelector('[data-marketplace-plugin="slot-showcase"]')).not.toBeNull()
      const fallbackSearch = dom.window.document.querySelector<HTMLInputElement>('[data-list-search="marketplace"] input')!
      fallbackSearch.value = 'CordisX Team'
      fallbackSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect(dom.window.document.querySelector('[data-marketplace-plugin="slot-showcase"]')).not.toBeNull()

      state = snapshot('en')
      for (const listener of listeners) listener()
      const enSearch = dom.window.document.querySelector<HTMLInputElement>('[data-list-search="marketplace"] input')!
      enSearch.value = 'Slot Showcase'
      enSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      expect(dom.window.document.querySelector('.cxm-plugin-name')?.textContent).toBe('Slot Showcase')
      expect(dom.window.document.querySelector('.cxm-plugin-description')?.textContent).toBe('Shows structured CordisX extension points.')
      expect(dom.window.document.querySelector('.cxm-plugin-meta-source')?.textContent).toBe('CordisX Marketplace')
      expect(requests).toBe(1)

      dom.window.document.documentElement.className = 'electron-light'
      await settle()
      expect(dom.window.document.querySelector<HTMLElement>('[data-cordisx-manager-modal]')?.dataset.cordisxAppTheme).toBe('light')

      dom.window.document.querySelector<HTMLButtonElement>('[data-marketplace-plugin] .cxm-plugin-primary')!
        .dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      expect(dom.window.document.querySelector('[data-manager-page-route^="marketplace:"]')).not.toBeNull()
      expect(dom.window.document.querySelector('.cxm-detail-description')?.textContent).toBe('Shows structured CordisX extension points.')
      expect(dom.window.document.body.textContent).not.toContain('外部链接不代表代码审计')
    } finally {
      dispose()
      dom.window.close()
    }
  })
})
