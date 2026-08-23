import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'

describe('Platform runtime activation', () => {
  it('blocks a required denied capability and mounts fresh after policy recovery', async () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const baseConfig = await loadConfig(path.join(projectRoot, 'cordisx.config.example.json'))
    const entry = path.join(projectRoot, 'tests/fixtures/platform-required-plugin.ts')
    const config = {
      ...baseConfig,
      plugins: [{ id: 'platform-required', entry, enabled: true, config: {} }],
    }
    const bundle = await buildRendererBundle(config)
    const dom = new JSDOM(`
      <html lang="en"><head></head><body>
        <div class="sidebar-header"><button id="workspace-switcher" aria-haspopup="menu">Codex</button></div>
      </body></html>
    `, { runScripts: 'dangerously', url: 'https://codex.local/' })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })

    const identityKey = JSON.stringify([pathToFileURL(entry).href, 'platform-required'])
    const fingerprint = JSON.stringify({
      name: 'models.read',
      required: true,
      reason: { key: 'permission.required', fallback: 'Models are required for this fixture' },
      scope: {},
    })
    dom.window.localStorage.setItem('cordisx.platform.permissionPolicies.v1', JSON.stringify([{
      identityKey,
      capability: 'models.read',
      fingerprint,
      policy: 'deny',
    }]))

    dom.window.eval(bundle)
    for (let attempt = 0; attempt < 20 && dom.window.document.documentElement.dataset.cordisxReady !== 'true'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const runtime = (dom.window as unknown as {
      __cordisxRuntime?: {
        snapshot(): {
          plugins: readonly { id: string; status: string; blockedReason?: string }[]
          permissions: readonly { capability: string; policy: string; blockedReason?: string }[]
        }
        setPermissionPolicy(id: string, capability: 'models.read', policy: 'allow'): Promise<void>
        dispose(): Promise<void>
      }
    }).__cordisxRuntime
    expect(runtime?.snapshot().plugins[0]).toMatchObject({
      id: 'platform-required',
      status: 'permission-blocked',
      blockedReason: 'Required capability denied: models.read',
    })
    expect(runtime?.snapshot().permissions[0]).toMatchObject({
      capability: 'models.read',
      policy: 'deny',
      blockedReason: 'Required capability models.read is denied',
    })
    expect(dom.window.document.documentElement.dataset.platformRequiredMounted).toBeUndefined()

    await runtime?.setPermissionPolicy('platform-required', 'models.read', 'allow')
    expect(runtime?.snapshot().plugins[0]?.status).toBe('active')
    expect(dom.window.document.documentElement.dataset.platformRequiredMounted).toBe('true')

    await runtime?.dispose()
    expect(dom.window.document.documentElement.dataset.platformRequiredMounted).toBeUndefined()
    dom.window.close()
  })
})
