import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V1,
  CORDISX_PLUGIN_LIFECYCLE_RESULT_SCHEMA_V1,
  type CordisXPluginLifecycleOperationV1,
  type CordisXPluginLifecycleResultV1,
} from '../packages/cli/src/contracts.js'
import {
  installCordisXManager,
  serializePluginConsoleExport,
  type ManagerModel,
  type ManagerPluginStatus,
  type ManagerSnapshot,
} from '../packages/cli/src/renderer/manager.js'

function snapshot(status: ManagerPluginStatus = 'active', locale = 'en'): ManagerSnapshot {
  return {
    version: 'test',
    plugins: [{
      id: 'base', source: 'https://plugins.example/base', name: 'Base Plugin', icon: 'data:image/png;base64,aWNvbg==', description: 'Keeps local work in sync.', inject: [], config: {}, status,
      ...(status === 'failed' ? { error: 'entry module crashed' } : {}),
      configuration: {
        namespace: 'base', schemaKind: 'none', applies: 'plugin-restart', writable: true,
        revision: 0, lastGoodRevision: 0, value: {}, fields: [], secrets: [],
      },
      package: {
        version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, moduleGeneration: 'base-a',
        dependencies: [], canonicalSource: 'https://plugins.example/base',
      },
    }],
    registrations: [], commands: [], navigation: { routes: [], pages: [], outlets: [] },
    localization: { locale, direction: 'ltr', version: 0 }, localeCatalogs: [], localizationDiagnostics: [],
    platform: {
      hostId: 'codex-desktop', hostName: 'Codex Desktop', mode: 'unavailable', supportedCapabilities: [],
      diagnostics: [], secondConnectionCreated: false, rawBridgeExposed: false,
    },
    permissions: [],
    pluginLifecycle: { profileId: 'work', revision: 1, runtimeGeneration: 'runtime-a', operationsAvailable: true },
  }
}

function result(
  operation: CordisXPluginLifecycleOperationV1['kind'],
  outcome: CordisXPluginLifecycleResultV1['outcome'],
  fields: Partial<CordisXPluginLifecycleResultV1> = {},
): CordisXPluginLifecycleResultV1 {
  return {
    $schema: CORDISX_PLUGIN_LIFECYCLE_RESULT_SCHEMA_V1,
    schemaVersion: 1,
    requestId: 'request', profileId: 'work', operation, outcome, revision: 1,
    runtimeGeneration: 'runtime-a', scope: operation === 'reload' ? 'plugin-restart' : 'plugin-generation',
    affectedPluginIds: [],
    ...fields,
  }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('Manager plugin card actions', () => {
  it('localizes the primary plugin-card action while detail headers use their breadcrumb without duplicate copy', async () => {
    for (const [locale, expectedOpen, expectedCurrent] of [
      ['en', 'Open plugin details · Base Plugin', 'Base Plugin'],
      ['zh-CN', '打开插件详情 · Base Plugin', 'Base Plugin'],
    ] as const) {
      const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://codex.local/' })
      const state = snapshot('active', locale)
      const model: ManagerModel = {
        snapshot: () => state,
        setPluginBlocked: async () => {}, setPermissionPolicy: async () => {}, subscribe: () => () => {},
      }
      const dispose = installCordisXManager(dom.window.document, model)
      try {
        const primary = dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-id="base"]')!
        expect(primary.querySelector<HTMLImageElement>('.cxm-plugin-icon > img')?.src).toBe('data:image/png;base64,aWNvbg==')
        expect(primary.querySelector('.cxc-icon-seat')?.getAttribute('data-icon-kind')).toBe('artwork')
        expect(primary.getAttribute('aria-label')).toBe(expectedOpen)
        expect(dom.window.document.querySelector('.cxm-content')?.getAttribute('data-manager-list-page')).toBe('true')
        primary.click()
        await settle()
        expect(dom.window.document.querySelector('.cxm-heading')?.textContent).toContain(expectedCurrent)
        expect(dom.window.document.querySelector('.cxm-heading > p')).toBeNull()
        expect(dom.window.document.querySelector('.cxm-content')?.hasAttribute('data-manager-list-page')).toBe(false)
      } finally {
        dispose()
        dom.window.close()
      }
    }
  })

  it('separates card navigation from Host-owned actions, persists profile favorites, and confirms dependency impact', async () => {
    const dom = new JSDOM('<!doctype html><html class="electron-dark"><head></head><body></body></html>', { url: 'https://codex.local/' })
    let state = snapshot()
    const listeners = new Set<() => void>()
    const operations: CordisXPluginLifecycleOperationV1[] = []
    const model: ManagerModel = {
      snapshot: () => state,
      setPluginBlocked: async () => {}, setPermissionPolicy: async () => {},
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
      requestPluginLifecycle: async operation => {
        operations.push(operation)
        if (operation.kind === 'disable' && operation.impactToken === '') {
          return result('disable', 'planned', { impactToken: 'impact-disable', affectedPluginIds: ['base', 'consumer'] })
        }
        if (operation.kind === 'disable') {
          state = snapshot('configured-disabled')
          for (const listener of listeners) listener()
          return result('disable', 'applied', { revision: 2, affectedPluginIds: ['base', 'consumer'] })
        }
        if (operation.kind === 'reload') return result('reload', 'applied', { affectedPluginIds: ['base'] })
        if (operation.kind === 'uninstall' && operation.impactToken === '') {
          return result('uninstall', 'planned', { impactToken: 'impact-uninstall', affectedPluginIds: ['base', 'consumer'] })
        }
        return result(operation.kind, 'applied')
      },
    }
    Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true })
    const dispose = installCordisXManager(dom.window.document, model)
    try {
      const manager = dom.window.document.querySelector<HTMLElement>('[data-cordisx-manager-modal]')!
      expect(manager.dataset.cordisxAppTheme).toBe('dark')
      dom.window.document.documentElement.className = 'electron-light'
      await settle()
      expect(manager.dataset.cordisxAppTheme).toBe('light')
      const card = dom.window.document.querySelector<HTMLElement>('[data-plugin-card="base"]')!
      const primary = card.querySelector<HTMLButtonElement>('[data-plugin-id="base"]')!
      expect(card.querySelector('.cxm-chevron')).toBeNull()
      expect(card.querySelectorAll('.cxc-primary')).toHaveLength(1)
      expect(card.querySelectorAll('[data-plugin-action]')).toHaveLength(3)
      expect(primary.getAttribute('aria-label')).toBe('Open plugin details · Base Plugin')
      expect(primary.getAttribute('aria-description')).toBe('Active')
      expect(primary.querySelector('.cxc-description')?.textContent).toBe('Keeps local work in sync.')
      expect(primary.querySelector('.cxc-machine-id')?.textContent).toBe('base')
      expect(primary.querySelector('.cxc-status')?.getAttribute('data-tone')).toBe('success')
      expect(primary.textContent).not.toContain('Active')
      expect([...card.querySelectorAll<HTMLButtonElement>('[data-plugin-action]')].map(button => button.getAttribute('aria-label')))
        .toEqual(['Disable plugin', 'Favorite plugin', 'Reload plugin'])
      expect(dom.window.document.querySelector('.cxm-heading')?.textContent).toContain('Plugins')
      expect(dom.window.document.querySelector('[role="list"]')?.getAttribute('aria-label')).toBe('Current bundle plugins')
      expect(dom.window.document.querySelector('.cxm-content')?.getAttribute('data-manager-list-page')).toBe('true')
      expect(dom.window.document.querySelector('.cxm-fixed-list-collection .cxc-list')).not.toBeNull()
      expect(dom.window.document.querySelector<HTMLInputElement>('[data-collection-search="plugins"]')?.getAttribute('aria-label')).toBe('Search plugins')
      expect(dom.window.document.querySelector('[data-collection-search="plugins"]')?.parentElement?.querySelector('.cxc-search-clear')?.getAttribute('aria-label')).toBe('Clear plugin search')
      const importButton = dom.window.document.querySelector<HTMLButtonElement>('[data-import-local-plugin]')!
      expect(importButton.textContent).toBe('')
      expect(importButton.getAttribute('aria-label')).toBe('Import local plugin')
      expect(importButton.classList.contains('cxm-manager-icon-action')).toBe(true)
      expect(importButton.classList.contains('cxm-toolbar-icon-action')).toBe(true)
      expect(importButton.querySelector('[data-host-icon-key="import-plugin"]')).not.toBeNull()
      importButton.focus()
      await new Promise(resolve => setTimeout(resolve, 680))
      expect(dom.window.document.querySelector('[role="tooltip"]')?.textContent).toBe('Import local plugin')
      importButton.blur()
      const managerStyles = dom.window.document.getElementById('cordisx-manager-style')?.textContent ?? ''
      expect(managerStyles).toContain('.cxm-toolbar > .cxm-action { height: 38px; }')
      expect(managerStyles).toContain('.cxm-toolbar > .cxm-toolbar-icon-action')
      expect(managerStyles).toContain('min-height: 38px')
      expect(managerStyles).toContain('opacity: 0;')
      expect(managerStyles).toContain('.cxc-card:focus-within .cxc-actions')
      expect(managerStyles).toContain('.cxm-content[data-manager-list-page="true"] { display: flex; overflow: hidden; }')
      expect(managerStyles).toContain('.cxm-fixed-list-collection .cxc-list { min-height: 0; flex: 1 1 auto; overflow: auto;')
      expect(managerStyles).toContain('.cxm-local-import-dialog { width: min(420px, 100%); padding: 12px; }')
      expect(managerStyles).toContain('.cxm-directory-control { display: grid; min-inline-size: 0; grid-template-columns: minmax(0, 1fr) 32px;')
      expect(managerStyles).toContain('.cxm-directory-control > :first-child { min-inline-size: 0; }')
      expect(managerStyles).toContain('.cxm-directory-picker { width: 32px; height: 32px; }')
      expect([...card.querySelectorAll<HTMLButtonElement>('.cxc-actions button')].every(button => button.tabIndex === 0)).toBe(true)

      card.querySelector<HTMLButtonElement>('[data-plugin-action="favorite"]')!.click()
      expect(dom.window.localStorage.getItem('cordisx.manager.favoritePlugins.v1:work')).toBe('["base"]')
      expect(dom.window.document.querySelector('[data-manager-page-route="primary:plugins"]')).not.toBeNull()

      dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-action="disable"]')!.click()
      await settle()
      expect(dom.window.document.querySelector('.cxm-lifecycle-impact')?.textContent).toContain('base、consumer')
      expect(operations).toEqual([{ kind: 'disable', pluginId: 'base', impactToken: '' }])
      dom.window.document.querySelectorAll<HTMLElement>('.cxm-lifecycle-actions t-button')[1]!.click()
      await settle()
      expect(operations.at(-1)).toEqual({ kind: 'disable', pluginId: 'base', impactToken: 'impact-disable' })
      expect(dom.window.document.querySelector('[data-manager-page-route="primary:plugins"]')).not.toBeNull()

      const menu = dom.window.document.querySelector<HTMLElement>('[data-plugin-menu="base"]')!
      const trigger = menu.querySelector<HTMLElement>('.cxc-menu-trigger')!
      const currentCard = trigger.closest<HTMLElement>('.cxc-card')!
      trigger.click()
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
      expect(currentCard.dataset.actionMenuOpen).toBe('true')
      expect(dom.window.document.querySelector<HTMLElement>('body > .cxc-menu-popup')?.dataset.cordisxAppTheme).toBe('light')
      expect(menu.querySelector('.cxc-menu-popup')).toBeNull()
      dom.window.document.querySelector<HTMLButtonElement>('[data-collection-action="share"]')!.click()
      await settle()
      expect(currentCard.hasAttribute('data-action-menu-open')).toBe(false)
      expect(dom.window.document.activeElement).toBe(dom.window.document.querySelector('[data-plugin-menu="base"] .cxc-menu-trigger'))

      dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-action="favorite"]')!.click()
      const replacementFavorite = dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-action="favorite"]')!
      expect(dom.window.localStorage.getItem('cordisx.manager.favoritePlugins.v1:work')).toBe('[]')
      expect(dom.window.document.activeElement).toBe(replacementFavorite)

      const currentPrimary = dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-id="base"]')!
      currentPrimary.click()
      expect(dom.window.document.querySelector('[data-manager-page-route^="plugin:base:"]')).not.toBeNull()
    } finally {
      dispose()
      dom.window.close()
    }
  })

  it('inspects an explicit local directory and applies the returned install candidate', async () => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://codex.local/' })
    const operations: CordisXPluginLifecycleOperationV1[] = []
    const state = snapshot()
    const model: ManagerModel = {
      snapshot: () => state,
      setPluginBlocked: async () => {}, setPermissionPolicy: async () => {}, subscribe: () => () => {},
      requestPluginLifecycle: async operation => {
        operations.push(operation)
        if (operation.kind === 'inspect-local') return result('inspect-local', 'planned', {
          operation: 'install',
          candidateId: 'candidate-local',
          package: { id: 'local', name: 'Local Plugin', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}`, dependencies: [] },
          authorizationPlan: {
            $schema: CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V1,
            schemaVersion: 1, planId: 'runtime-a:local', operation: 'install', profileId: 'work',
            identity: { source: `file:///cordisx-store/sha256/${'b'.repeat(64)}/entry.js`, pluginId: 'local' },
            defaultDecision: 'allow', declarations: [],
          },
        })
        return result('install', 'applied', { revision: 2, affectedPluginIds: ['local'] })
      },
    }
    const dispose = installCordisXManager(dom.window.document, model)
    try {
      const importButton = dom.window.document.querySelector<HTMLButtonElement>('[data-import-local-plugin]')!
      importButton.focus()
      expect(dom.window.document.activeElement).toBe(importButton)
      dom.window.document.querySelector<HTMLButtonElement>('[data-import-local-plugin]')!.click()
      const firstDialog = dom.window.document.querySelector<HTMLElement>('.cxm-local-import-dialog')!
      expect(firstDialog.getAttribute('role')).toBeNull()
      expect(firstDialog.parentElement?.getAttribute('role')).toBe('dialog')
      expect(firstDialog.parentElement?.getAttribute('aria-labelledby')).toBe('cxm-local-package-directory-heading')
      expect(firstDialog.querySelector('h2')?.id).toBe('cxm-local-package-directory-heading')
      firstDialog.querySelector<HTMLButtonElement>('[data-import-local-close]')!.click()
      await settle()
      expect(dom.window.document.querySelector('.cxm-local-import-dialog')).toBeNull()
      expect(dom.window.document.activeElement?.getAttribute('data-import-local-plugin')).toBe('true')

      dom.window.document.querySelector<HTMLButtonElement>('[data-import-local-plugin]')!.click()
      const form = dom.window.document.querySelector<HTMLFormElement>('[data-host-form="local-package-directory"]')!
      const input = form.querySelector<HTMLElement & { value: string; onChange?: (value: string) => void }>('[data-host-form-primitive="path-input"]')!
      expect(form.classList.contains('cxf-scope')).toBe(true)
      expect(form.classList.contains('cxm-local-import-form')).toBe(true)
      const dialog = dom.window.document.querySelector<HTMLElement>('.cxm-local-import-dialog')!
      expect(form.querySelector('.cxm-local-import-field > .cxf-label')?.textContent).toBe('插件目录')
      expect(input.getAttribute('aria-labelledby')).toBe('cxm-local-package-directory-label')
      expect(input.getAttribute('aria-describedby')).toContain('cxm-local-package-directory-error')
      expect(input.hasAttribute('data-import-local-path')).toBe(true)
      expect(dom.window.document.querySelector('[data-import-local-submit]')?.textContent).toBe('检查并导入')
      expect((dom.window.document.querySelector('[data-import-local-submit]') as { disabled?: boolean }).disabled).toBe(true)
      expect(dialog.querySelector('h2')?.textContent).toBe('导入本地插件')
      expect(dialog.textContent).not.toContain('选择插件目录；检查通过后再确认授权与激活。')
      expect(dialog.textContent).not.toContain('查看导入说明')
      expect(dom.window.document.querySelector('[data-import-local-choose]')).not.toBeNull()
      expect(dom.window.document.querySelector('[data-import-local-picker]')).not.toBeNull()
      expect(dom.window.document.querySelector('[data-import-local-close]')).not.toBeNull()
      expect(form.querySelector('.cxf-section')).toBeNull()
      expect(form.querySelector('.cxf-form-grid, .cxm-settings-group, .cxm-card')).toBeNull()
      expect(dialog.querySelectorAll('.cxf-actions')).toHaveLength(1)
      input.value = '/tmp/local-plugin'
      input.onChange?.(input.value)
      expect((dom.window.document.querySelector('[data-import-local-submit]') as { disabled?: boolean }).disabled).toBe(false)
      const picker = dom.window.document.querySelector<HTMLInputElement>('[data-import-local-picker]')!
      picker.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      expect(input.value).toBe('')
      expect(input.getAttribute('aria-invalid')).toBe('true')
      expect(form.querySelector('[role="alert"]')?.textContent).toContain('当前环境无法读取目录路径')
      expect((dom.window.document.querySelector('[data-import-local-submit]') as { disabled?: boolean }).disabled).toBe(true)
      expect(dom.window.document.activeElement).toBe(input)
      input.value = '/tmp/local-plugin'
      input.onChange?.(input.value)
      expect((dom.window.document.querySelector('[data-import-local-submit]') as { disabled?: boolean }).disabled).toBe(false)
      form.querySelector<HTMLElement>('t-button[type="submit"]')!.click()
      for (let attempt = 0; attempt < 20 && operations.length < 2; attempt += 1) await settle()
      expect(operations[0]).toEqual({ kind: 'inspect-local', sourceDirectory: '/tmp/local-plugin' })
      expect(operations[1]).toMatchObject({ kind: 'install', candidateId: 'candidate-local' })
    } finally {
      dispose()
      dom.window.close()
    }
  })

  it('keeps lifecycle copy out of the card and exposes an exact failed-state tooltip description', () => {
    const dom = new JSDOM('<!doctype html><html class="electron-dark"><head></head><body></body></html>', { url: 'https://codex.local/' })
    const model: ManagerModel = {
      snapshot: () => snapshot('failed'),
      setPluginBlocked: async () => {}, setPermissionPolicy: async () => {}, subscribe: () => () => {},
      requestPluginLifecycle: async operation => result(operation.kind, 'applied'),
    }
    const dispose = installCordisXManager(dom.window.document, model)
    try {
      const primary = dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-primary="base"]')!
      expect(primary.getAttribute('aria-description')).toBe('Failed to start: entry module crashed')
      expect(primary.querySelector('.cxc-status')?.getAttribute('data-tone')).toBe('danger')
      expect(primary.querySelector('.cxc-status')?.getAttribute('aria-label')).toBe('Failed to start: entry module crashed')
      expect(primary.textContent).not.toContain('Failed to start')
      expect(primary.textContent).not.toContain('entry module crashed')
    } finally {
      dispose()
      dom.window.close()
    }
  })

  it('keeps runtime status compact and moves raw failure detail into collapsed logs diagnostics', async () => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://codex.local/' })
    const model: ManagerModel = {
      snapshot: () => snapshot('failed'),
      setPluginBlocked: async () => {}, setPermissionPolicy: async () => {}, subscribe: () => () => {},
    }
    const dispose = installCordisXManager(dom.window.document, model)
    try {
      dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-id="base"]')!.click()
      await settle()
      dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="runtime"]')!.click()
      await settle()
      const overview = dom.window.document.querySelector<HTMLElement>('.cxm-runtime-overview')!
      expect(overview.querySelector('[data-plugin-runtime-status="base"]')?.textContent).toContain('Failed to start')
      expect(overview.textContent).toContain('Details are available in Logs & diagnostics.')
      expect(overview.querySelector('[data-plugin-runtime-status="base"]')?.textContent).not.toContain('entry module crashed')
      expect(overview.querySelectorAll('.cxm-runtime-status-fact')).toHaveLength(2)
      expect(overview.querySelector('.cxm-runtime-status-fact strong')?.textContent).toBe('0')
      expect(overview.querySelector('[data-plugin-runtime-diagnostics="base"]')).toBeNull()
      expect(overview.querySelector('[data-runtime-lifecycle="base"]')).toBeNull()
      dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="logs"]')!.click()
      await settle()
      const logs = dom.window.document.querySelector<HTMLElement>('[role="tabpanel"]')!
      expect(logs.querySelector('.cxm-console-summary')).toBeNull()
      expect(logs.querySelector('[data-runtime-lifecycle="base"]')).toBeNull()
      const diagnostics = logs.querySelector<HTMLDetailsElement>('[data-runtime-diagnostics="platform"]')
      expect(diagnostics?.open).toBe(false)
      expect(diagnostics?.textContent).toContain('entry module crashed')
    } finally {
      dispose()
      dom.window.close()
    }
  })

  it('exports only Host-bound console entries without flattening console argument arrays', () => {
    const page = {
      contract: 'cordisx.plugin-console-page/v1', schemaVersion: 1,
      plugin: { source: 'file:///base.ts', pluginId: 'base' }, generation: 'runtime-a', generatedAt: 1,
      partialObservability: false,
      entries: [
        {
          entryId: 'base-1', plugin: { source: 'file:///base.ts', pluginId: 'base' }, generation: 'runtime-a',
          time: 1, kind: 'console', method: 'info', source: 'console.info', message: 'first second',
          args: [{ type: 'string', preview: 'first' }, { type: 'number', preview: '2', value: 2 }], coverage: 'scoped-console',
        },
        {
          entryId: 'other-1', plugin: { source: 'file:///other.ts', pluginId: 'other' }, generation: 'runtime-a',
          time: 2, kind: 'console', method: 'warn', source: 'console.warn', message: 'foreign', args: [], coverage: 'scoped-console',
        },
      ],
    } as never
    const exported = JSON.parse(serializePluginConsoleExport(page, '2026-08-25T00:00:00.000Z')) as {
      exportedAt: string; plugin: { pluginId: string }; entries: { plugin: { pluginId: string }; args: unknown[] }[]
    }
    expect(exported).toMatchObject({ exportedAt: '2026-08-25T00:00:00.000Z', plugin: { pluginId: 'base' } })
    expect(exported.entries).toHaveLength(1)
    expect(exported.entries[0]?.plugin.pluginId).toBe('base')
    expect(exported.entries[0]?.args).toEqual([{ type: 'string', preview: 'first' }, { type: 'number', preview: '2', value: 2 }])
  })

  it('keeps the Host-owned more menu actionable, keyboard accessible, and closed across every manager lifecycle boundary', async () => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://codex.local/' })
    const listeners = new Set<() => void>()
    const state = snapshot()
    const copied: string[] = []
    const opened: string[] = []
    Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async (value: string) => { copied.push(value) } }, configurable: true })
    Object.defineProperty(dom.window, 'open', { value: (url: string) => { opened.push(url); return null }, configurable: true })
    const model: ManagerModel = {
      snapshot: () => state,
      setPluginBlocked: async () => {}, setPermissionPolicy: async () => {},
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
      requestPluginLifecycle: async operation => result(operation.kind, 'applied'),
    }
    const dispose = installCordisXManager(dom.window.document, model)
    const menuTrigger = (): HTMLButtonElement => dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-menu="base"] .cxc-menu-trigger')!
    const popup = (): HTMLElement => dom.window.document.querySelector<HTMLElement>('body > .cxc-menu-popup')!
    try {
      dom.window.document.querySelector<HTMLElement>('[data-cordisx-manager-modal]')!.hidden = false
      await settle()
      const primary = dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-primary="base"]')!
      menuTrigger().click()
      expect(menuTrigger().getAttribute('aria-expanded')).toBe('true')
      expect(menuTrigger().getAttribute('aria-controls')).toContain('cxc-menu-plugins-base')
      expect(popup().getAttribute('role')).toBe('menu')
      expect(popup().querySelector('[data-collection-action="share"] [data-host-icon-key="share-plugin"]')).not.toBeNull()
      expect(popup().querySelector('[data-collection-action="source"] [data-host-icon-key="authors-source"]')).not.toBeNull()
      expect(popup().querySelector('[data-collection-action="diagnostics"] [data-host-icon-key="diagnostics"]')).not.toBeNull()
      expect(popup().querySelector('[data-collection-action="uninstall"] [data-host-icon-key="uninstall-plugin"]')).not.toBeNull()

      popup().querySelector<HTMLButtonElement>('[data-collection-action="share"]')!.click()
      await settle()
      expect(copied).toEqual(['https://plugins.example/base'])
      expect(dom.window.document.querySelector('body > .cxc-menu-popup')).toBeNull()
      expect(dom.window.document.activeElement === menuTrigger()).toBe(true)
      expect(dom.window.document.querySelector('[data-manager-page-route="primary:plugins"]')).not.toBeNull()

      menuTrigger().click()
      menuTrigger().click()
      expect(dom.window.document.querySelector('body > .cxc-menu-popup')).toBeNull()
      await settle()
      expect(dom.window.document.activeElement === menuTrigger()).toBe(true)

      menuTrigger().click()
      dom.window.document.body.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }))
      expect(dom.window.document.querySelector('body > .cxc-menu-popup')).toBeNull()
      await settle()
      expect(dom.window.document.querySelector('[data-manager-page-route="primary:plugins"]')).not.toBeNull()

      menuTrigger().click()
      popup().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      expect(popup().contains(dom.window.document.activeElement)).toBe(true)
      popup().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }))
      expect(dom.window.document.activeElement === [...popup().querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')].at(-1)).toBe(true)
      popup().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      expect(dom.window.document.querySelector('body > .cxc-menu-popup')).toBeNull()
      await settle()
      expect(dom.window.document.activeElement === menuTrigger()).toBe(true)

      menuTrigger().click()
      popup().querySelector<HTMLButtonElement>('[data-collection-action="source"]')!.click()
      expect(opened).toEqual(['https://plugins.example/base'])
      expect(dom.window.document.querySelector('[data-cordisx-manager-modal]')?.hidden).toBe(false)
      expect(dom.window.document.querySelector('body > .cxc-menu-popup')).toBeNull()
      await settle()
      expect(dom.window.document.activeElement === menuTrigger()).toBe(true)

      // A runtime reconciliation closes the portal cleanly without navigating the card.
      menuTrigger().click()
      for (const listener of listeners) listener()
      expect(dom.window.document.querySelector('body > .cxc-menu-popup')).toBeNull()

      menuTrigger().click()
      const card = dom.window.document.querySelector<HTMLElement>('[data-plugin-card="base"]')!
      card.remove()
      dom.window.dispatchEvent(new dom.window.Event('resize'))
      await settle()
      expect(dom.window.document.querySelector('body > .cxc-menu-popup')).toBeNull()
      for (const listener of listeners) listener()

      menuTrigger().click()
      dom.window.dispatchEvent(new dom.window.Event('resize'))
      dom.window.dispatchEvent(new dom.window.Event('scroll'))
      expect(dom.window.document.querySelector('body > .cxc-menu-popup')).not.toBeNull()
      dom.window.document.querySelector<HTMLButtonElement>('.cxm-close')!.click()
      expect(dom.window.document.querySelector('body > .cxc-menu-popup')).toBeNull()
      expect(dom.window.document.querySelector<HTMLElement>('[data-cordisx-manager-modal]')!.hidden).toBe(true)
      dom.window.document.querySelector<HTMLElement>('[data-cordisx-manager-modal]')!.hidden = false
      for (const listener of listeners) listener()

      menuTrigger().click()
      popup().querySelector<HTMLButtonElement>('[data-collection-action="diagnostics"]')!.click()
      await settle()
      expect(dom.window.document.querySelector('[data-manager-page-route="plugin:base:logs"]')).not.toBeNull()
      expect(dom.window.document.querySelector('[data-plugin-card="base"]')).toBeNull()
      expect(primary.isConnected).toBe(false)
    } finally {
      dispose()
      expect(dom.window.document.querySelector('body > .cxc-menu-popup')).toBeNull()
      dom.window.close()
    }
  })

  it('hides unavailable package operations without exposing implementation details', () => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://codex.local/' })
    const state = snapshot()
    state.plugins[0] = { ...state.plugins[0]!, package: undefined }
    state.pluginLifecycle = { ...state.pluginLifecycle!, operationsAvailable: false }
    const model: ManagerModel = {
      snapshot: () => state,
      setPluginBlocked: async () => {}, setPermissionPolicy: async () => {}, subscribe: () => () => {},
    }
    const dispose = installCordisXManager(dom.window.document, model)
    try {
      dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-menu="base"] .cxc-menu-trigger')!.click()
      const popup = dom.window.document.querySelector<HTMLElement>('body > .cxc-menu-popup')!
      for (const action of ['share', 'source', 'uninstall'] as const) {
        expect(popup.querySelector(`[data-collection-action="${action}"]`)).toBeNull()
      }
      expect(popup.querySelector<HTMLButtonElement>('[data-collection-action="diagnostics"]')!.disabled).toBe(false)
    } finally {
      dispose()
      dom.window.close()
    }
  })
})
