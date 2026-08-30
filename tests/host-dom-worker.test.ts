import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import type {
  BoundHostDomClient,
  HostDomBridgeRequest,
  HostDomBridgeResult,
  HostDomRootCatalog,
} from '@cordisx/protocol/host-dom/v1'
import {
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
  readonly listeners = new Set<(message: unknown) => void>()
  terminated = false
  destroyed = false

  post = (message: unknown): void => { this.posted.push(message) }
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

function status(status: 'ready' | 'disposed') {
  return { contract: WORKER_MESSAGE, type: 'status', status }
}

async function waitForPosted(transport: FakeTransport, count: number): Promise<void> {
  await vi.waitFor(() => expect(transport.posted.length).toBeGreaterThanOrEqual(count))
}

describe('Host DOM worker boundary', () => {
  it('defines an opaque sandbox iframe and a separately loaded, locked-down Blob worker', async () => {
    const dom = new JSDOM('<body></body>')
    const environment = new FakeEnvironment()
    const hostDom = client()
    const artifact = `globalThis.__cordisxPluginModule = { apply({ hostDom, onDispose }, config) {
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
    expect(bootstrap).toContain('applyFunction(pluginModule.apply, pluginModule, [freeze({ hostDom, onDispose }), config])')
    expect(bootstrap).toContain("plugin apply must return void or Promise<void>")

    environment.transport.emit(status('ready'))
    await boundary.ready
    expect(boundary.status()).toEqual({ status: 'ready' })
    expect(statuses).toEqual(['starting', 'ready'])

    const disposal = boundary.dispose()
    expect(environment.transport.posted).toContainEqual({ contract: WORKER_MESSAGE, type: 'dispose' })
    environment.transport.emit(status('disposed'))
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
      artifactSource: 'globalThis.__cordisxPluginModule = { apply() {} }',
      hostDom,
      environment,
    })
    environment.transport.emit(status('ready'))
    await boundary.ready

    environment.transport.emit({
      contract: WORKER_MESSAGE,
      type: 'rpc',
      sequence: 1,
      requestId: 'rpc-catalog-1',
      method: 'catalog',
    })
    await waitForPosted(environment.transport, 1)
    expect(hostDom.catalog).toHaveBeenCalledTimes(1)
    expect(environment.transport.posted[0]).toEqual({
      contract: WORKER_MESSAGE,
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
    environment.transport.emit({
      contract: WORKER_MESSAGE,
      type: 'rpc',
      sequence: 2,
      requestId: request.requestId,
      method: 'request',
      payload: request,
    })
    await waitForPosted(environment.transport, 2)
    expect(hostDom.request).toHaveBeenCalledWith(request)
    expect(environment.transport.posted[1]).toEqual({
      contract: WORKER_MESSAGE,
      type: 'rpc-result',
      sequence: 2,
      requestId: request.requestId,
      ok: true,
      value: released(request.requestId),
    })

    environment.transport.emit({
      contract: WORKER_MESSAGE,
      type: 'rpc',
      sequence: 3,
      requestId: 'rpc-dispose-3',
      method: 'dispose',
    })
    await waitForPosted(environment.transport, 3)
    expect(hostDom.dispose).toHaveBeenCalledTimes(1)
    expect(environment.transport.posted[2]).toEqual({
      contract: WORKER_MESSAGE,
      type: 'rpc-result',
      sequence: 3,
      requestId: 'rpc-dispose-3',
      ok: true,
      value: null,
    })

    const disposal = boundary.dispose()
    environment.transport.emit(status('disposed'))
    await disposal
    expect(hostDom.dispose).toHaveBeenCalledTimes(1)
    dom.window.close()
  })

  it('fails closed before Host dispatch on sequence, request-id, and envelope violations', async () => {
    const dom = new JSDOM('<body></body>')
    const environment = new FakeEnvironment()
    const hostDom = client()
    const statuses: string[] = []
    const boundary = createHostDomWorkerBoundary({
      document: dom.window.document,
      artifactSource: 'globalThis.__cordisxPluginModule = { apply() {} }',
      hostDom,
      environment,
      onStatus: value => statuses.push(value.status),
    })
    environment.transport.emit(status('ready'))
    await boundary.ready
    environment.transport.emit({
      contract: WORKER_MESSAGE,
      type: 'rpc',
      sequence: 2,
      requestId: 'out-of-order',
      method: 'catalog',
    })

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
      artifactSource: 'globalThis.__cordisxPluginModule = { apply() {} }',
      hostDom,
      environment,
    })
    environment.transport.emit(status('ready'))
    await boundary.ready
    environment.transport.emit({
      contract: WORKER_MESSAGE,
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
    })
    await waitForPosted(environment.transport, 1)
    expect(hostDom.request).not.toHaveBeenCalled()
    expect(environment.transport.posted[0]).toMatchObject({
      contract: WORKER_MESSAGE,
      type: 'rpc-result',
      sequence: 1,
      requestId: 'envelope-request-1',
      ok: false,
      error: expect.stringContaining('does not match'),
    })
    expect(boundary.status()).toEqual({ status: 'ready' })
    const disposal = boundary.dispose()
    environment.transport.emit(status('disposed'))
    await disposal
    dom.window.close()
  })

  it('rejects non-JSON configuration and oversized artifacts before creating a frame', () => {
    const dom = new JSDOM('<body></body>')
    const environment = new FakeEnvironment()
    const hostDom = client()
    expect(() => createHostDomWorkerBoundary({
      document: dom.window.document,
      artifactSource: 'globalThis.__cordisxPluginModule = { apply() {} }',
      config: { callback: () => {} },
      hostDom,
      environment,
    })).toThrow('JSON values only')
    expect(environment.input).toBeUndefined()

    expect(() => createHostDomWorkerBoundary({
      document: dom.window.document,
      artifactSource: 'x'.repeat(1024 * 1024 + 1),
      hostDom,
      environment,
    })).toThrow('1 MiB')
    expect(environment.input).toBeUndefined()
    dom.window.close()
  })
})
