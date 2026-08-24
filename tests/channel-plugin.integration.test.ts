import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { manifest } from '../packages/cli/src/plugins/channel/index.js'
import {
  CordisXChannelManagerService,
  type ChannelManagerProjectionV1,
} from '../packages/cli/src/renderer/channel-manager.js'

interface RuntimeHandle {
  snapshot(): {
    plugins: readonly { id: string; status: string; configuration: { schemaKind: string; fields: readonly unknown[] } }[]
    registrations: readonly { owner: string; surface: string; qualifiedId: string; valid: boolean; pending: boolean }[]
    navigation: {
      routes: readonly { qualifiedId: string; valid: boolean; productMetadata: { title?: string; diagnostics: readonly unknown[] } }[]
      pages: readonly { qualifiedId: string; metadata: { chrome?: string }; productMetadata: { title?: string; diagnostics: readonly unknown[] } }[]
      outlets: readonly { id: string; available: boolean; mounted: boolean; activeRoute?: string }[]
    }
  }
  dispose(): Promise<void>
}

async function waitFor(predicate: () => boolean, attempts = 80): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition did not settle')
}

const projection: ChannelManagerProjectionV1 = {
  contract: 'cordisx.channel-manager-projection/v1',
  schemaVersion: 1,
  status: 'experimental',
  service: { configurationKind: 'host', configApplies: 'service-restart', revision: 4, lastGoodRevision: 4, writable: false },
  connections: [{
    ref: { adapterId: 'simulator', accountId: 'local', tenantId: 'test' },
    adapterKind: 'simulator', enabled: true, transportMode: 'simulator', secretState: 'unavailable',
  }],
  routes: [{
    id: 'default',
    connection: { adapterId: 'simulator', accountId: 'local', tenantId: 'test' },
    enabled: true, workspaceAlias: 'cordisx', provider: 'codex', model: 'default', profile: 'work',
    notifications: ['completion', 'failure'],
  }],
  accounts: [{
    ref: { adapterId: 'simulator', accountId: 'local', tenantId: 'test' },
    adapterKind: 'simulator', enabled: true, transportMode: 'simulator', secretState: 'unavailable',
    implementationStatus: 'verified', connectionState: 'ready', generation: 3,
    inbound: { pending: 0, retrying: 0, deadLetter: 0 }, outbound: { pending: 1, retrying: 0, deadLetter: 0 },
  }],
  bindings: [{
    bindingId: 'binding-1',
    channel: {
      adapterId: 'simulator', accountId: 'local', tenantId: 'test', conversationId: 'direct-alice', threadId: 'direct-alice',
    },
    session: { providerId: 'codex', remoteSessionId: 'same-id-safe-by-provider' },
    routeId: 'default', state: 'active',
  }],
  diagnostics: [{ id: 'simulator', status: 'verified', message: 'Local simulator verified without an external account.' }],
}

describe('built-in Channel product bundle', () => {
  it('rejects unknown or secret-bearing Manager projection fields before renderer publication', () => {
    const unsafe = structuredClone(projection) as unknown as Record<string, unknown>
    unsafe.secretRef = 'keychain:must-not-enter-renderer'
    expect(() => new CordisXChannelManagerService(new Context(), unsafe as unknown as ChannelManagerProjectionV1))
      .toThrow('secretRef is not renderer-safe')
  })

  it('declares the Host service schema and projects the structured Manager B data plane', async () => {
    expect(manifest).toMatchObject({
      schemaVersion: 4,
      id: 'channel',
      services: [{
        id: 'runtime', kind: 'channel-adapter', entry: './service.mjs',
        configuration: { kind: 'host', configApplies: 'restart' },
      }],
    })
    expect(manifest.capabilities.some(item => item.name === 'channel.messages.send' && !item.required)).toBe(true)

    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const entry = path.join(root, 'packages/cli/src/plugins/channel/index.ts')
    const bundle = await buildRendererBundle({
      version: 1,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [{ id: 'channel', entry, enabled: true, config: {} }],
    }, { profileId: 'work', channelManager: projection })
    const dom = new JSDOM(`
      <html lang="en" class="electron-dark"><head></head><body>
        <div class="sidebar-header"><button id="workspace-switcher" aria-haspopup="menu">Codex</button></div>
      </body></html>
    `, { runScripts: 'dangerously', url: 'https://codex.local/native' })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    Object.defineProperty(dom.window, 'fetch', { value: async () => ({ ok: false, status: 503, text: async () => '' }) })
    dom.window.eval(bundle)
    await waitFor(() => dom.window.document.documentElement.dataset.cordisxReady === 'true')
    const runtime = (dom.window as unknown as { __cordisxRuntime?: RuntimeHandle }).__cordisxRuntime!
    try {
      const snapshot = runtime.snapshot()
      expect(snapshot.plugins).toEqual([expect.objectContaining({
        id: 'channel', status: 'active', configuration: expect.objectContaining({ schemaKind: 'none', fields: [] }),
      })])
      expect(snapshot.registrations).toContainEqual(expect.objectContaining({
        owner: 'channel', surface: 'manager.settings.navigation-items', qualifiedId: 'channel:channels', valid: true,
      }))
      expect(snapshot.navigation.routes).toContainEqual(expect.objectContaining({
        qualifiedId: 'channel:settings', valid: true,
        productMetadata: expect.objectContaining({ title: 'Channel settings', diagnostics: [] }),
      }))
      expect(snapshot.navigation.pages).toContainEqual(expect.objectContaining({
        qualifiedId: 'channel:settings', metadata: expect.objectContaining({ chrome: 'standard' }),
        productMetadata: expect.objectContaining({ title: 'Channels', diagnostics: [] }),
      }))
      dom.window.document.querySelector<HTMLButtonElement>('[data-tab="plugins"]')!.click()
      const channelEntry = dom.window.document.querySelector<HTMLButtonElement>('[data-settings-navigation-item="channel:channels"]')!
      expect(channelEntry.textContent).toContain('Channel settings')
      expect(channelEntry.querySelector('[data-host-icon="host:layers"]')).not.toBeNull()
      channelEntry.click()
      await waitFor(() => dom.window.document.querySelector('[data-channel-manager="mounted"]') !== null)
      expect(dom.window.document.querySelector('.cxm-heading-current-heading')?.textContent).toBe('Channels')
      expect(dom.window.document.querySelector('[data-manager-content-root]')?.textContent).not.toContain('正在加载插件页面')
      expect(runtime.snapshot().navigation.outlets).toContainEqual(expect.objectContaining({
        id: 'manager.content', mounted: true, activeRoute: 'channel:settings',
      }))
      expect(dom.window.location.href).toBe('https://codex.local/native')
    } finally {
      await runtime.dispose()
      expect(dom.window.document.querySelector('[data-channel-manager]')).toBeNull()
      dom.window.close()
    }
  })

  it('renders and disposes the bounded Channel body through the internal Host service', () => {
    const dom = new JSDOM('<html lang="en"><body><main id="seat"></main></body></html>')
    const manager = new CordisXChannelManagerService(new Context(), projection)
    const controller = new AbortController()
    const container = dom.window.document.querySelector<HTMLElement>('#seat')!
    const dispose = manager.mount({
      document: dom.window.document,
      container,
      signal: controller.signal,
    } as never)
    const page = container.querySelector<HTMLElement>('[data-channel-manager="mounted"]')!
    expect(page.dataset.channelStatus).toBe('experimental')
    expect(page.querySelector('[data-channel-page="list"]')).not.toBeNull()
    const search = page.querySelector<HTMLInputElement>('[data-collection-search="channel-list"]')!
    expect(search.getAttribute('aria-label')).toBe('Search configured channels')
    const card = page.querySelector<HTMLButtonElement>('[data-host-collection="channel-list"] [data-collection-item="simulator/local/test"] .cxc-primary')!
    search.value = 'simulator'
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    card.click()
    expect(page.querySelector('[data-channel-page="detail"][data-channel-detail="simulator/local/test"]')).not.toBeNull()
    expect(page.querySelector('[data-host-form="channel-configuration"]')).not.toBeNull()
    expect(page.querySelectorAll('[data-host-form="channel-configuration"] [data-full-width="true"]')).toHaveLength(5)
    expect(page.querySelectorAll('[data-host-form="channel-configuration"] [data-host-form-primitive]')).not.toHaveLength(0)
    expect(page.querySelector('[data-host-form="channel-configuration"] [data-host-form-primitive="switch"]')?.getAttribute('aria-disabled')).toBe('true')
    page.querySelector<HTMLButtonElement>('[data-channel-detail-tab="logs"]')!.click()
    expect(page.querySelector('[data-channel-logs="unavailable"]')?.textContent).toContain('No channel logs are available yet.')
    expect(page.querySelector('[data-host-collection="channel-diagnostics"]')?.dataset.searchOmissionReason).toContain('fixed')
    page.querySelector<HTMLButtonElement>('[data-channel-detail-tab="sessions"]')!.click()
    const readiness = page.querySelector('[data-channel-real-readiness="unavailable"]')!
    expect([...readiness.querySelectorAll<HTMLElement>('[data-host-form-primitive]')].map(control => String((control as HTMLElement & { value?: unknown }).value))).toContain('Feishu test application: enabled candidate cli_aaba90fcc4389cb3; not connected.')
    expect(page.querySelector('[data-channel-session-actions="unavailable"]')).not.toBeNull()
    expect(page.querySelector('[data-host-collection="channel-routes"] [data-collection-item="default"]')).not.toBeNull()
    expect(page.querySelector('[data-host-collection="channel-bindings"] [data-collection-item="binding-1"]')?.textContent).toContain('codex')
    page.querySelector<HTMLButtonElement>('[data-channel-back="true"]')!.click()
    expect(page.querySelector<HTMLInputElement>('[data-collection-search="channel-list"]')?.value).toBe('simulator')
    page.querySelector<HTMLButtonElement>('[data-channel-create="true"]')!.click()
    expect(page.querySelector('[data-channel-create-form="true"]')).not.toBeNull()
    const name = page.querySelector<HTMLElement>('#channel-create-name') as HTMLElement & { onChange?: (value: string) => void }
    name.onChange?.('Feishu candidate')
    page.querySelector<HTMLFormElement>('[data-channel-create-form="true"]')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    expect(page.querySelector('[data-channel-page="list"]')).not.toBeNull()
    expect(page.querySelector('[data-host-collection="channel-list"] [data-collection-item="candidate/feishu/1"]')).not.toBeNull()
    expect(page.textContent).toContain('Local candidate')
    expect(page.outerHTML).not.toMatch(/secretRef|keychain:|host-secret:/i)
    controller.abort()
    expect(page.dataset.channelManagerAborted).toBe('true')
    dispose()
    expect(container.querySelector('[data-channel-manager]')).toBeNull()
    dom.window.close()
  })
})
