import { JSDOM } from 'jsdom'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V5 } from '../packages/cli/src/permission-contracts.js'

vi.mock('../packages/cli/src/renderer/host-ui/BrandMark.js', () => ({
  createBrandMarkElement: (document: Document, className?: string) => {
    const mark = document.createElement('span')
    if (className !== undefined) mark.className = className
    return mark
  },
  BrandMark: () => null,
  AnimatedBrandMark: () => null,
}))

interface RuntimeHandle {
  dispose(): Promise<void>
}

function installBrowserGlobals(): JSDOM {
  const dom = new JSDOM('<html lang="en"><head></head><body></body></html>', {
    pretendToBeVisual: true,
    url: 'https://codex.local/',
  })
  const browser = dom.window
  Object.defineProperty(browser.HTMLElement.prototype, 'getClientRects', {
    configurable: true,
    value: () => ({ length: 1 }),
  })
  for (const [name, value] of [
    ['window', browser],
    ['document', browser.document],
    ['history', browser.history],
    ['location', browser.location],
    ['navigator', browser.navigator],
    ['localStorage', browser.localStorage],
    ['HTMLElement', browser.HTMLElement],
    ['Element', browser.Element],
    ['Node', browser.Node],
    ['Text', browser.Text],
    ['Event', browser.Event],
    ['CustomEvent', browser.CustomEvent],
    ['KeyboardEvent', browser.KeyboardEvent],
    ['MouseEvent', browser.MouseEvent],
    ['MutationObserver', browser.MutationObserver],
    ['getComputedStyle', browser.getComputedStyle.bind(browser)],
    ['requestAnimationFrame', browser.requestAnimationFrame.bind(browser)],
    ['cancelAnimationFrame', browser.cancelAnimationFrame.bind(browser)],
  ] as const) vi.stubGlobal(name, value)
  return dom
}

function metadata(generation: string, hostKind?: 'codex' | 'playground', includeFixture = false) {
  return {
    version: 'test',
    workspaceCwd: '/private/tmp/cordisx-runtime-test',
    providers: [],
    profileId: 'work',
    generation,
    ...(hostKind === undefined ? {} : { hostKind }),
    ...(hostKind === 'playground' ? { permissionPolicies: [] } : {}),
    ...(includeFixture ? {
      pluginActivation: {
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-activation.v1.schema.json' as const,
        schemaVersion: 1 as const, recordKind: 'active' as const, profileId: 'work',
        revision: 1, lastGoodRevision: 1, runtimeGeneration: generation,
        plugins: [{
          id: 'org.cordisx.permission-fixture', version: '1.0.0',
          digest: `sha256:${'a'.repeat(64)}` as const,
          moduleGeneration: 'local-dev-generation-1', enabled: true, dependencies: [],
        }],
      },
    } : {}),
  } as const
}

const localDevelopmentPlugin = (development: boolean, applied: () => void) => {
  const id = 'org.cordisx.permission-fixture'
  const source = 'file:///cordisx-local-dev/fixture/org.cordisx.permission-fixture.js'
  const manifest = {
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
    schemaVersion: 5 as const,
    id,
    services: [],
    capabilities: [{ name: 'sessions.get' as const, required: true, scope: {} }],
  }
  return {
    id, source, enabled: true, config: {}, revision: 0, manifest,
    package: {
      version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` as const,
      moduleGeneration: 'local-dev-generation-1', dependencies: [],
    },
    ...(development ? {
      development: {
        origin: 'local-dev' as const, pluginId: id,
        sourcePath: '/private/tmp/chatroom/src/index.ts', state: 'ready' as const,
      },
    } : {}),
    module: {
      manifest,
      inject: ['sessions'],
      async apply(ctx: Context) {
        await ctx.sessions.get('cx-session.permission-fixture')
        applied()
      },
    },
  }
}

async function disposeRuntime(): Promise<void> {
  const runtime = (globalThis as typeof globalThis & { __cordisxRuntime?: RuntimeHandle }).__cordisxRuntime
  await runtime?.dispose()
  // React's scheduler may retain a final Immediate after root unmount; keep
  // the browser globals alive until that queue is drained.
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
}

afterEach(async () => {
  await disposeRuntime()
  vi.unstubAllGlobals()
  const globals = globalThis as typeof globalThis & Record<string, unknown>
  Reflect.deleteProperty(globals, '__cordisxBoot')
  Reflect.deleteProperty(globals, '__cordisxBootGeneration')
  Reflect.deleteProperty(globals, '__cordisxRequestedGeneration')
  Reflect.deleteProperty(globals, '__cordisxRuntime')
})

describe('production renderer generation bootstrap', () => {
  it('does not show a permission dialog for an explicitly loaded Playground development artifact', async () => {
    const { installCordisX } = await import('../packages/cli/src/renderer/runtime.js')
    const dom = installBrowserGlobals()
    const applied = vi.fn()

    await expect(installCordisX(
      [localDevelopmentPlugin(true, applied)],
      metadata('playground-local-development', 'playground', true),
    )).resolves.toBeDefined()

    expect(applied).toHaveBeenCalledOnce()
    expect(dom.window.document.querySelector('[data-permission-prompt]')).toBeNull()
    await disposeRuntime()
    dom.window.close()
  }, 60_000)

  it('still prompts for an ordinary plugin outside the local development authority', async () => {
    const { installCordisX } = await import('../packages/cli/src/renderer/runtime.js')
    const dom = installBrowserGlobals()
    const applied = vi.fn()
    const boot = installCordisX(
      [localDevelopmentPlugin(false, applied)],
      metadata('playground-ordinary-plugin', 'playground', true),
    )
    for (let attempt = 0; attempt < 50 && dom.window.document.querySelector('[data-permission-prompt]') === null; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const prompt = dom.window.document.querySelector<HTMLElement>('[data-permission-prompt]')
    expect(prompt?.dataset.permissionPrompt).toBe('sessions.get')
    prompt?.querySelector<HTMLButtonElement>('[data-permission-decision="deny"]')?.click()
    await expect(boot).resolves.toBeDefined()
    expect(applied).toHaveBeenCalledOnce()

    await disposeRuntime()
    dom.window.close()
  }, 60_000)

  it('still prompts outside the Playground host even when local development metadata is present', async () => {
    const { installCordisX } = await import('../packages/cli/src/renderer/runtime.js')
    const dom = installBrowserGlobals()
    const applied = vi.fn()
    const boot = installCordisX(
      [localDevelopmentPlugin(true, applied)],
      metadata('codex-local-development-metadata', 'codex', true),
    )
    for (let attempt = 0; attempt < 50 && dom.window.document.querySelector('[data-permission-prompt]') === null; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const prompt = dom.window.document.querySelector<HTMLElement>('[data-permission-prompt]')
    expect(prompt?.dataset.permissionPrompt).toBe('sessions.get')
    prompt?.querySelector<HTMLButtonElement>('[data-permission-decision="deny"]')?.click()
    await expect(boot).resolves.toBeDefined()
    expect(applied).toHaveBeenCalledOnce()

    await disposeRuntime()
    dom.window.close()
  }, 60_000)

  it('reuses one Promise and starts once for a same-generation duplicate', async () => {
    const { installCordisX } = await import('../packages/cli/src/renderer/runtime.js')
    const dom = installBrowserGlobals()
    const firstBootstrap = vi.fn(async () => undefined)
    const duplicateBootstrap = vi.fn(async () => undefined)

    const first = installCordisX([], metadata('same-generation'), firstBootstrap)
    const duplicate = installCordisX([], metadata('same-generation'), duplicateBootstrap)
    expect(duplicate).toBe(first)
    await expect(first).resolves.toBeDefined()
    expect(firstBootstrap).toHaveBeenCalledOnce()
    expect(duplicateBootstrap).not.toHaveBeenCalled()

    await disposeRuntime()
    dom.window.close()
  }, 60_000)

  it('starts only the newest generation when old and new bootstraps arrive in one tick', async () => {
    const { installCordisX } = await import('../packages/cli/src/renderer/runtime.js')
    const dom = installBrowserGlobals()
    const oldBootstrap = vi.fn(async () => undefined)
    const newBootstrap = vi.fn(async () => undefined)

    const old = installCordisX([], metadata('old-generation'), oldBootstrap)
    const newest = installCordisX([], metadata('new-generation'), newBootstrap)
    await expect(old).rejects.toThrow('CordisX bootstrap generation was superseded')
    await expect(newest).resolves.toBeDefined()
    expect(oldBootstrap).not.toHaveBeenCalled()
    expect(newBootstrap).toHaveBeenCalledOnce()

    await disposeRuntime()
    dom.window.close()
  }, 60_000)

  it('clears failed boot globals so the same generation can retry cleanly', async () => {
    const { installCordisX } = await import('../packages/cli/src/renderer/runtime.js')
    const dom = installBrowserGlobals()
    const failingBootstrap = vi.fn(async () => { throw new Error('fixture generation boot failed') })
    const retryBootstrap = vi.fn(async () => undefined)

    const failed = installCordisX([], metadata('retry-generation'), failingBootstrap)
    await expect(failed).rejects.toThrow('fixture generation boot failed')
    await Promise.resolve()
    const globals = globalThis as typeof globalThis & Record<string, unknown>
    expect(globals.__cordisxBoot).toBeUndefined()
    expect(globals.__cordisxBootGeneration).toBeUndefined()
    expect(globals.__cordisxRequestedGeneration).toBeUndefined()

    const retry = installCordisX([], metadata('retry-generation'), retryBootstrap)
    expect(retry).not.toBe(failed)
    await expect(retry).resolves.toBeDefined()
    expect(failingBootstrap).toHaveBeenCalledOnce()
    expect(retryBootstrap).toHaveBeenCalledOnce()

    await disposeRuntime()
    dom.window.close()
  }, 60_000)
})
