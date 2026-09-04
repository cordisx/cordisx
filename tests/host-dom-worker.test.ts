import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import type {
  BoundHostDomClient,
  HostDomBridgeRequest,
  HostDomBridgeResult,
  HostDomRootCatalog,
} from '@cordisx/protocol/host-dom/v1'
import {
  createBrowserHostDomWorkerEnvironment,
  createHostDomWorkerBoundary,
  HOST_DOM_WORKER_IFRAME_CSP,
  type HostDomWorkerEnvironment,
  type HostDomWorkerTransport,
  type HostDomWorkerTransportInput,
} from '../packages/cli/src/renderer/host-dom-worker.js'

const WORKER_MESSAGE = 'cordisx.host-dom-worker/v1'
const REQUEST_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/host-dom-bridge-request.v1.schema.json'
const RESULT_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/host-dom-bridge-result.v1.schema.json'

class FakeTransport implements HostDomWorkerTransport {
  readonly posted: unknown[] = []
  readonly transfers: Transferable[][] = []
  readonly listeners = new Set<(message: unknown) => void>()
  terminated = false
  destroyed = false

  post = (message: unknown, transfer: readonly Transferable[] = []): void => {
    this.posted.push(message)
    this.transfers.push([...transfer])
  }
  subscribe = (listener: (message: unknown) => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  terminate = (): void => { this.terminated = true }
  destroy = (): void => { this.destroyed = true; this.listeners.clear() }
  emit(message: unknown): void { for (const listener of this.listeners) listener(message) }
}

class FakeEnvironment implements HostDomWorkerEnvironment {
  readonly transport = new FakeTransport()
  input: HostDomWorkerTransportInput | undefined
  start = (input: HostDomWorkerTransportInput): HostDomWorkerTransport => {
    this.input = input
    return this.transport
  }
}

function catalog(): HostDomRootCatalog {
  return {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/host-dom-root-catalog.v1.schema.json',
    schemaVersion: 1,
    authority: 'host',
    catalogVersion: '2026-08-31',
    hostGeneration: 'host-1',
    roots: [],
  }
}

function released(requestId: string): HostDomBridgeResult {
  return {
    $schema: RESULT_SCHEMA,
    contract: 'cordisx.bound-host-dom/v1',
    schemaVersion: 1,
    requestId,
    hostGeneration: 'host-1',
    type: 'release',
    status: 'accepted',
    code: 'released',
  }
}

function client() {
  const value: BoundHostDomClient = {
    catalog: vi.fn(async () => catalog()),
    request: vi.fn(async request => released(request.requestId)),
    dispose: vi.fn(),
  }
  return value as BoundHostDomClient & {
    catalog: ReturnType<typeof vi.fn>
    request: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
  }
}

function status(environment: FakeEnvironment, state: 'ready' | 'disposed') {
  return { contract: WORKER_MESSAGE, token: environment.input?.token, type: 'status', status: state }
}

function fromWorker(environment: FakeEnvironment, message: Record<string, unknown>) {
  return { contract: WORKER_MESSAGE, token: environment.input?.token, ...message }
}

async function waitForPosted(transport: FakeTransport, count: number): Promise<void> {
  await vi.waitFor(() => expect(transport.posted.length).toBeGreaterThanOrEqual(count))
}

describe('Host DOM worker boundary', () => {
  it('defines an opaque sandbox iframe and a separately loaded, locked-down Blob worker', async () => {
    const dom = new JSDOM('<body></body>')
    const environment = new FakeEnvironment()
    const hostDom = client()
    const artifact = `globalThis.__cordisxHostDomPluginModuleV1 = { apply({ hostDom, onDispose }, config) {
      onDispose(async () => {}); return hostDom.catalog().then(() => undefined)
    } }`
    const statuses: string[] = []
    const boundary = createHostDomWorkerBoundary({
      document: dom.window.document,
      artifactSource: artifact,
      config: { enabled: true },
      hostDom,
      environment,
      onStatus: state => statuses.push(state.status),
    })

    const input = environment.input
    expect(input).toBeDefined()
    expect(input?.iframeSandbox).toBe('allow-scripts')
    expect(input?.iframeSrcdoc).toContain(`Content-Security-Policy" content="${HOST_DOM_WORKER_IFRAME_CSP}`)
    expect(input?.iframeSrcdoc).toContain("default-src 'none'")
    expect(input?.iframeSrcdoc).toContain("connect-src 'none'")
    expect(input?.iframeSrcdoc).toContain("worker-src blob:")
    expect(input?.iframeSrcdoc).toContain("script-src 'unsafe-inline' blob:")
    expect(input?.iframeSrcdoc).not.toContain('allow-same-origin')
    expect(input?.artifactSource).toBe(artifact)
    expect(input?.bootstrapSource).not.toContain(artifact)
    expect(input).not.toHaveProperty('hostDom')

    const bootstrap = input?.bootstrapSource ?? ''
    expect(() => new Function(bootstrap)).not.toThrow()
    expect(bootstrap).toContain("['fetch', 'importScripts', 'postMessage', 'addEventListener'")
    expect(bootstrap).toContain("['Worker', 'SharedWorker', 'WebSocket', 'EventSource', 'XMLHttpRequest'")
    expect(bootstrap).toContain("'MessagePort', 'Function'")
    expect(bootstrap).toContain("'eval', 'close'")
    expect(bootstrap).toContain("['require', 'process', 'module', 'document', 'window']")
    expect(bootstrap).toContain('nativeImportScripts(event.data.artifactUrl)')
    expect(bootstrap).toContain('const portPost = port.postMessage.bind(port)')
    expect(bootstrap).toContain('message.token !== boundaryToken')
    expect(bootstrap).toContain('applyFunction(pluginModule.apply, pluginModule, [context, config])')
    expect(bootstrap).toContain("plugin apply must return void or Promise<void>")

    environment.transport.emit(status(environment, 'ready'))
    await boundary.ready
    expect(boundary.status()).toEqual({ status: 'ready' })
    expect(statuses).toEqual(['starting', 'ready'])

    const disposal = boundary.dispose()
    expect(environment.transport.posted).toContainEqual({
      contract: WORKER_MESSAGE,
      token: environment.input?.token,
      type: 'dispose',
    })
    environment.transport.emit(status(environment, 'disposed'))
    await disposal
    expect(boundary.status()).toEqual({ status: 'disposed' })
    expect(environment.transport.terminated).toBe(true)
    expect(environment.transport.destroyed).toBe(true)
    expect(hostDom.dispose).toHaveBeenCalledTimes(1)
    dom.window.close()
  })

  it('proxies only bounded serializable catalog/request/dispose calls with exact sequence and request ids', async () => {
    const dom = new JSDOM('<body></body>')
    const environment = new FakeEnvironment()
    const hostDom = client()
    const boundary = createHostDomWorkerBoundary({
      document: dom.window.document,
      artifactSource: 'globalThis.__cordisxHostDomPluginModuleV1 = { apply() {} }',
      hostDom,
      environment,
    })
    environment.transport.emit(status(environment, 'ready'))
    await boundary.ready

    environment.transport.emit(fromWorker(environment, {
      type: 'rpc',
      sequence: 1,
      requestId: 'rpc-catalog-1',
      method: 'catalog',
    }))
    await waitForPosted(environment.transport, 1)
    expect(hostDom.catalog).toHaveBeenCalledTimes(1)
    expect(environment.transport.posted[0]).toEqual({
      contract: WORKER_MESSAGE,
      token: environment.input?.token,
      type: 'rpc-result',
      sequence: 1,
      requestId: 'rpc-catalog-1',
      ok: true,
      value: catalog(),
    })

    const request: HostDomBridgeRequest = {
      $schema: REQUEST_SCHEMA,
      contract: 'cordisx.bound-host-dom/v1',
      schemaVersion: 1,
      requestId: 'plugin-release-1',
      type: 'release',
      handle: 'hdh_0123456789abcdef',
    }
    environment.transport.emit(fromWorker(environment, {
      type: 'rpc',
      sequence: 2,
      requestId: request.requestId,
      method: 'request',
      payload: request,
    }))
    await waitForPosted(environment.transport, 2)
    expect(hostDom.request).toHaveBeenCalledWith(request)
    expect(environment.transport.posted[1]).toEqual({
      contract: WORKER_MESSAGE,
      token: environment.input?.token,
      type: 'rpc-result',
      sequence: 2,
      requestId: request.requestId,
      ok: true,
      value: released(request.requestId),
    })

    environment.transport.emit(fromWorker(environment, {
      type: 'rpc',
      sequence: 3,
      requestId: 'rpc-dispose-3',
      method: 'dispose',
    }))
    await waitForPosted(environment.transport, 3)
    expect(hostDom.dispose).toHaveBeenCalledTimes(1)
    expect(environment.transport.posted[2]).toEqual({
      contract: WORKER_MESSAGE,
      token: environment.input?.token,
      type: 'rpc-result',
      sequence: 3,
      requestId: 'rpc-dispose-3',
      ok: true,
      value: null,
    })

    const disposal = boundary.dispose()
    environment.transport.emit(status(environment, 'disposed'))
    await disposal
    expect(hostDom.dispose).toHaveBeenCalledTimes(1)
    dom.window.close()
  })

  it('exposes transient canvas only through its declared worker interface and transfers no DOM object', async () => {
    const dom = new JSDOM('<body></body>')
    const environment = new FakeEnvironment()
    const transientCanvas = {
      register: vi.fn(async () => undefined),
      unregister: vi.fn(async () => undefined),
      dispose: vi.fn(),
    }
    const boundary = createHostDomWorkerBoundary({
      document: dom.window.document,
      artifactSource: 'globalThis.__cordisxHostDomPluginModuleV1 = { apply() {} }',
      transientCanvas,
      environment,
    })
    expect(environment.input?.interfaces).toEqual(['ui.transient-canvas/v1'])
    expect(environment.input?.bootstrapSource).toContain("['require', 'process', 'module', 'document', 'window']")
    environment.transport.emit(status(environment, 'ready'))
    await boundary.ready

    const declaration = {
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/transient-canvas-registration.v1.schema.json',
      schemaVersion: 1,
      id: 'sparkles',
      pointId: 'composer.submit.effects',
      durationMs: 700,
      reducedMotion: 'static',
    } as const
    environment.transport.emit(fromWorker(environment, {
      type: 'rpc', sequence: 1, requestId: 'rpc-canvas-register-1', method: 'canvas-register', payload: declaration,
    }))
    await waitForPosted(environment.transport, 1)
    expect(transientCanvas.register).toHaveBeenCalledWith(declaration)

    const offscreen = { kind: 'offscreen' } as unknown as OffscreenCanvas
    boundary.startTransientCanvas({
      sessionId: 'canvas:1', registrationId: 'sparkles', canvas: offscreen,
      width: 1200, height: 800, pixelRatio: 2, reducedMotion: false, startedAt: 42,
    })
    expect(environment.transport.posted[1]).toMatchObject({
      type: 'canvas-start', registrationId: 'sparkles', canvas: offscreen,
    })
    expect(environment.transport.posted[1]).not.toHaveProperty('document')
    expect(environment.transport.transfers[1]).toEqual([offscreen])
    boundary.stopTransientCanvas('canvas:1')
    expect(environment.transport.posted[2]).toMatchObject({ type: 'canvas-stop', sessionId: 'canvas:1' })

    const disposal = boundary.dispose()
    environment.transport.emit(status(environment, 'disposed'))
    await disposal
    expect(transientCanvas.dispose).toHaveBeenCalledTimes(1)
    dom.window.close()
  })

  it('fails closed before Host dispatch on sequence, request-id, and envelope violations', async () => {
    const dom = new JSDOM('<body></body>')
    const environment = new FakeEnvironment()
    const hostDom = client()
    const statuses: string[] = []
    const boundary = createHostDomWorkerBoundary({
      document: dom.window.document,
      artifactSource: 'globalThis.__cordisxHostDomPluginModuleV1 = { apply() {} }',
      hostDom,
      environment,
      onStatus: value => statuses.push(value.status),
    })
    environment.transport.emit(status(environment, 'ready'))
    await boundary.ready
    environment.transport.emit(fromWorker(environment, {
      type: 'rpc',
      sequence: 2,
      requestId: 'out-of-order',
      method: 'catalog',
    }))

    await vi.waitFor(() => expect(boundary.status().status).toBe('error'))
    expect(boundary.status()).toMatchObject({ status: 'error', error: expect.stringContaining('sequence') })
    expect(hostDom.catalog).not.toHaveBeenCalled()
    expect(hostDom.request).not.toHaveBeenCalled()
    expect(hostDom.dispose).toHaveBeenCalledTimes(1)
    expect(environment.transport.terminated).toBe(true)
    expect(environment.transport.destroyed).toBe(true)
    expect(statuses).toEqual(['starting', 'ready', 'error'])
    await boundary.dispose()
    expect(boundary.status()).toEqual({ status: 'disposed' })
    dom.window.close()
  })

  it('rejects an RPC/request id mismatch without dispatching the plugin payload', async () => {
    const dom = new JSDOM('<body></body>')
    const environment = new FakeEnvironment()
    const hostDom = client()
    const boundary = createHostDomWorkerBoundary({
      document: dom.window.document,
      artifactSource: 'globalThis.__cordisxHostDomPluginModuleV1 = { apply() {} }',
      hostDom,
      environment,
    })
    environment.transport.emit(status(environment, 'ready'))
    await boundary.ready
    environment.transport.emit(fromWorker(environment, {
      type: 'rpc',
      sequence: 1,
      requestId: 'envelope-request-1',
      method: 'request',
      payload: {
        $schema: REQUEST_SCHEMA,
        contract: 'cordisx.bound-host-dom/v1',
        schemaVersion: 1,
        requestId: 'different-request-1',
        type: 'release',
        handle: 'hdh_0123456789abcdef',
      },
    }))
    await waitForPosted(environment.transport, 1)
    expect(hostDom.request).not.toHaveBeenCalled()
    expect(environment.transport.posted[0]).toMatchObject({
      contract: WORKER_MESSAGE,
      token: environment.input?.token,
      type: 'rpc-result',
      sequence: 1,
      requestId: 'envelope-request-1',
      ok: false,
      error: expect.stringContaining('does not match'),
    })
    expect(boundary.status()).toEqual({ status: 'ready' })
    const disposal = boundary.dispose()
    environment.transport.emit(status(environment, 'disposed'))
    await disposal
    dom.window.close()
  })

  it('rejects a forged boundary token before status or Host RPC dispatch', async () => {
    const dom = new JSDOM('<body></body>')
    const environment = new FakeEnvironment()
    const hostDom = client()
    const boundary = createHostDomWorkerBoundary({
      document: dom.window.document,
      artifactSource: 'globalThis.__cordisxHostDomPluginModuleV1 = { apply() {} }',
      hostDom,
      environment,
    })

    environment.transport.emit({
      contract: WORKER_MESSAGE,
      token: 'b'.repeat(32),
      type: 'status',
      status: 'ready',
    })

    await expect(boundary.ready).rejects.toThrow('invalid envelope')
    expect(boundary.status()).toMatchObject({ status: 'error' })
    expect(hostDom.catalog).not.toHaveBeenCalled()
    expect(hostDom.request).not.toHaveBeenCalled()
    expect(hostDom.dispose).toHaveBeenCalledOnce()
    await boundary.dispose()
    dom.window.close()
  })

  it('reuses browser primitives captured before renderer globals and DOM prototypes are tampered', () => {
    const dom = new JSDOM('<body></body>')
    const environment = createBrowserHostDomWorkerEnvironment(dom.window.document)
    const createElement = vi.spyOn(dom.window.document, 'createElement').mockImplementation(() => {
      throw new Error('tampered document.createElement')
    })
    const setAttribute = vi.spyOn(dom.window.Element.prototype, 'setAttribute').mockImplementation(() => {
      throw new Error('tampered Element.setAttribute')
    })
    const OriginalChannel = globalThis.MessageChannel
    vi.stubGlobal('MessageChannel', class {
      constructor() { throw new Error('tampered MessageChannel') }
    })
    try {
      const transport = environment.start({
        document: dom.window.document,
        token: 'a'.repeat(32),
        iframeSandbox: 'allow-scripts',
        iframeSrcdoc: '<!doctype html><html></html>',
        bootstrapSource: 'void 0',
        artifactSource: 'void 0',
        config: null,
      })
      expect(dom.window.document.querySelector('iframe[sandbox="allow-scripts"]')).not.toBeNull()
      transport.destroy()
      expect(dom.window.document.querySelector('iframe[sandbox="allow-scripts"]')).toBeNull()
    } finally {
      createElement.mockRestore()
      setAttribute.mockRestore()
      vi.stubGlobal('MessageChannel', OriginalChannel)
      dom.window.close()
    }
  })

  it('rejects non-JSON configuration and oversized artifacts before creating a frame', () => {
    const dom = new JSDOM('<body></body>')
    const environment = new FakeEnvironment()
    const hostDom = client()
    expect(() => createHostDomWorkerBoundary({
      document: dom.window.document,
      artifactSource: 'globalThis.__cordisxHostDomPluginModuleV1 = { apply() {} }',
      config: { callback: () => {} },
      hostDom,
      environment,
    })).toThrow('JSON values only')
    expect(environment.input).toBeUndefined()

    expect(() => createHostDomWorkerBoundary({
      document: dom.window.document,
      artifactSource: 'x'.repeat(8 * 1024 * 1024 + 1),
      hostDom,
      environment,
    })).toThrow('8 MiB')
    expect(environment.input).toBeUndefined()
    dom.window.close()
  })
})
