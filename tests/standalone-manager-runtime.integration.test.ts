import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { defaultUiPlaygroundConfig } from '../packages/cli/src/playground/defaults.js'
import { exactDomPermissionPolicies, installPermissionPolicyBridge } from './helpers/dom-permission.js'

it('does not expose the isolated presentation as a production attachment', async () => {
  const config = await loadConfig(defaultUiPlaygroundConfig, { profileId: 'playground' })
  await expect(buildRendererBundle({ ...config, plugins: [] }, { managerPresentationMode: 'standalone' }))
    .rejects.toThrow('not yet available outside the isolated UI Playground')
})

it('mounts the existing Manager and an actual registered plugin page without a native application seat', async () => {
  const config = await loadConfig(defaultUiPlaygroundConfig, { profileId: 'playground' })
  const plugin = config.plugins.find(item => item.id === 'settings-tab-demo')!
  const permissionPolicies = exactDomPermissionPolicies('playground', [{
    id: plugin.id,
    entry: plugin.entry,
    pointIds: ['manager.settings.navigation-items', 'manager.content'],
  }])
  const bundle = await buildRendererBundle({ ...config, plugins: [plugin] }, {
    playground: true,
    managerPresentationMode: 'standalone',
    generation: 'standalone-manager-test',
    profileId: 'playground',
    permission: { profileId: 'playground', bridgeToken: '5'.repeat(64), policies: permissionPolicies },
  })
  const dom = new JSDOM('<!doctype html><html lang="en"><head></head><body></body></html>', {
    runScripts: 'dangerously',
    url: 'http://127.0.0.1/',
  })
  try {
    Object.defineProperty(dom.window, 'structuredClone', { configurable: true, value: structuredClone })
    Object.assign(dom.window, { TextEncoder, TextDecoder })
    installPermissionPolicyBridge(dom.window)
    dom.window.eval(bundle)
    const doc = dom.window.document
    await vi.waitFor(() => expect(doc.documentElement.dataset.cordisxReady).toBe('true'), { timeout: 10_000 })
    const root = doc.querySelector<HTMLElement>('[data-manager-surface="standalone"]')!
    expect(root.querySelector('[data-unified-plugins-page="true"]')).not.toBeNull()
    expect(root.querySelector('[data-cordisx-manager-trigger]')).toBeNull()
    const runtime = (dom.window as unknown as {
      __cordisxRuntime: {
        pluginRegistryEpoch(): number
        snapshot(): { navigation: { outlets: readonly { id: string; available: boolean }[] } }
        dispose(): Promise<void>
      }
    }).__cordisxRuntime
    const outlets = runtime.snapshot().navigation.outlets
    expect(runtime.pluginRegistryEpoch()).toBe(0)
    for (const id of ['app', 'main', 'session.content']) {
      expect(outlets.find(outlet => outlet.id === id)).toMatchObject({ id, available: false })
    }
    const navigation = root.querySelector<HTMLButtonElement>(
      '[data-settings-navigation-item="settings-tab-demo:navigation"]',
    )!
    expect(navigation).not.toBeNull()
    expect(navigation.disabled).toBe(false)
    navigation.click()
    await vi.waitFor(() =>
      expect(root.querySelector('[data-settings-navigation-demo-content="mounted"]')).not.toBeNull()
    )
    expect(root.querySelector('[data-settings-navigation-demo-route]')?.textContent).toContain(
      'settings-tab-demo:navigation',
    )
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }))
    expect(root.querySelector('[data-settings-navigation-demo-content="mounted"]')).not.toBeNull()
    await runtime.dispose()
    expect(doc.querySelector('[data-manager-surface="standalone"]')).toBeNull()
    expect(doc.getElementById('cordisx-react-manager-style')).toBeNull()
  } finally {
    dom.window.close()
  }
}, 30_000)
