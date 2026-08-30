import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
} from '../packages/cli/src/contracts.js'
import type { HostDomWorkerBoundaryOptions, HostDomWorkerStatus } from '../packages/cli/src/renderer/host-dom-worker.js'

const worker = vi.hoisted(() => ({
  options: [] as HostDomWorkerBoundaryOptions[],
  dispose: vi.fn<() => Promise<void>>(),
}))

vi.mock('../packages/cli/src/renderer/host-dom-worker.js', () => ({
  createBrowserHostDomWorkerEnvironment: () => ({ start: () => { throw new Error('unused mocked worker environment') } }),
  createHostDomWorkerBoundary: (options: HostDomWorkerBoundaryOptions) => {
    worker.options.push(options)
    const status: HostDomWorkerStatus = Object.freeze({ status: 'ready' })
    options.onStatus?.(Object.freeze({ status: 'starting' }))
    options.onStatus?.(status)
    return {
      ready: Promise.resolve(),
      status: () => status,
      subscribe: (listener: (value: HostDomWorkerStatus) => void) => {
        listener(status)
        return () => undefined
      },
      dispose: async () => {
        worker.dispose()
        options.hostDom.dispose()
      },
    }
  },
}))

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
  snapshot(): {
    readonly plugins: readonly { readonly id: string; readonly status: string }[]
    readonly permissions: readonly {
      readonly capability: string
      readonly availability: {
        readonly status: string
        readonly providers: readonly { readonly providerId: string }[]
      }
    }[]
  }
  activePluginGeneration(): Record<string, unknown> & { readonly plugins: readonly unknown[]; readonly revision: number }
  stagePluginMutation(mutation: unknown): Promise<unknown>
  publishPluginMutation(transactionId: string): Promise<unknown>
  completePluginMutation(transactionId: string): Promise<unknown>
  finalizePluginMutation(transactionId: string): Promise<void>
  dispose(): Promise<void>
}

function installBrowserGlobals(): JSDOM {
  const dom = new JSDOM('<html lang="en"><head></head><body><main id="root"></main></body></html>', {
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

async function disposeRuntime(): Promise<void> {
  const runtime = (globalThis as typeof globalThis & { __cordisxRuntime?: RuntimeHandle }).__cordisxRuntime
  await runtime?.dispose()
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
}

afterEach(async () => {
  await disposeRuntime()
  worker.options.length = 0
  worker.dispose.mockReset()
  vi.unstubAllGlobals()
  const globals = globalThis as typeof globalThis & Record<string, unknown>
  Reflect.deleteProperty(globals, '__cordisxBoot')
  Reflect.deleteProperty(globals, '__cordisxBootGeneration')
  Reflect.deleteProperty(globals, '__cordisxRequestedGeneration')
  Reflect.deleteProperty(globals, '__cordisxRuntime')
  Reflect.deleteProperty(globals, '__hostDomRendererExecutionWouldBeABug')
})

describe('Host DOM worker production runtime composition', () => {
  it('keeps the artifact as data, binds the Host client, reports availability, and disposes the boundary', async () => {
    const { installCordisX } = await import('../packages/cli/src/renderer/runtime.js')
    const dom = installBrowserGlobals()
    const artifactSource = 'globalThis.__hostDomRendererExecutionWouldBeABug = true; globalThis.__cordisxPendingPluginModuleV1 = { apply() {} }'
    const plugin = {
      id: 'isolated-host-dom',
      source: 'https://marketplace.example/isolated-host-dom',
      enabled: true,
      config: { label: 'safe configuration' },
      revision: 1,
      isolatedArtifactSource: artifactSource,
      manifest: {
        $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
        schemaVersion: 5,
        id: 'isolated-host-dom',
        capabilities: [{
          name: 'ui.host-dom.read',
          required: false,
          rationale: {
            title: { key: 'host-dom.title', fallback: 'Read the Host UI' },
            description: { key: 'host-dom.description', fallback: 'Reads bounded Host UI state.' },
            feature: { key: 'host-dom.feature', fallback: 'Host UI status' },
            deniedBehavior: { key: 'host-dom.denied', fallback: 'Host UI status stays unavailable.' },
          },
          security: { dataUse: 'ephemeral', retention: 'runtime', externalTransfer: false },
          scope: { rootIds: ['app.shell'], operations: ['read-text'] },
        }],
        services: [],
      },
      package: {
        version: '1.0.0',
        digest: `sha256:${'a'.repeat(64)}`,
        moduleGeneration: 'isolated-host-dom-generation',
        dependencies: [],
      },
    } as const

    const runtime = await installCordisX([plugin], {
      version: 'test',
      workspaceCwd: '/workspace',
      providers: [],
      profileId: 'work',
      generation: 'runtime-generation',
      pluginActivation: {
        $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
        schemaVersion: 1,
        recordKind: 'active',
        profileId: 'work',
        revision: 1,
        lastGoodRevision: 1,
        runtimeGeneration: 'runtime-generation',
        plugins: [{
          id: 'isolated-host-dom',
          version: '1.0.0',
          digest: `sha256:${'a'.repeat(64)}`,
          moduleGeneration: 'isolated-host-dom-generation',
          enabled: true,
          dependencies: [],
        }],
      },
    })

    expect(worker.options).toHaveLength(1)
    expect(worker.options[0]).toMatchObject({
      document: dom.window.document,
      artifactSource,
      config: { label: 'safe configuration' },
    })
    expect((globalThis as typeof globalThis & Record<string, unknown>).__hostDomRendererExecutionWouldBeABug).toBeUndefined()
    await expect(worker.options[0]!.hostDom.catalog()).resolves.toMatchObject({
      schemaVersion: 1,
      roots: expect.arrayContaining([expect.objectContaining({ rootId: 'app.shell' })]),
    })

    const snapshot = runtime.snapshot()
    expect(snapshot.plugins).toContainEqual(expect.objectContaining({ id: 'isolated-host-dom', status: 'active' }))
    expect(snapshot.permissions.find(permission => permission.capability === 'ui.host-dom.read')).toMatchObject({
      availability: {
        status: 'supported',
        providers: [{ providerId: 'host-dom-worker' }],
      },
    })

    await runtime.dispose()
    expect(worker.dispose).toHaveBeenCalledOnce()
    expect(dom.window.document.documentElement.dataset.cordisxReady).toBeUndefined()
    dom.window.close()
  }, 60_000)

  it('stages a dynamic package generation without evaluating its artifact in the renderer', async () => {
    const { installCordisX } = await import('../packages/cli/src/renderer/runtime.js')
    const dom = installBrowserGlobals()
    const runtime = await installCordisX([], {
      version: 'test',
      workspaceCwd: '/workspace',
      providers: [],
      profileId: 'work',
      generation: 'runtime-generation',
    })
    const artifactSource = 'globalThis.__dynamicHostDomRendererExecutionWouldBeABug = true; globalThis.__cordisxPendingPluginModuleV1 = { apply() {} }'
    const runtimeManifest = {
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
      schemaVersion: 5,
      id: 'dynamic-host-dom',
      capabilities: [{
        name: 'ui.host-dom.modify',
        required: false,
        rationale: {
          title: { key: 'host-dom.title', fallback: 'Modify the Host UI' },
          description: { key: 'host-dom.description', fallback: 'Adds one bounded owned child.' },
          feature: { key: 'host-dom.feature', fallback: 'Host UI marker' },
          deniedBehavior: { key: 'host-dom.denied', fallback: 'The marker stays unavailable.' },
        },
        security: { dataUse: 'ephemeral', retention: 'runtime', externalTransfer: false },
        scope: { rootIds: ['app.shell'], operations: ['insert-owned-structured-child', 'remove-owned-child'] },
      }],
      services: [],
    } as const
    const previous = runtime.activePluginGeneration()
    const candidate = {
      ...previous,
      recordKind: 'candidate',
      transactionId: 'dynamic-host-dom-install',
      revision: previous.revision + 1,
      lastGoodRevision: previous.revision,
      plugins: [{
        id: 'dynamic-host-dom',
        version: '1.0.0',
        digest: `sha256:${'b'.repeat(64)}`,
        moduleGeneration: 'dynamic-host-dom-generation',
        enabled: true,
        dependencies: [],
      }],
    }

    await runtime.stagePluginMutation({
      transactionId: 'dynamic-host-dom-install',
      operation: 'install',
      previous,
      candidate,
      targetId: 'dynamic-host-dom',
      affectedPluginIds: ['dynamic-host-dom'],
      package: {
        manifest: { id: 'dynamic-host-dom', version: '1.0.0', runtimeManifest },
        digest: `sha256:${'b'.repeat(64)}`,
        identitySource: 'https://marketplace.example/dynamic-host-dom',
      },
      isolatedArtifactSource: artifactSource,
    })

    expect(worker.options).toHaveLength(1)
    expect(worker.options[0]?.artifactSource).toBe(artifactSource)
    expect((globalThis as typeof globalThis & Record<string, unknown>).__dynamicHostDomRendererExecutionWouldBeABug).toBeUndefined()
    await runtime.publishPluginMutation('dynamic-host-dom-install')
    await runtime.completePluginMutation('dynamic-host-dom-install')
    await runtime.finalizePluginMutation('dynamic-host-dom-install')
    expect(runtime.snapshot().plugins).toContainEqual(expect.objectContaining({ id: 'dynamic-host-dom', status: 'active' }))

    await runtime.dispose()
    expect(worker.dispose).toHaveBeenCalledOnce()
    Reflect.deleteProperty(globalThis as typeof globalThis & Record<string, unknown>, '__dynamicHostDomRendererExecutionWouldBeABug')
    dom.window.close()
  }, 60_000)
})
