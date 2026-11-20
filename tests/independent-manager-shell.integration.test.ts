import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import { safeServiceConfigEdit } from '../packages/cli/assets/manager/manager-schema.js'
import { createChannelCredentialsUI } from '../packages/cli/assets/manager/manager-channel-ui.js'
import { MODEL_SERVICE_SAFE_WRITE_CONTRACT } from '../packages/cli/src/model-service-contracts.js'

it('composes the shared navigation with the existing manager and preserves drafts across pages', async () => {
  const html = await readFile('packages/cli/assets/manager/index.html', 'utf8')
  const source = (await readFile('packages/cli/assets/manager/manager.js', 'utf8'))
    .replace(/^import .*manager-schema\.js'\s*/u, '')
    .replace(/^import .*manager-channel-ui\.js'\s*/u, '')
  const bundled = await build({
    entryPoints: ['packages/cli/src/independent-manager/shell.tsx'],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    loader: { '.svg': 'text' },
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  const dom = new JSDOM(html, { url: `http://127.0.0.1:9312/#${'a'.repeat(64)}`, runScripts: 'outside-only' })
  const window = dom.window as unknown as Window & typeof globalThis & Record<string, any>
  window.__schemaCheck = safeServiceConfigEdit
  window.__channelUI = createChannelCredentialsUI
  window.confirm = vi.fn(() => true)
  const state = {
    owner: { appId: 'codex', profileId: 'fixture' },
    management: {
      runtime: { kind: 'active' },
      revision: 1,
      activationRevision: 1,
      sources: [],
      plugins: [{ id: 'channel', name: 'Channel', status: 'active', enabled: true }],
    },
    services: {
      status: 'ok',
      revision: 'r1',
      managerSafeWrite: MODEL_SERVICE_SAFE_WRITE_CONTRACT,
      services: [{
        id: 'modelhub',
        displayName: 'Model Hub',
        baseUrl: 'https://example.test',
        enabled: true,
        codexModels: ['gpt-fixture'],
        claudeModels: [],
        protocols: ['openai-responses'],
      }],
    },
    rendererPlugins: { status: 'ok', plugins: [{ id: 'channel', name: 'Channel', status: 'active' }] },
  }
  const requests: Array<{ route: string; input: any }> = []
  window.fetch = vi.fn(async (route: string, options?: RequestInit) => {
    const input = typeof options?.body === 'string' ? JSON.parse(options.body) : undefined
    requests.push({ route, input })
    const value = route === '/api/session'
      ? { token: 'session' }
      : route === '/api/state'
      ? state
      : route === '/api/catalog'
      ? []
      : route === '/api/plugin-configuration' && input.action === 'read'
      ? {
        status: 'ok',
        configuration: {
          writable: true,
          revision: 1,
          fields: [{ path: ['name'], label: '名称', value: 'before' }],
          secrets: [],
        },
      }
      : route === '/api/plugin-configuration' && input.action === 'services'
      ? { status: 'ok', services: [] }
      : { status: 'unavailable' }
    return { ok: true, json: async () => value } as Response
  }) as typeof fetch
  try {
    window.eval(bundled.outputFiles[0]!.text)
    await window.eval(
      `(async()=>{const safeServiceConfigEdit=window.__schemaCheck;const createChannelCredentialsUI=window.__channelUI;${source}\n})()`,
    )
    const doc = window.document
    const nav = (name: string) =>
      doc.querySelector<HTMLButtonElement>(`#manager-navigation button[aria-label="${name}"]`)!
    const panel = (name: string) => doc.querySelector<HTMLElement>(`[data-manager-view="${name}"]`)!
    await vi.waitFor(() => expect(doc.querySelector('.manager-plugin-icon .cxr-card-icon')).not.toBeNull())
    expect(doc.querySelector('.manager-plugin-icon img')?.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
    expect(panel('plugins').hidden).toBe(false)
    expect(panel('model-services').hidden).toBe(true)
    doc.querySelector<HTMLButtonElement>('.manager-plugin-identity')!.click()
    await vi.waitFor(() => expect(doc.querySelector<HTMLInputElement>('#plugins .detail input')?.value).toBe('before'))
    const draft = doc.querySelector<HTMLInputElement>('#plugins .detail input')!
    draft.value = 'unsaved draft'
    draft.dispatchEvent(new window.Event('input', { bubbles: true }))
    nav('模型服务').click()
    await vi.waitFor(() => expect(panel('model-services').hidden).toBe(false))
    const search = doc.querySelector<HTMLInputElement>('#models-toolbar input')!
    const card = doc.querySelector<HTMLElement>('#models .card')!
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, 'no-such-model')
    search.dispatchEvent(new window.Event('input', { bubbles: true }))
    await vi.waitFor(() => expect(card.hidden).toBe(true))
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, 'gpt-fixture')
    search.dispatchEvent(new window.Event('input', { bubbles: true }))
    await vi.waitFor(() => expect(card.hidden).toBe(false))
    nav('插件商店').click()
    await vi.waitFor(() => expect(requests.filter(request => request.route === '/api/catalog')).toHaveLength(1))
    doc.getElementById('open-sources')!.click()
    await vi.waitFor(() => expect(panel('sources').hidden).toBe(false))
    doc.querySelector<HTMLButtonElement>('[aria-label="返回插件商店"]')!.click()
    await vi.waitFor(() => expect(panel('marketplace').hidden).toBe(false))
    nav('插件').click()
    await vi.waitFor(() => expect(panel('plugins').hidden).toBe(false))
    expect(doc.querySelector<HTMLInputElement>('#plugins .detail input')?.value).toBe('unsaved draft')
  } finally {
    dom.window.close()
  }
})
