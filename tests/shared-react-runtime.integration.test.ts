import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import type { CordisXConfig } from '../packages/cli/src/launcher/config.js'
import type { CordisXPluginActivationRecordV1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'

interface SharedRuntime {
  readonly React: unknown
}

interface RuntimeHandle {
  navigate(owner: string, reference: { readonly id: string }): Promise<void>
  dispose(): Promise<void>
}

interface TestWindow {
  readonly __cordisxRuntime?: RuntimeHandle
  readonly __cordisxSharedReactRuntime?: SharedRuntime
  readonly __sharedReactPluginReact?: unknown
  readonly __sharedReactEffectMounts?: number
  readonly __sharedReactEffectCleanups?: number
}

async function waitFor(predicate: () => boolean, attempts = 300): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition did not settle')
}

describe('shared React plugin runtime', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const config = (entry: string): CordisXConfig => ({
    version: 1,
    rootDir: root,
    codex: { debugPort: 9229 },
    providers: [],
    plugins: [{ id: 'shared-react', entry, enabled: true, config: {}, revision: 0 }],
  })

  it('renders hooks and shared components with the Host React singleton, then cleans up', async () => {
    const bundle = await buildRendererBundle(config(path.join(root, 'tests/fixtures/shared-react-page-plugin.tsx')), {
      playground: true,
      generation: 'shared-react-test',
      profileId: 'test',
    })
    const dom = new JSDOM(`<!doctype html><html lang="en" class="electron-dark"><head></head><body>
      <div data-cordisx-playground-seat="app"></div>
      <div data-cordisx-playground-seat="main"></div>
      <div data-cordisx-playground-seat="session.content"></div>
    </body></html>`, { runScripts: 'dangerously', url: 'https://cordisx.local/' })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    Object.defineProperty(dom.window, 'fetch', { value: async () => ({ ok: false, status: 503, text: async () => '' }) })
    dom.window.eval(bundle)
    await waitFor(() => dom.window.document.documentElement.dataset.cordisxReady === 'true')
    const window = dom.window as unknown as TestWindow
    expect(window.__sharedReactPluginReact).toBe(window.__cordisxSharedReactRuntime?.React)

    await window.__cordisxRuntime!.navigate('shared-react', { id: 'overview' })
    await waitFor(() => dom.window.document.querySelector('[data-shared-react-page="mounted"]') !== null)
    await waitFor(() => window.__sharedReactEffectMounts === 1)
    expect(window.__sharedReactEffectMounts).toBe(1)
    const button = dom.window.document.querySelector<HTMLButtonElement>('.cxr-ui-button')!
    expect(button.textContent).toBe('Count 0')
    button.click()
    await waitFor(() => button.textContent === 'Count 1')
    expect(dom.window.document.querySelector('.cxr-ui-card')).not.toBeNull()
    expect(dom.window.document.querySelector('[data-cordisx-shared-react="true"]')).not.toBeNull()

    dom.window.document.documentElement.lang = 'zh-CN'
    await waitFor(() => dom.window.document.querySelector('.cxr-ui-heading')?.textContent === '共享 React')
    expect(dom.window.document.querySelector('.cxr-ui-text')?.textContent).toBe('此插件页面由同一个 React 实例渲染。')

    await window.__cordisxRuntime!.dispose()
    await waitFor(() => window.__sharedReactEffectCleanups === 1)
    expect(dom.window.document.querySelector('[data-shared-react-page]')).toBeNull()
    expect(dom.window.document.querySelector('[data-cordisx-shared-react]')).toBeNull()
    expect(window.__cordisxSharedReactRuntime).toBeUndefined()
    dom.window.close()
  }, 20_000)

  it('rejects a plugin that bundles its own React copy', async () => {
    await expect(buildRendererBundle(config(path.join(root, 'tests/fixtures/private-react-plugin.tsx'))))
      .rejects.toThrow('must import React and UI components from cordisx/react and cordisx/ui')
  })

  it('does not publish the shared runtime when activation metadata is invalid', async () => {
    const plugin = path.join(root, 'tests/fixtures/shared-react-page-plugin.tsx')
    const invalidActivation: CordisXPluginActivationRecordV1 = {
      $schema: 'https://cordisx.dev/schema/plugin-activation.v1.json',
      schemaVersion: 1,
      recordKind: 'active',
      profileId: 'wrong-profile',
      revision: 0,
      lastGoodRevision: 0,
      runtimeGeneration: 'shared-react-invalid',
      plugins: [],
    }
    const bundle = await buildRendererBundle(config(plugin), {
      playground: true,
      generation: 'shared-react-invalid',
      profileId: 'test',
      pluginActivation: invalidActivation,
    })
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      runScripts: 'dangerously',
      url: 'https://cordisx.local/',
    })
    dom.window.eval(bundle)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect((dom.window as unknown as TestWindow).__cordisxSharedReactRuntime).toBeUndefined()
    expect(dom.window.document.querySelector('[data-cordisx-shared-react]')).toBeNull()
    dom.window.close()
  })
})
