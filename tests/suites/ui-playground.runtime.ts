import { JSDOM } from 'jsdom'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { buildRendererBundle } from '../../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../../packages/cli/src/launcher/config.js'
import { defaultUiPlaygroundConfig } from '../../packages/cli/src/playground/defaults.js'
import { exactDomPermissionPolicies, installPermissionPolicyBridge } from '../helpers/dom-permission.js'
import { CORDISX_CAPABILITY_CATALOG_VERSION } from '../../packages/cli/src/capability-risk-catalog.js'
import { CORDISX_PERMISSION_POLICY_SCHEMA_V2 } from '../../packages/cli/src/permission-contracts.js'
import { permissionSecurityFingerprint } from '../../packages/cli/src/permission-model-v2.js'
import { defaultPluginIds } from './ui-playground.fixtures.js'

export function registerRuntimeTests() {
  it(
    'boots, reloads, and disposes the comprehensive real plugin runtime with explicit Playground seats only',
    async () => {
      const config = await loadConfig(defaultUiPlaygroundConfig, { profileId: 'playground' })
      expect(config.plugins.map(plugin => plugin.id)).toEqual(defaultPluginIds)
      const pointIdsByPlugin = new Map<string, readonly string[]>([
        ['slot-showcase', [
          'app',
          'main',
          'session.content',
          'sidebar.footer.before-control',
          'sidebar.footer.after-control',
          'sidebar.footer.menu',
          'sidebar.account.menu',
          'sidebar.navigation.items',
          'workspace.toolbar.items',
          'session.header.actions',
          'composer.toolbar.items',
          'environment.panel.header-actions',
          'environment.panel.sections',
          'environment.section.actions',
          'environment.section.rows',
          'environment.row.trailing-actions',
        ]],
        ['hello-toolbar', ['workspace.toolbar.items']],
        ['settings-tab-demo', ['manager.settings.navigation-items', 'manager.content']],
        ['channel', ['manager.settings.navigation-items', 'manager.content']],
        ['cli-proxy-api', ['sidebar.navigation.items', 'main']],
      ])
      const domPermissionPolicies = exactDomPermissionPolicies(
        'playground',
        config.plugins.flatMap(plugin => {
          const pointIds = pointIdsByPlugin.get(plugin.id)
          return pointIds === undefined ? [] : [{ id: plugin.id, entry: plugin.entry, pointIds }]
        }),
      )
      const channel = config.plugins.find(plugin => plugin.id === 'channel')!
      const accountRead = {
        name: 'channel.accounts.read' as const,
        required: true,
        scope: {},
      }
      const permissionPolicies = [...domPermissionPolicies, {
        $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V2,
        schemaVersion: 2 as const,
        key: {
          profileId: 'playground',
          identity: { source: pathToFileURL(channel.entry).href, pluginId: channel.id },
          capability: accountRead.name,
          scope: accountRead.scope,
          securityFingerprint: permissionSecurityFingerprint(CORDISX_CAPABILITY_CATALOG_VERSION, accountRead),
        },
        policy: 'allow-persistent' as const,
      }]
      const bundle = await buildRendererBundle(config, {
        playground: true,
        generation: 'playground-test-1',
        profileId: 'playground',
        permission: { profileId: 'playground', bridgeToken: '5'.repeat(64), policies: permissionPolicies },
      })
      const dom = new JSDOM(
        `<!doctype html><html data-theme="dark"><head></head><body>
      <aside>
        <nav data-cordisx-playground-surface="sidebar.navigation.items"></nav>
        <footer><span data-cordisx-playground-surface="sidebar.footer.before-control"></span><button data-cordisx-playground-template="sidebar.footer">Tools</button><span data-cordisx-playground-surface="sidebar.footer.after-control"></span></footer>
        <button data-cordisx-playground-manager-trigger>Manager</button>
      </aside>
      <main data-cordisx-playground-session-id="fixture-session">
        <header data-cordisx-playground-surface="session.header.actions"><button data-cordisx-playground-template="session.header">Session</button></header>
        <div data-cordisx-playground-surface="composer.toolbar.items"><button data-cordisx-playground-template="composer.toolbar">Composer</button></div>
        <input data-cordisx-playground-reasoning type="range" min="0" max="4" value="2">
      </main>
      <main data-cordisx-playground-seat="app"></main><main data-cordisx-playground-seat="main"></main><main data-cordisx-playground-seat="session.content"></main>
    </body></html>`,
        { runScripts: 'dangerously', url: 'http://127.0.0.1/' },
      )
      try {
        Object.defineProperty(dom.window, 'structuredClone', { configurable: true, value: structuredClone })
        installPermissionPolicyBridge(dom.window)
        dom.window.eval(bundle)
        for (
          let attempt = 0;
          attempt < 100 && dom.window.document.documentElement.dataset.cordisxReady !== 'true';
          attempt += 1
        ) {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        const runtime = dom.window as unknown as {
          __cordisxRuntime?: {
            snapshot(): {
              plugins: readonly { id: string; name: string; description?: string; icon?: string; status: string }[]
              platform: { mode: string }
              navigation: { outlets: readonly { id: string; activeRoute?: string; presentation: string }[] }
            }
            dispose(): Promise<void>
          }
        }
        expect(dom.window.document.documentElement.dataset.cordisxReady).toBe('true')
        expect(runtime.__cordisxRuntime?.snapshot().plugins.map(plugin => ({ id: plugin.id, status: plugin.status })))
          .toEqual(defaultPluginIds.map(id => ({ id, status: 'active' })))
        expect(runtime.__cordisxRuntime?.snapshot().plugins.map(plugin => plugin.name)).toEqual([
          'Slot Showcase',
          'Hello Toolbar',
          'Form Schema Gallery',
          'Settings Navigation Demo',
          'Plugin Console Showcase',
          'Channels',
          'CLIProxy Providers',
        ])
        dom.window.document.documentElement.lang = 'zh-CN'
        await new Promise(resolve => setTimeout(resolve, 0))
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(runtime.__cordisxRuntime?.snapshot().plugins.map(plugin => plugin.name)).toEqual([
          '点位展示',
          '工具栏问候',
          '表单结构展示',
          '设置导航演示',
          '插件控制台展示',
          '渠道',
          'CLIProxy 提供方',
        ])
        expect(runtime.__cordisxRuntime?.snapshot().plugins.find(plugin => plugin.id === 'channel')?.description)
          .toBe('管理渠道连接与会话。')
        expect(runtime.__cordisxRuntime?.snapshot().plugins.find(plugin => plugin.id === 'cli-proxy-api')?.icon)
          .toMatch(/^data:image\/png;base64,/)
        expect(runtime.__cordisxRuntime?.snapshot().platform.mode).toBe('unavailable')
        for (
          let attempt = 0;
          attempt < 100
          && dom.window.document.querySelector(
              '[data-cordisx-playground-surface="sidebar.navigation.items"] [data-cordisx-surface-host]',
            ) === null;
          attempt += 1
        ) {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        expect(
          dom.window.document.querySelector(
            '[data-cordisx-playground-surface="sidebar.navigation.items"] [data-cordisx-surface-host]',
          ),
        ).not.toBeNull()
        expect(
          dom.window.document.querySelector(
            '[data-cordisx-playground-surface="session.header.actions"] [data-cordisx-surface-host]',
          ),
        ).not.toBeNull()
        expect(
          dom.window.document.querySelector(
            '[data-cordisx-playground-surface="composer.toolbar.items"] [data-cordisx-surface-host]',
          ),
        ).not.toBeNull()
        const showcaseNavigation = [
          ...dom.window.document.querySelectorAll<HTMLButtonElement>(
            '[data-cordisx-playground-surface="sidebar.navigation.items"] .cordisx-nav-primary',
          ),
        ]
          .find(button => button.textContent?.includes('结构化 UI 演示'))
        expect(showcaseNavigation).toBeDefined()
        expect(showcaseNavigation?.closest('[data-sidebar-item]')).not.toBeNull()
        showcaseNavigation?.click()
        for (
          let attempt = 0;
          attempt < 100
          && runtime.__cordisxRuntime?.snapshot().navigation.outlets.find(item => item.id === 'main')?.activeRoute
            !== 'slot-showcase:main.analytics';
          attempt += 1
        ) {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        expect(runtime.__cordisxRuntime?.snapshot().navigation.outlets.find(item => item.id === 'main')).toMatchObject({
          activeRoute: 'slot-showcase:main.analytics',
          presentation: 'presented',
        })
        expect(dom.window.document.querySelector('[data-cordisx-page-outlet="main"]')?.hidden).toBe(false)
        const publicSnapshotJson = JSON.stringify(runtime.__cordisxRuntime?.snapshot())
        expect(publicSnapshotJson).not.toContain('extensionPointControls')
        expect(publicSnapshotJson).not.toContain('principalHandle')
        expect(publicSnapshotJson).not.toContain('principal:')
        const trigger = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!
        const reactManager = dom.window.document.querySelector('[data-cordisx-react-manager="true"]')
        expect(reactManager).not.toBeNull()
        const managerStyles = dom.window.document.getElementById('cordisx-react-manager-style')?.textContent ?? ''
        expect(managerStyles).toContain('.t-input {')
        expect(managerStyles).toContain('.t-textarea__inner {')
        expect(managerStyles).toContain('.cxr-root { position: relative; z-index: 2147483500;')
        expect(managerStyles).toContain('.cxr-root :is(.t-popup,.t-dialog__ctx) { z-index: 2147483600 !important; }')
        expect(managerStyles).toContain('.cxr-backdrop { position: fixed; inset: 0; z-index: 2147483500;')
        expect(managerStyles).toContain('.cxr-tabs { display: flex; min-height: 38px; flex: none;')
        expect(managerStyles).toContain(
          '.cxr-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(260px, 100%), 1fr));',
        )
        expect(managerStyles).toContain('.cxr-plugin-actions { position: absolute; top: 50%;')
        expect(managerStyles).toContain('transform: translateY(-50%);')
        expect(managerStyles).toContain(
          '.cxf-form-body { display: grid; min-width: 0; align-content: start; grid-auto-rows: max-content;',
        )
        expect(managerStyles).toContain(
          '.cxf-item[data-control-layout="compact"] .cxf-control-seat { width: auto; max-width: 100%; justify-self: end; }',
        )
        expect(managerStyles).not.toContain('.cxf-control-seat { width: auto; max-width: 100%; padding-right: 10px;')
        expect(managerStyles).toContain(
          '.cxf-form-page-stack, .cxf-form-page-root, .cxf-form-page-layer, .cxf-form-subpage { display: flex;',
        )
        expect(managerStyles).toContain('.cxf-form-subpage-header { display: grid;')
        expect(managerStyles).toContain(
          '.cxf-form-subpage-body { min-width: 0; min-height: 0; flex: 1; overflow: auto;',
        )
        expect(managerStyles).toContain('.cxf-array-item-fields { gap: 0; }')
        expect(managerStyles).not.toContain('.cxf-array-dialog-control')
        expect(managerStyles).toContain('.cxr-page[data-plugin-detail]:has(> .cxr-plugin-config-panel)')
        expect(managerStyles).toContain(
          '.cxr-plugin-config-panel > .cxf-react-form-shell { display: flex; min-width: 0; min-height: 0; flex: 1; flex-direction: column; overflow: hidden; }',
        )
        expect(managerStyles).not.toContain('.cxr-page[data-plugin-detail] { display: flex;')
        expect(trigger.closest('.cxr-trigger-seat')?.previousElementSibling).toBe(
          dom.window.document.querySelector('[data-cordisx-playground-manager-trigger]'),
        )
        expect(trigger.closest('[data-sidebar-item="host.manager"]')?.querySelector('.cxsi-brand-mark img')).not
          .toBeNull()
        expect(trigger.classList.contains('cxsi-primary')).toBe(true)
        expect(trigger.querySelector('svg')).toBeNull()
        trigger.click()
        expect(dom.window.document.querySelector<HTMLElement>('[data-cordisx-manager-modal]')).not.toBeNull()
        expect(
          dom.window.document.querySelector<HTMLImageElement>('[data-plugin-id="cli-proxy-api"] .cxr-card-icon img')
            ?.src,
        )
          .toMatch(/^data:image\/png;base64,/)
        const internalAccents = new Map([
          ['slot-showcase', 'spectral'],
          ['hello-toolbar', 'solar'],
          ['form-schema-gallery', 'violet'],
          ['settings-tab-demo', 'polar'],
          ['console-showcase', 'ember'],
          ['channel', 'jade'],
        ])
        const gradientPhases = new Set<string>()
        for (const [pluginId, accent] of internalAccents) {
          const internalBadge = dom.window.document.querySelector(
            `[data-plugin-id="${pluginId}"] [data-internal-plugin-badge="${pluginId}"]`,
          )
          expect(internalBadge?.getAttribute('data-accent')).toBe(accent)
          expect(internalBadge?.getAttribute('data-brand-geometry')).toBe('official-1440-segments')
          expect(internalBadge?.getAttribute('data-gradient-mode')).toBe('segment-depth')
          expect(internalBadge?.getAttribute('data-gradient-phase')).toMatch(/^\d+$/)
          gradientPhases.add(internalBadge?.getAttribute('data-gradient-phase') ?? '')
          const derivedMarks = internalBadge?.querySelectorAll<HTMLImageElement>('img') ?? []
          expect(derivedMarks).toHaveLength(2)
          for (const mark of derivedMarks) expect(mark.src).toMatch(/^data:image\/svg\+xml;charset=utf-8,/)
          expect(internalBadge?.textContent).toBe('')
        }
        expect(gradientPhases.size).toBe(internalAccents.size)
        dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-id="form-schema-gallery"]')?.click()
        await new Promise(resolve => setTimeout(resolve, 0))
        dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="config"]')?.click()
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(dom.window.document.querySelector('.cxf-array-row-summary')?.tagName).toBe('SPAN')
        const configFormState = () =>
          dom.window.document.querySelector<HTMLElement>('[data-plugin-config-form="form-schema-gallery"]')?.dataset
            .state
        const notificationRows = () =>
          dom.window.document.querySelectorAll('[data-config-path="notificationRules"] .cxf-array-row').length
        const visibleArrayDialog = () =>
          [...dom.window.document.querySelectorAll<HTMLElement>('.t-dialog__ctx')]
            .find(dialog =>
              dom.window.getComputedStyle(dialog).display !== 'none'
              && dialog.querySelector('.cxf-array-item-dialog') !== null
            )
        const visibleArrayPage = () =>
          dom.window.document.querySelector<HTMLElement>(
            '[data-plugin-config-form="form-schema-gallery"] .cxf-form-page-layer:not([hidden])',
          )
        const initialNotificationRows = notificationRows()
        expect(configFormState()).toBe('pristine')
        const notificationAdd = dom.window.document.querySelector<HTMLButtonElement>(
          '[data-config-path="notificationRules"] [data-array-action="add"]',
        )
        notificationAdd?.click()
        await new Promise(resolve => setTimeout(resolve, 10))
        let createPage = visibleArrayPage()
        expect(createPage?.textContent).toContain('创建数组项')
        expect(visibleArrayDialog()).toBeUndefined()
        expect(createPage?.querySelector('.cxf-form-subpage-header .cxr-breadcrumbs')?.textContent).toContain(
          '通知规则/创建数组项',
        )
        expect(createPage?.querySelector('.cxr-breadcrumbs [aria-current="page"]')?.textContent).toBe('创建数组项')
        expect(
          dom.window.document.querySelector<HTMLElement>(
            '[data-plugin-config-form="form-schema-gallery"] .cxf-form-page-root',
          )?.hidden,
        ).toBe(true)
        expect(
          dom.window.document.querySelector('[data-plugin-config-form="form-schema-gallery"]')?.querySelectorAll(
            'form',
          ),
        ).toHaveLength(1)
        const pageFieldRows = [
          ...createPage!.querySelectorAll<HTMLElement>('.cxf-array-item-fields.cxf-form-grid > .cxf-item'),
        ]
        expect(pageFieldRows.map(row => row.dataset.hostFormPrimitive)).toEqual(['input', 'checkbox'])
        for (const row of pageFieldRows) {
          const label = row.querySelector<HTMLElement>(':scope > .cxf-label-row')
          const control = row.querySelector<HTMLElement>(':scope > .cxf-control-seat')
          expect(label).not.toBeNull()
          expect(control?.getAttribute('aria-labelledby')).toBe(label?.id)
          expect(row.querySelector(':scope > .cxf-error')).not.toBeNull()
        }
        expect(
          createPage?.querySelector(
            '.cxf-array-item-fields > [data-host-form-primitive="checkbox"][data-control-layout="compact"]',
          ),
        ).not.toBeNull()
        expect(createPage?.querySelector<HTMLInputElement>('.cxf-array-item-fields input[type="checkbox"]')?.checked)
          .toBe(true)
        expect(createPage?.querySelector('[data-host-form-action="field-actions"]')).toBeNull()
        expect(createPage?.querySelector('.cxf-array-dialog-field, .cxf-array-dialog-control')).toBeNull()
        expect(
          [...createPage!.querySelectorAll<HTMLButtonElement>('.cxf-form-subpage-actions button')].find(button =>
            button.textContent?.trim() === '创建'
          )?.disabled,
        ).toBe(true)
        expect(createPage?.textContent).toContain('此项为必填项')
        const invalidDestinationInput = createPage?.querySelector<HTMLInputElement>(
          '.cxf-array-item-fields input[type="text"]',
        )
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(
          invalidDestinationInput,
          'x',
        )
        invalidDestinationInput?.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(createPage?.textContent).toContain('请输入符合长度要求的文本')
        expect(
          [...createPage!.querySelectorAll<HTMLButtonElement>('.cxf-form-subpage-actions button')].find(button =>
            button.textContent?.trim() === '创建'
          )?.disabled,
        ).toBe(true)
        const firstCreateFieldPath = pageFieldRows[0]?.dataset.configPath
        expect(firstCreateFieldPath).toBeTruthy()
        expect(notificationRows()).toBe(initialNotificationRows)
        expect(configFormState()).toBe('pristine')
        ;[...createPage!.querySelectorAll<HTMLButtonElement>('button')].find(button =>
          button.textContent?.trim() === '取消'
        )?.click()
        await new Promise(resolve => setTimeout(resolve, 10))
        expect(notificationRows()).toBe(initialNotificationRows)
        expect(configFormState()).toBe('pristine')
        expect(visibleArrayPage()).toBeNull()
        expect(notificationAdd).toBe(dom.window.document.activeElement)
        dom.window.document.querySelector<HTMLButtonElement>(
          '[data-config-path="notificationRules"] [data-array-action="add"]',
        )?.click()
        await new Promise(resolve => setTimeout(resolve, 10))
        createPage = visibleArrayPage()
        expect(createPage?.querySelector<HTMLElement>('.cxf-array-item-fields > .cxf-item')?.dataset.configPath).not
          .toBe(firstCreateFieldPath)
        const destinationInput = createPage?.querySelector<HTMLInputElement>(
          '.cxf-array-item-fields input[type="text"]',
        )
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(
          destinationInput,
          'Created after confirm',
        )
        destinationInput?.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(
          [...createPage!.querySelectorAll<HTMLButtonElement>('.cxf-form-subpage-actions button')].find(button =>
            button.textContent?.trim() === '创建'
          )?.disabled,
        ).toBe(false)
        ;[...createPage!.querySelectorAll<HTMLButtonElement>('button')].find(button =>
          button.textContent?.trim() === '创建'
        )?.click()
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(notificationRows()).toBe(initialNotificationRows + 1)
        expect(configFormState()).toBe('dirty')
        const createdRow = [
          ...dom.window.document.querySelectorAll<HTMLElement>('[data-config-path="notificationRules"] .cxf-array-row'),
        ].at(-1)
        const createdRowId = createdRow?.dataset.hostArrayItemId
        expect(createdRowId).toBeTruthy()
        createdRow?.querySelector<HTMLButtonElement>('.cxf-array-row-actions button[aria-label="编辑条目"]')?.click()
        let arrayPage: HTMLElement | null = null
        for (let attempt = 0; attempt < 10 && arrayPage === null; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 10))
          arrayPage = visibleArrayPage()
        }
        expect(arrayPage).not.toBeNull()
        expect(arrayPage?.querySelector('.cxf-array-item-fields > .cxf-item')?.getAttribute('data-config-path'))
          .toContain(createdRowId)
        expect(arrayPage?.querySelector('.cxr-breadcrumbs [aria-current="page"]')?.textContent).toBe('编辑第 2 项')
        ;[...arrayPage!.querySelectorAll<HTMLButtonElement>('.cxr-breadcrumbs button')].find(button =>
          button.textContent?.trim() === '通知规则'
        )?.click()
        await new Promise(resolve => setTimeout(resolve, 0))
        const firstNotificationRow = dom.window.document.querySelector<HTMLElement>(
          '[data-config-path="notificationRules"] .cxf-array-row',
        )
        firstNotificationRow?.querySelector<HTMLButtonElement>('button[aria-label="删除条目"]')?.click()
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(notificationRows()).toBe(1)
        expect(
          dom.window.document.querySelector<HTMLElement>('[data-config-path="notificationRules"] .cxf-array-row')
            ?.dataset.hostArrayItemId,
        ).toBe(createdRowId)
        ;[...dom.window.document.querySelectorAll<HTMLButtonElement>('.cxf-form-action-buttons button')].find(button =>
          button.textContent?.includes('重置')
        )?.click()
        await new Promise(resolve => setTimeout(resolve, 10))
        expect(configFormState()).toBe('pristine')
        expect(notificationRows()).toBe(initialNotificationRows)
        expect(
          dom.window.document.querySelector<HTMLElement>('[data-config-path="notificationRules"] .cxf-array-row')
            ?.dataset.hostArrayItemId,
        ).not.toBe(createdRowId)
        dom.window.document.querySelector<HTMLButtonElement>('.cxr-breadcrumbs button')?.click()
        await new Promise(resolve => setTimeout(resolve, 0))
        for (const [index, id] of defaultPluginIds.entries()) {
          dom.window.document.querySelector<HTMLButtonElement>(`[data-plugin-id="${id}"]`)?.click()
          await new Promise(resolve => setTimeout(resolve, 0))
          expect(dom.window.document.querySelector('[data-plugin-detail]')?.getAttribute('data-plugin-detail')).toBe(id)
          expect(dom.window.document.querySelectorAll('[data-plugin-detail-tab]')).toHaveLength(7)
          if (index < defaultPluginIds.length - 1) {
            dom.window.document.querySelector<HTMLButtonElement>('.cxr-breadcrumbs button')?.click()
            await new Promise(resolve => setTimeout(resolve, 0))
          }
        }
        const firstRuntime = runtime.__cordisxRuntime!
        let disposed = false
        const dispose = firstRuntime.dispose.bind(firstRuntime)
        firstRuntime.dispose = async () => {
          disposed = true
          await dispose()
        }
        const reload = await buildRendererBundle(config, {
          playground: true,
          generation: 'playground-test-2',
          profileId: 'playground',
          permission: { profileId: 'playground', bridgeToken: '5'.repeat(64), policies: permissionPolicies },
        })
        dom.window.eval(reload)
        for (let attempt = 0; attempt < 100 && runtime.__cordisxRuntime === firstRuntime; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        expect(disposed).toBe(true)
        expect(runtime.__cordisxRuntime?.snapshot().plugins.map(plugin => ({ id: plugin.id, status: plugin.status })))
          .toEqual(defaultPluginIds.map(id => ({ id, status: 'active' })))
        expect(dom.window.document.querySelector('[data-plugin-detail]')?.getAttribute('data-plugin-detail')).toBe(
          'cli-proxy-api',
        )
        expect(dom.window.document.querySelectorAll('[data-plugin-detail-tab]')).toHaveLength(7)
        await runtime.__cordisxRuntime?.dispose()
        await new Promise(resolve => setTimeout(resolve, 200))
      } finally {
        await (dom.window as unknown as { __cordisxRuntime?: { dispose(): Promise<void> } }).__cordisxRuntime?.dispose()
        await new Promise(resolve => setTimeout(resolve, 0))
        dom.window.close()
      }
    },
    60_000,
  )
}
