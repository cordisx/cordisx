import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V7,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V8,
  CORDISX_ROUTE_SCHEMA_V2,
} from '../packages/cli/src/contracts.js'
import type { HostDomWorkerBoundaryOptions, HostDomWorkerStatus } from '../packages/cli/src/renderer/host-dom-worker.js'

const worker = vi.hoisted(() => ({
  options: [] as HostDomWorkerBoundaryOptions[],
  dispose: vi.fn<() => Promise<void>>(),
  canvasStarts: [] as unknown[],
  canvasStops: [] as string[],
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
        options.hostDom?.dispose()
        options.transientCanvas?.dispose()
      },
      startTransientCanvas: (input: unknown) => { worker.canvasStarts.push(input) },
      stopTransientCanvas: (sessionId: string) => { worker.canvasStops.push(sessionId) },
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
  setExtensionPointPolicy(source: string, pluginId: string, pointId: string, policy: 'allow' | 'deny' | 'inherit'): Promise<void>
  activePluginGeneration(): Record<string, unknown> & { readonly plugins: readonly unknown[]; readonly revision: number }
  stagePluginMutation(mutation: unknown): Promise<unknown>
  abortPluginMutation(transactionId: string): Promise<void>
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
  worker.canvasStarts.length = 0
  worker.canvasStops.length = 0
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

    const previous = runtime.activePluginGeneration()
    const nextDigest = `sha256:${'b'.repeat(64)}`
    const nextArtifactSource = artifactSource.replace('apply() {}', 'apply() { this.updated = true }')
    const candidate = {
      ...previous,
      recordKind: 'candidate',
      transactionId: 'local-isolated-update-without-manifest',
      revision: previous.revision + 1,
      lastGoodRevision: previous.revision,
      plugins: previous.plugins.map(value => {
        const item = value as { readonly id: string }
        return item.id === plugin.id
          ? { ...item, digest: nextDigest, moduleGeneration: 'isolated-host-dom-generation-2' }
          : item
      }),
    }
    const developmentPackage = {
      id: plugin.id,
      version: plugin.package.version,
      digest: nextDigest,
      identitySource: 'file:///cordisx-local-dev/isolated-host-dom/index.js',
      development: {
        origin: 'local-dev',
        pluginId: plugin.id,
        sourcePath: '/workspace/isolated-host-dom/index.js',
        state: 'ready',
        lastSuccessfulAt: '2026-09-04T00:00:00.000Z',
      },
    } as const
    await expect(runtime.stagePluginMutation({
      transactionId: candidate.transactionId,
      operation: 'update',
      previous,
      candidate,
      targetId: plugin.id,
      affectedPluginIds: [plugin.id],
      developmentPackage,
      isolatedArtifactSource: nextArtifactSource,
    })).rejects.toThrow('isolated artifact requires an authoritative isolated-worker manifest')
    expect(worker.options).toHaveLength(1)
    expect(runtime.activePluginGeneration()).toEqual(previous)
    await runtime.abortPluginMutation(candidate.transactionId)

    const validCandidate = { ...candidate, transactionId: 'local-isolated-update-with-manifest' }
    await runtime.stagePluginMutation({
      transactionId: validCandidate.transactionId,
      operation: 'update',
      previous,
      candidate: validCandidate,
      targetId: plugin.id,
      affectedPluginIds: [plugin.id],
      developmentPackage: { ...developmentPackage, manifest: plugin.manifest },
      isolatedArtifactSource: nextArtifactSource,
    })
    expect(worker.options).toHaveLength(2)
    expect(worker.options[1]?.artifactSource).toBe(nextArtifactSource)
    await runtime.publishPluginMutation(validCandidate.transactionId)
    await runtime.completePluginMutation(validCandidate.transactionId)
    await runtime.finalizePluginMutation(validCandidate.transactionId)
    expect(runtime.activePluginGeneration()).toMatchObject({
      revision: validCandidate.revision,
      plugins: [expect.objectContaining({
        id: plugin.id,
        digest: nextDigest,
        moduleGeneration: 'isolated-host-dom-generation-2',
      })],
    })

    await runtime.dispose()
    expect(worker.dispose).toHaveBeenCalledTimes(2)
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

  it('binds manifest-v7 to an isolated transient canvas without exposing Host DOM', async () => {
    const { installCordisX } = await import('../packages/cli/src/renderer/runtime.js')
    const dom = installBrowserGlobals()
    dom.window.document.body.innerHTML = `
      <main data-cordisx-playground-session-id="fixture-session">
        <div data-cordisx-playground-surface="composer.toolbar.items">
          <button type="submit" data-cordisx-playground-template="composer.toolbar">Send</button>
        </div>
      </main>
      <main data-cordisx-playground-seat="app"></main>
      <main data-cordisx-playground-seat="main"></main>
      <main data-cordisx-playground-seat="session.content"></main>`
    const offscreen = { kind: 'offscreen' } as unknown as OffscreenCanvas
    Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
      configurable: true,
      value: () => offscreen,
    })
    Object.defineProperty(dom.window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    })
    const artifactSource = 'globalThis.__canvasRendererExecutionWouldBeABug = true; globalThis.__cordisxPendingPluginModuleV1 = { apply() {} }'
    const plugin = {
      id: 'isolated-canvas', source: 'https://marketplace.example/isolated-canvas', enabled: true,
      config: {}, revision: 1, isolatedArtifactSource: artifactSource,
      manifest: {
        $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V7,
        schemaVersion: 7,
        id: 'isolated-canvas',
        capabilities: [],
        services: [],
        execution: { realm: 'isolated-worker', interfaces: ['ui.transient-canvas/v1'] },
      },
      package: {
        version: '1.0.0', digest: `sha256:${'c'.repeat(64)}`,
        moduleGeneration: 'isolated-canvas-generation', dependencies: [],
      },
    } as const
    const runtime = await installCordisX([plugin], {
      version: 'test', workspaceCwd: '/workspace', providers: [], profileId: 'work',
      hostKind: 'playground', generation: 'runtime-generation',
      pluginActivation: {
        $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
        schemaVersion: 1,
        recordKind: 'active',
        profileId: 'work', revision: 1, lastGoodRevision: 1, runtimeGeneration: 'runtime-generation',
        plugins: [{
          id: 'isolated-canvas', version: '1.0.0', digest: `sha256:${'c'.repeat(64)}`,
          moduleGeneration: 'isolated-canvas-generation', enabled: true, dependencies: [],
        }],
      },
    })
    expect(worker.options).toHaveLength(1)
    expect(worker.options[0]?.hostDom).toBeUndefined()
    expect(worker.options[0]?.transientCanvas).toBeDefined()
    expect((globalThis as typeof globalThis & Record<string, unknown>).__canvasRendererExecutionWouldBeABug).toBeUndefined()
    await runtime.setExtensionPointPolicy(
      'https://marketplace.example/isolated-canvas',
      'isolated-canvas',
      'composer.submit.effects',
      'allow',
    )
    await worker.options[0]!.transientCanvas!.register({
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/transient-canvas-registration.v1.schema.json',
      schemaVersion: 1,
      id: 'sparkles',
      pointId: 'composer.submit.effects',
      durationMs: 700,
      reducedMotion: 'static',
    })
    await Promise.resolve()
    const button = dom.window.document.querySelector<HTMLButtonElement>('button')!
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
    expect(worker.canvasStarts).toHaveLength(1)
    expect(worker.canvasStarts[0]).toMatchObject({ registrationId: 'sparkles', canvas: offscreen })
    expect(dom.window.document.querySelector<HTMLCanvasElement>('[data-cordisx-transient-canvas="sparkles"]')?.style.pointerEvents).toBe('none')

    await runtime.dispose()
    expect(dom.window.document.querySelector('[data-cordisx-transient-canvas]')).toBeNull()
    dom.window.close()
  }, 60_000)

  it('boots the production local-development runtime after its V8 authority requester route registers during plugin apply', async () => {
    const { installCordisX } = await import('../packages/cli/src/renderer/runtime.js')
    const dom = installBrowserGlobals()
    const plugin = {
      id: 'chatroom', source: 'file:///cordisx-local-dev/chatroom/chatroom.js', enabled: true,
      config: {}, revision: 1,
      manifest: {
        $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V8,
        schemaVersion: 8,
        id: 'chatroom',
        capabilities: [{
          name: 'approvals.answer', required: false,
          scope: { authorityRequester: { kind: 'approval-authority-requester-route', requester: { kind: 'host-route-param', routeId: 'room-session-detail', param: 'sessionId' } } },
        }],
        services: [],
      },
      module: {
        inject: ['i18n', 'pages', 'routes'],
        apply(ctx: any) {
          ctx.i18n.define({ namespace: 'chatroom', locale: 'en', default: true, messages: { page: 'Room', route: 'Session' } })
          ctx.pages.register({
            $schema: CORDISX_PAGE_SCHEMA_V3, schemaVersion: 3, id: 'room',
            title: { key: 'page', fallback: 'Room' }, description: { key: 'route', fallback: 'Session' },
          }, () => () => undefined)
          ctx.routes.register({
            $schema: CORDISX_ROUTE_SCHEMA_V2, schemaVersion: 2,
            id: 'room-session-detail', path: '/main/chatroom/:roomId/session/:sessionId', outlet: 'main', page: 'room',
            title: { key: 'route', fallback: 'Session' }, description: { key: 'route', fallback: 'Session' },
          })
        },
      },
      package: {
        version: '0.1.0', digest: `sha256:${'d'.repeat(64)}`,
        moduleGeneration: 'chatroom-v8-local-development', dependencies: [],
      },
    } as const
    const runtime = await installCordisX([plugin], {
      version: 'test', workspaceCwd: '/workspace', providers: [], profileId: 'work', hostKind: 'playground', generation: 'runtime-v8-local-development',
      pluginActivation: {
        $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1, schemaVersion: 1, recordKind: 'active',
        profileId: 'work', revision: 1, lastGoodRevision: 1, runtimeGeneration: 'runtime-v8-local-development',
        plugins: [{ id: 'chatroom', version: '0.1.0', digest: `sha256:${'d'.repeat(64)}`, moduleGeneration: 'chatroom-v8-local-development', enabled: true, dependencies: [] }],
      },
    })
    expect(runtime.snapshot().plugins).toContainEqual(expect.objectContaining({ id: 'chatroom', status: 'active' }))
    await runtime.dispose()
    dom.window.close()
  }, 60_000)
})
