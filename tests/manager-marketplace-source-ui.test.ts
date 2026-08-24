import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  MARKETPLACE_SOURCE_RECORDS_KEY,
  MARKETPLACE_SOURCE_SCHEMA_V1,
  OFFICIAL_MARKETPLACE_SOURCE,
} from '../packages/cli/src/renderer/marketplace.js'
import { installCordisXManager, type ManagerModel, type ManagerSnapshot } from '../packages/cli/src/renderer/manager.js'
import { managerCopy } from '../packages/cli/src/renderer/ui-copy.js'

const CUSTOM_SOURCE = 'https://marketplace.example/community.json'
const CLIPBOARD_SOURCE = 'https://plugins.example/catalog.json'
const FEED_SCHEMA_V2 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v2.schema.json'

const feed = {
  $schema: FEED_SCHEMA_V2,
  schemaVersion: 2,
  fallbackLocale: 'en',
  name: 'Community Marketplace',
  localizations: { 'zh-CN': { name: '社区插件来源' } },
  homepage: 'https://marketplace.example/',
  plugins: [],
}

function snapshot(locale = 'zh-CN'): ManagerSnapshot {
  return {
    version: 'test',
    plugins: [],
    registrations: [],
    commands: [],
    navigation: { routes: [], pages: [], outlets: [] },
    localization: { locale, direction: 'ltr', version: 1 },
    localeCatalogs: [],
    localizationDiagnostics: [],
    platform: {
      hostId: 'codex-desktop', hostName: 'Codex Desktop', mode: 'unavailable',
      supportedCapabilities: [], diagnostics: [], secondConnectionCreated: false, rawBridgeExposed: false,
    },
    permissions: [],
  }
}

function managerModel(locale?: string): ManagerModel {
  return {
    snapshot: () => snapshot(locale),
    setPluginBlocked: async () => {},
    setPermissionPolicy: async () => {},
    subscribe: () => () => {},
  }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (check()) return
    await settle()
  }
  throw new Error('condition did not settle')
}

function installFixture(records?: readonly unknown[], locale?: string): { readonly dom: JSDOM; readonly dispose: () => void } {
  const dom = new JSDOM('<!doctype html><html class="electron-dark"><head></head><body></body></html>', {
    url: 'https://codex.local/native',
    pretendToBeVisual: true,
  })
  if (records !== undefined) {
    dom.window.localStorage.setItem(MARKETPLACE_SOURCE_RECORDS_KEY, JSON.stringify({ schemaVersion: 2, sources: records }))
  }
  Object.defineProperty(dom.window, 'fetch', {
    configurable: true,
    value: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(feed) }),
  })
  return { dom, dispose: installCordisXManager(dom.window.document, managerModel(locale)) }
}

describe('Manager Marketplace discovery and source IA', () => {
  it('keeps discovery controls fixed, scrolls only results, and opens the Host-owned source menu portal', async () => {
    const { dom, dispose } = installFixture([
      { url: OFFICIAL_MARKETPLACE_SOURCE, enabled: true },
      { url: CUSTOM_SOURCE, enabled: true, local: { name: '团队插件源', note: '内部推荐' } },
    ])
    try {
      dom.window.document.querySelector<HTMLButtonElement>('[data-tab="marketplace"]')!.click()
      await waitFor(() => dom.window.document.querySelector('[data-marketplace-discovery-page]') !== null)
      const content = dom.window.document.querySelector<HTMLElement>('.cxm-content')!
      const page = dom.window.document.querySelector<HTMLElement>('[data-marketplace-discovery-page]')!
      const tools = page.querySelector<HTMLElement>('.cxm-marketplace-discovery-tools')!
      const results = page.querySelector<HTMLElement>('[data-marketplace-results-scroll]')!
      const search = tools.querySelector<HTMLElement>('[data-collection-search="marketplace"]')!
      const filter = tools.querySelector<HTMLElement>('[data-marketplace-certified-only]')!
      expect(content.dataset.marketplaceDiscovery).toBe('true')
      expect(search.parentElement?.parentElement?.classList.contains('cxm-toolbar')).toBe(true)
      expect(filter.parentElement?.classList.contains('cxm-marketplace-filter-row')).toBe(true)
      expect(results.contains(tools)).toBe(false)
      expect([...dom.window.document.querySelectorAll('a, button')].map(item => item.textContent).join(' ')).not.toMatch(/docs|文档/iu)

      const styles = [...dom.window.document.querySelectorAll('style')].map(item => item.textContent ?? '').join('\n')
      expect(styles).toContain('.cxm-content[data-marketplace-discovery="true"] { overflow: hidden; }')
      expect(styles).toContain('.cxm-marketplace-results { min-width: 0; min-height: 0; flex: 1 1 auto;')
      expect(styles).toContain('repeat(auto-fill, minmax(min(100%, 300px), 1fr))')

      const sourceMenu = tools.querySelector<HTMLButtonElement>('[data-marketplace-source-menu]')!
      sourceMenu.click()
      const popup = dom.window.document.querySelector<HTMLElement>(`[data-manager-action-menu="${managerCopy('zh-CN', 'marketplace.source-menu-label')}"]`)!
      expect(popup.parentElement).toBe(dom.window.document.body)
      expect(popup.getAttribute('data-cordisx-app-theme')).toBe('dark')
      expect(sourceMenu.getAttribute('aria-expanded')).toBe('true')
      expect(dom.window.document.activeElement?.getAttribute('data-manager-menu-action')).toBe('create')
      popup.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      expect(dom.window.document.activeElement?.getAttribute('data-manager-menu-action')).toBe('clipboard')
      popup.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      expect(dom.window.document.querySelector(`[data-manager-action-menu="${managerCopy('zh-CN', 'marketplace.source-menu-label')}"]`)).toBeNull()
      expect(dom.window.document.activeElement).toBe(sourceMenu)
      expect(sourceMenu.getAttribute('aria-expanded')).toBe('false')
      sourceMenu.click()
      const reopened = dom.window.document.querySelector<HTMLElement>(`[data-manager-action-menu="${managerCopy('zh-CN', 'marketplace.source-menu-label')}"]`)!
      reopened.querySelector<HTMLButtonElement>('[data-manager-menu-action="manage"]')!.click()

      await waitFor(() => dom.window.document.querySelector('[data-marketplace-source-page="index"]') !== null)
      const sourceItems = [...dom.window.document.querySelectorAll<HTMLElement>('[data-collection-item]')]
      expect(sourceItems).toHaveLength(2)
      expect(sourceItems.map(item => item.textContent)).toEqual(expect.arrayContaining([
        expect.stringContaining('CordisX 官方插件商店'),
        expect.stringContaining('团队插件源'),
      ]))
      const official = sourceItems.find(item => item.dataset.collectionItem === OFFICIAL_MARKETPLACE_SOURCE)!
      official.querySelector<HTMLButtonElement>('.cxc-menu-trigger')!.click()
      const remove = dom.window.document.querySelector<HTMLButtonElement>('[data-collection-action="remove"]')!
      expect(remove.disabled).toBe(true)
      expect(remove.getAttribute('aria-label')).toContain(managerCopy('zh-CN', 'marketplace.source.official-remove-unavailable'))
      expect(dom.window.document.body.textContent).not.toContain('重新加载')
    } finally {
      dispose()
      dom.window.close()
    }
  })

  it('validates URL only after submit, saves local overrides, and imports marketplace-source.v1 from clipboard', async () => {
    const { dom, dispose } = installFixture()
    try {
      let clipboardValue = JSON.stringify({
        $schema: MARKETPLACE_SOURCE_SCHEMA_V1,
        schemaVersion: 1,
        url: CLIPBOARD_SOURCE,
        enabled: true,
        local: { name: '剪贴板来源', description: '从结构化来源描述导入。', note: '团队共享' },
      })
      Object.defineProperty(dom.window.navigator, 'clipboard', {
        configurable: true,
        value: {
          readText: async () => clipboardValue,
        },
      })
      dom.window.document.querySelector<HTMLButtonElement>('[data-tab="marketplace"]')!.click()
      await waitFor(() => dom.window.document.querySelector('[data-marketplace-source-menu]') !== null)
      dom.window.document.querySelector<HTMLButtonElement>('[data-marketplace-source-menu]')!.click()
      dom.window.document.querySelector<HTMLButtonElement>('[data-manager-menu-action="create"]')!.click()
      await waitFor(() => dom.window.document.querySelector('[data-marketplace-source-page="create"]') !== null)

      const form = dom.window.document.querySelector<HTMLFormElement>('[data-host-form="marketplace-source-create"]')!
      const urlError = form.querySelector<HTMLElement>('#cxm-marketplace-source-url-error')!
      expect(urlError.hidden).toBe(true)
      expect(dom.window.document.body.textContent).not.toContain("Failed to construct 'URL'")
      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
      expect(urlError.hidden).toBe(false)
      expect(urlError.textContent).toBe(managerCopy('zh-CN', 'marketplace.source.url-required'))

      const url = form.querySelector<HTMLElement & { onChange?: (value: string) => void }>('#cxm-marketplace-source-url')!
      const name = form.querySelector<HTMLElement & { onChange?: (value: string) => void }>('#cxm-marketplace-source-name')!
      const description = form.querySelector<HTMLElement & { onChange?: (value: string) => void }>('#cxm-marketplace-source-description')!
      const note = form.querySelector<HTMLElement & { onChange?: (value: string) => void }>('#cxm-marketplace-source-note')!
      url.onChange?.(CUSTOM_SOURCE)
      name.onChange?.('本地团队来源')
      description.onChange?.('团队维护的插件发现来源。')
      note.onChange?.('仅当前 profile 可见')
      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
      await waitFor(() => dom.window.document.querySelector('[data-marketplace-source-page="index"]') !== null)
      expect(dom.window.document.querySelector(`[data-collection-item="${CUSTOM_SOURCE}"]`)?.textContent).toContain('本地团队来源')

      const persisted = JSON.parse(dom.window.localStorage.getItem(MARKETPLACE_SOURCE_RECORDS_KEY)!) as {
        sources: Array<{ url: string; local?: { name?: string; description?: string; note?: string } }>
      }
      expect(persisted.sources.find(item => item.url === CUSTOM_SOURCE)?.local).toEqual({
        name: '本地团队来源', description: '团队维护的插件发现来源。', note: '仅当前 profile 可见',
      })

      dom.window.document.querySelector<HTMLButtonElement>('[data-breadcrumb-target="primary:marketplace"]')!.click()
      await waitFor(() => dom.window.document.querySelector('[data-marketplace-source-menu]') !== null)
      dom.window.document.querySelector<HTMLButtonElement>('[data-marketplace-source-menu]')!.click()
      dom.window.document.querySelector<HTMLButtonElement>('[data-manager-menu-action="clipboard"]')!.click()
      await waitFor(() => [...dom.window.document.querySelectorAll<HTMLElement>('[data-collection-item]')]
        .some(item => item.dataset.collectionItem === CLIPBOARD_SOURCE))
      expect(dom.window.document.querySelector(`[data-collection-item="${CLIPBOARD_SOURCE}"]`)?.textContent).toContain('剪贴板来源')
      expect(dom.window.document.body.textContent).toContain(managerCopy('zh-CN', 'marketplace.source.imported'))
      expect(dom.window.document.querySelector('[data-settings-tab="host:marketplace"]')).toBeNull()

      clipboardValue = '{}'
      dom.window.document.querySelector<HTMLButtonElement>('[data-breadcrumb-target="primary:marketplace"]')!.click()
      await waitFor(() => dom.window.document.querySelector('[data-marketplace-source-menu]') !== null)
      dom.window.document.querySelector<HTMLButtonElement>('[data-marketplace-source-menu]')!.click()
      dom.window.document.querySelector<HTMLButtonElement>('[data-manager-menu-action="clipboard"]')!.click()
      await settle()
      await settle()
      dom.window.document.querySelector<HTMLButtonElement>('[data-marketplace-source-menu]')!.click()
      dom.window.document.querySelector<HTMLButtonElement>('[data-manager-menu-action="manage"]')!.click()
      await waitFor(() => dom.window.document.querySelector<HTMLElement>('.cxf-alert[data-tone="error"]') !== null)
      const error = dom.window.document.querySelector<HTMLElement>('.cxf-alert[data-tone="error"]')!
      expect(error.textContent).toBe(managerCopy('zh-CN', 'marketplace.source.operation-failed'))
      expect(error.title).toMatch(/source|schema|invalid/iu)
    } finally {
      dispose()
      dom.window.close()
    }
  })

  it.each([
    ['en-US', 'Add source', 'Source URL'],
    ['zh-CN', '添加来源', '来源地址'],
  ])('uses short locale-first copy without developer internals for %s', async (locale, addSource, sourceUrl) => {
    const { dom, dispose } = installFixture([], locale)
    try {
      dom.window.document.querySelector<HTMLButtonElement>('[data-tab="marketplace"]')!.click()
      await waitFor(() => dom.window.document.querySelector('[data-marketplace-source-menu]') !== null)
      dom.window.document.querySelector<HTMLButtonElement>('[data-marketplace-source-menu]')!.click()
      dom.window.document.querySelector<HTMLButtonElement>('[data-manager-menu-action="create"]')!.click()
      await waitFor(() => dom.window.document.querySelector('[data-marketplace-source-page="create"]') !== null)

      const page = dom.window.document.querySelector<HTMLElement>('[data-marketplace-source-page="create"]')!
      expect(page.textContent).toContain(addSource)
      expect(page.textContent).toContain(sourceUrl)
      expect(page.textContent).not.toMatch(/Host|profile|canonical identity|marketplace-source\.v1|renderer|启动器|渲染器|规范标识/iu)
      expect(page.querySelector('#cxm-marketplace-source-url-error')?.textContent).toBe('')
    } finally {
      dispose()
      dom.window.close()
    }
  })
})
