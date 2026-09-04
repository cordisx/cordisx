import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import type { CordisXConfig } from '../packages/cli/src/launcher/config.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V6,
  type CordisXPluginManifestV6,
} from '../packages/cli/src/permission-contracts.js'

interface RuntimeHandle {
  snapshot(): { readonly plugins: readonly { readonly id: string; readonly status: string; readonly error?: string }[] }
  dispose(): Promise<void>
}

describe('Agent Session route owner runtime coordinate', () => {
  it('mounts a v6 plugin whose public route owner is local while authority remains source-bound', async () => {
    const entry = path.resolve('tests/fixtures/agent-route-owner-coordinate-plugin.ts')
    const manifest: CordisXPluginManifestV6 = {
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V6,
      schemaVersion: 6,
      id: 'org.cordisx.chatroom',
      services: [],
      capabilities: [{
        name: 'approvals.request',
        required: false,
        scope: { sessionIds: { kind: 'host-route-param', routeId: 'room-session-detail', param: 'sessionId' } },
      }],
    }
    const config: CordisXConfig = {
      version: 1,
      rootDir: path.resolve('.'),
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [{
        id: manifest.id,
        entry,
        source: pathToFileURL(entry).href,
        enabled: true,
        config: {},
        revision: 0,
        manifest,
      }],
    }
    const bundle = await buildRendererBundle(config, {
      playground: true,
      profileId: 'playground',
      generation: 'route-owner-coordinate-generation',
    })
    const dom = new JSDOM('<!doctype html><html><body><div class="sidebar-header"><button aria-haspopup="menu">Codex</button></div></body></html>', {
      runScripts: 'dangerously',
      url: 'https://codex.local/',
    })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    Object.defineProperty(dom.window, 'fetch', { value: async () => ({ ok: false, status: 503, text: async () => '' }) })
    dom.window.eval(bundle)
    for (let attempt = 0; attempt < 80 && dom.window.document.documentElement.dataset.cordisxReady !== 'true'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const runtime = (dom.window as unknown as { readonly __cordisxRuntime?: RuntimeHandle }).__cordisxRuntime
    expect(dom.window.document.documentElement.dataset.cordisxRuntimeError).toBeUndefined()
    expect(runtime?.snapshot().plugins).toContainEqual(expect.objectContaining({
      id: manifest.id,
      status: 'active',
    }))
    await runtime?.dispose()
    dom.window.close()
  })
})
