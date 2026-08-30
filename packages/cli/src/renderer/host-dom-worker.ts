import type {
  BoundHostDomClient,
  HostDomBridgeRequest,
  HostDomBridgeResult,
  HostDomRootCatalog,
} from '@cordisx/protocol/host-dom/v1'

const FRAME_MESSAGE = 'cordisx.host-dom-worker-frame/v1'
const WORKER_MESSAGE = 'cordisx.host-dom-worker/v1'
const MAX_ARTIFACT_BYTES = 1024 * 1024
const MAX_CONFIG_BYTES = 64 * 1024
const MAX_RPC_BYTES = 128 * 1024
const MAX_INFLIGHT = 16
const MAX_REQUESTS = 4096
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000
const DEFAULT_DISPOSE_TIMEOUT_MS = 1_000

export const HOST_DOM_WORKER_IFRAME_CSP = [
  "default-src 'none'",
  "connect-src 'none'",
  "img-src 'none'",
  "media-src 'none'",
  "font-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "style-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "worker-src blob:",
  "script-src 'unsafe-inline' blob:",
].join('; ')

export type HostDomWorkerStatus =
  | Readonly<{ status: 'starting' }>
  | Readonly<{ status: 'ready' }>
  | Readonly<{ status: 'error'; error: string }>
  | Readonly<{ status: 'disposed' }>

export interface HostDomWorkerTransportInput {
  readonly document: Document
  readonly token: string
  readonly iframeSandbox: 'allow-scripts'
  readonly iframeSrcdoc: string
  readonly bootstrapSource: string
  readonly artifactSource: string
  readonly config: unknown
}

export interface HostDomWorkerTransport {
  readonly post: (message: unknown) => void
  readonly subscribe: (listener: (message: unknown) => void) => () => void
  readonly terminate: () => void
  readonly destroy: () => void
}

export interface HostDomWorkerEnvironment {
  readonly start: (input: HostDomWorkerTransportInput) => HostDomWorkerTransport
}

export interface HostDomWorkerBoundaryOptions {
  readonly document: Document
  readonly artifactSource: string
  readonly config?: unknown
  /** This client remains in the Host renderer and is never transferred to the worker. */
  readonly hostDom: BoundHostDomClient
  readonly environment?: HostDomWorkerEnvironment
  readonly startupTimeoutMs?: number
  readonly disposeTimeoutMs?: number
  readonly onStatus?: (status: HostDomWorkerStatus) => void
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every(key => keys.includes(key))
}

function byteSize(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function jsonSnapshot(value: unknown, maximumBytes: number): unknown {
  const seen = new Set<object>()
  let entries = 0
  const validate = (candidate: unknown, depth: number): void => {
    if (depth > 32 || entries > 8192) throw new Error('serializable payload exceeds structural limits')
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new Error('serializable payload contains a non-finite number')
      return
    }
    if (typeof candidate !== 'object') throw new Error('payload must contain JSON values only')
    if (seen.has(candidate)) throw new Error('serializable payload must not contain cycles')
    seen.add(candidate)
    entries += 1
    if (Array.isArray(candidate)) {
      for (const child of candidate) validate(child, depth + 1)
    } else {
      const prototype = Object.getPrototypeOf(candidate)
      if (prototype !== Object.prototype && prototype !== null) throw new Error('payload must contain plain objects only')
      for (const child of Object.values(candidate)) validate(child, depth + 1)
    }
    seen.delete(candidate)
  }
  validate(value, 0)
  const serialized = JSON.stringify(value)
  if (serialized === undefined || byteSize(serialized) > maximumBytes) throw new Error('serializable payload exceeds byte limit')
  return JSON.parse(serialized) as unknown
}

function boundedRequestId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
}

function boundedError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value)
  return message.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 512) || 'Host DOM worker failed'
}

function token(): string {
  const bytes = new Uint32Array(4)
  if (typeof globalThis.crypto?.getRandomValues !== 'function') throw new Error('secure randomness is required for Host DOM worker isolation')
  globalThis.crypto.getRandomValues(bytes)
  return [...bytes].map(value => value.toString(16).padStart(8, '0')).join('')
}

function iframeSource(): string {
  const script = `(() => {
    'use strict'
    let activeToken
    let worker
    let bootstrapUrl
    let artifactUrl
    const clearUrl = (value) => { if (value) URL.revokeObjectURL(value) }
    const terminate = () => {
      worker?.terminate()
      worker = undefined
      clearUrl(bootstrapUrl); clearUrl(artifactUrl)
      bootstrapUrl = undefined; artifactUrl = undefined
    }
    addEventListener('message', (event) => {
      if (event.source !== parent || !event.data || event.data.contract !== '${FRAME_MESSAGE}') return
      const data = event.data
      if (data.type === 'terminate') {
        if (typeof activeToken === 'string' && data.token === activeToken) terminate()
        return
      }
      if (data.type !== 'start' || worker || typeof data.token !== 'string'
        || typeof data.bootstrapSource !== 'string' || typeof data.artifactSource !== 'string'
        || event.ports.length !== 1) return
      activeToken = data.token
      bootstrapUrl = URL.createObjectURL(new Blob([data.bootstrapSource], { type: 'text/javascript' }))
      artifactUrl = URL.createObjectURL(new Blob([data.artifactSource], { type: 'text/javascript' }))
      worker = new Worker(bootstrapUrl, { type: 'classic', name: 'cordisx-host-dom-plugin' })
      worker.addEventListener('message', (workerEvent) => {
        if (workerEvent.data?.contract === '${WORKER_MESSAGE}' && workerEvent.data.type === 'artifact-loaded') {
          clearUrl(artifactUrl); artifactUrl = undefined
        }
      })
      worker.postMessage({ contract: '${WORKER_MESSAGE}', type: 'initialize', artifactUrl, config: data.config }, event.ports)
      clearUrl(bootstrapUrl); bootstrapUrl = undefined
    })
    addEventListener('unload', terminate, { once: true })
  })()`
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HOST_DOM_WORKER_IFRAME_CSP}"></head><body><script>${script}</script></body></html>`
}

function workerBootstrapSource(): string {
  return `(() => {
    'use strict'
    const CONTRACT = ${JSON.stringify(WORKER_MESSAGE)}
    const MAX_RPC_BYTES = ${MAX_RPC_BYTES}
    const MAX_INFLIGHT = ${MAX_INFLIGHT}
    const MAX_REQUESTS = ${MAX_REQUESTS}
    const nativeImportScripts = globalThis.importScripts.bind(globalThis)
    const notifyOwner = globalThis.postMessage.bind(globalThis)
    const closeWorker = globalThis.close.bind(globalThis)
    const textEncoder = new globalThis.TextEncoder()
    const encode = textEncoder.encode.bind(textEncoder)
    const jsonStringify = globalThis.JSON.stringify.bind(globalThis.JSON)
    const jsonParse = globalThis.JSON.parse.bind(globalThis.JSON)
    const arrayIsArray = globalThis.Array.isArray.bind(globalThis.Array)
    const objectValues = globalThis.Object.values.bind(globalThis.Object)
    const objectPrototype = globalThis.Object.getPrototypeOf.bind(globalThis.Object)
    const objectDescriptor = globalThis.Object.getOwnPropertyDescriptor.bind(globalThis.Object)
    const defineProperty = globalThis.Object.defineProperty.bind(globalThis.Object)
    const freeze = globalThis.Object.freeze.bind(globalThis.Object)
    const plainObjectPrototype = globalThis.Object.prototype
    const applyFunction = globalThis.Reflect.apply.bind(globalThis.Reflect)
    const NativeError = globalThis.Error
    const NativeMap = globalThis.Map
    const NativePromise = globalThis.Promise
    const NativeSet = globalThis.Set
    const messagePortPrototype = globalThis.MessagePort?.prototype
    const promiseReject = globalThis.Promise.reject.bind(globalThis.Promise)
    const promiseResolve = globalThis.Promise.resolve.bind(globalThis.Promise)
    const promiseThen = globalThis.Promise.prototype.then
    const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
    const requestIdTest = requestIdPattern.test.bind(requestIdPattern)
    let initialized = false
    const size = (value) => encode(jsonStringify(value)).byteLength
    const snapshot = (value) => {
      const seen = new NativeSet()
      let entries = 0
      const visit = (candidate, depth) => {
        if (depth > 32 || entries > 8192) throw new Error('serializable payload exceeds structural limits')
        if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return
        if (typeof candidate === 'number') { if (!Number.isFinite(candidate)) throw new Error('non-finite number'); return }
        if (typeof candidate !== 'object') throw new Error('JSON values only')
        if (seen.has(candidate)) throw new Error('cycles are unavailable')
        seen.add(candidate); entries += 1
        if (arrayIsArray(candidate)) for (const child of candidate) visit(child, depth + 1)
        else {
          const prototype = objectPrototype(candidate)
          if (prototype !== plainObjectPrototype && prototype !== null) throw new NativeError('plain objects only')
          for (const child of objectValues(candidate)) visit(child, depth + 1)
        }
        seen.delete(candidate)
      }
      visit(value, 0)
      const serialized = jsonStringify(value)
      if (serialized === undefined || encode(serialized).byteLength > MAX_RPC_BYTES) throw new NativeError('payload exceeds byte limit')
      return jsonParse(serialized)
    }
    const requestId = (value) => typeof value === 'string' && value.length <= 128 && requestIdTest(value)
    const lockdown = () => {
      const denied = () => { throw new NativeError('ambient worker capability is unavailable') }
      const blockedFunctions = ['fetch', 'importScripts', 'postMessage', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'eval', 'close']
      const blockedConstructors = ['Worker', 'SharedWorker', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'WebTransport', 'BroadcastChannel', 'MessageChannel', 'MessagePort', 'Function']
      const lockValue = (target, name, value) => {
        defineProperty(target, name, { configurable: false, enumerable: false, writable: false, value })
        if (objectDescriptor(target, name)?.value !== value) throw new NativeError('worker lockdown failed for ' + name)
      }
      for (let prototype = objectPrototype(globalThis); prototype !== null; prototype = objectPrototype(prototype)) {
        for (const name of blockedFunctions) if (objectDescriptor(prototype, name) !== undefined) lockValue(prototype, name, denied)
        if (objectDescriptor(prototype, 'onmessage') !== undefined) lockValue(prototype, 'onmessage', null)
      }
      if (messagePortPrototype) {
        for (const name of ['postMessage', 'start', 'close', 'addEventListener', 'removeEventListener']) {
          if (objectDescriptor(messagePortPrototype, name) !== undefined) lockValue(messagePortPrototype, name, denied)
        }
      }
      for (const name of blockedFunctions) {
        lockValue(globalThis, name, denied)
      }
      for (const name of blockedConstructors) {
        lockValue(globalThis, name, undefined)
      }
      for (const name of ['require', 'process', 'module', 'document', 'window']) {
        lockValue(globalThis, name, undefined)
      }
      lockValue(globalThis, 'onmessage', null)
    }
    globalThis.onmessage = (event) => {
      if (initialized || !event.data || event.data.contract !== CONTRACT || event.data.type !== 'initialize'
        || typeof event.data.artifactUrl !== 'string' || event.ports.length !== 1) return
      initialized = true
      const port = event.ports[0]
      const portPost = port.postMessage.bind(port)
      const portClose = port.close.bind(port)
      const portStart = port.start?.bind(port)
      const post = (message) => {
        if (size(message) > MAX_RPC_BYTES) throw new NativeError('RPC envelope exceeds byte limit')
        portPost(message)
      }
      let sequence = 0
      let accepting = true
      let disposing = false
      const pending = new NativeMap()
      const pendingGet = pending.get.bind(pending)
      const pendingSet = pending.set.bind(pending)
      const pendingDelete = pending.delete.bind(pending)
      const pendingValues = pending.values.bind(pending)
      const pendingClear = pending.clear.bind(pending)
      let pendingCount = 0
      const cleanups = []
      const fail = (error) => {
        const message = String(error?.message ?? error ?? 'Host DOM worker failed').replace(/[\\u0000-\\u001f\\u007f]/g, ' ').slice(0, 512)
        try { post({ contract: CONTRACT, type: 'status', status: 'error', error: message }) } catch {}
      }
      const rpc = (method, payload, explicitRequestId) => {
        if (!accepting) return promiseReject(new NativeError('Host DOM client is disposed'))
        if (pendingCount >= MAX_INFLIGHT || sequence >= MAX_REQUESTS) return promiseReject(new NativeError('Host DOM RPC limit reached'))
        const next = ++sequence
        const id = explicitRequestId ?? 'rpc-' + method + '-' + next
        if (!requestId(id)) return promiseReject(new NativeError('invalid Host DOM request id'))
        const envelope = { contract: CONTRACT, type: 'rpc', sequence: next, requestId: id, method }
        if (payload !== undefined) envelope.payload = snapshot(payload)
        return new NativePromise((resolve, reject) => {
          pendingSet(next, { requestId: id, resolve, reject }); pendingCount += 1
          try { post(envelope) } catch (error) { pendingDelete(next); pendingCount -= 1; reject(error) }
        })
      }
      port.onmessage = (portEvent) => {
        const message = portEvent.data
        if (!message || message.contract !== CONTRACT) return
        if (message.type === 'rpc-result') {
          const item = pendingGet(message.sequence)
          if (!item || item.requestId !== message.requestId) return
          pendingDelete(message.sequence); pendingCount -= 1
          if (message.ok === true) item.resolve(snapshot(message.value))
          else item.reject(new NativeError(typeof message.error === 'string' ? message.error.slice(0, 512) : 'Host DOM RPC failed'))
          return
        }
        if (message.type !== 'dispose' || disposing) return
        disposing = true; accepting = false
        for (const item of pendingValues()) item.reject(new NativeError('Host DOM worker disposed'))
        pendingClear(); pendingCount = 0
        void (async () => {
          for (let index = cleanups.length - 1; index >= 0; index -= 1) {
            try { await cleanups[index]() } catch {}
          }
          try { post({ contract: CONTRACT, type: 'status', status: 'disposed' }) } catch {}
          portClose(); closeWorker()
        })()
      }
      portStart?.()
      lockdown()
      try {
        defineProperty(globalThis, '__cordisxPluginModule', { configurable: true, enumerable: false, writable: true, value: undefined })
        nativeImportScripts(event.data.artifactUrl)
        notifyOwner({ contract: CONTRACT, type: 'artifact-loaded' })
        const descriptor = objectDescriptor(globalThis, '__cordisxPluginModule')
        const pluginModule = descriptor?.value
        if (!descriptor?.configurable || !pluginModule || typeof pluginModule !== 'object' || typeof pluginModule.apply !== 'function') {
          throw new Error('artifact must provide configurable globalThis.__cordisxPluginModule.apply')
        }
        delete globalThis.__cordisxPluginModule
        defineProperty(globalThis, '__cordisxPluginModule', { configurable: false, enumerable: false, writable: false, value: undefined })
        const hostDom = freeze({
          catalog: () => rpc('catalog'),
          request: (request) => rpc('request', request, request?.requestId),
          dispose: () => { if (accepting) void rpc('dispose').catch(() => {}); accepting = false },
        })
        const onDispose = (cleanup) => {
          if (!accepting || typeof cleanup !== 'function' || cleanups.length >= 32) throw new NativeError('invalid cleanup registration')
          cleanups[cleanups.length] = async () => { const result = cleanup(); if (result !== undefined && !(result instanceof NativePromise)) throw new NativeError('cleanup must return void or Promise<void>'); await result }
        }
        const config = snapshot(event.data.config)
        const applied = promiseResolve(applyFunction(pluginModule.apply, pluginModule, [freeze({ hostDom, onDispose }), config]))
        applyFunction(promiseThen, applied, [(result) => {
          if (result !== undefined) throw new NativeError('plugin apply must return void or Promise<void>')
          post({ contract: CONTRACT, type: 'status', status: 'ready' })
        }, fail])
      } catch (error) { fail(error) }
    }
  })()`
}

function browserEnvironment(): HostDomWorkerEnvironment {
  return {
    start(input) {
      const frame = input.document.createElement('iframe')
      frame.hidden = true
      frame.setAttribute('aria-hidden', 'true')
      frame.setAttribute('tabindex', '-1')
      frame.setAttribute('sandbox', input.iframeSandbox)
      frame.srcdoc = input.iframeSrcdoc
      const Channel = globalThis.MessageChannel
      if (typeof Channel !== 'function') throw new Error('MessageChannel is required for Host DOM worker isolation')
      const channel = new Channel()
      let started = false
      let destroyed = false
      const start = () => {
        if (started || destroyed || frame.contentWindow === null) return
        started = true
        frame.contentWindow.postMessage({
          contract: FRAME_MESSAGE,
          type: 'start',
          token: input.token,
          bootstrapSource: input.bootstrapSource,
          artifactSource: input.artifactSource,
          config: input.config,
        }, '*', [channel.port2])
      }
      frame.addEventListener('load', start, { once: true })
      ;(input.document.body ?? input.document.documentElement).append(frame)
      const listeners = new Set<(message: unknown) => void>()
      channel.port1.onmessage = event => { for (const listener of listeners) listener(event.data) }
      channel.port1.start()
      return {
        post: message => channel.port1.postMessage(message),
        subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
        terminate: () => frame.contentWindow?.postMessage({ contract: FRAME_MESSAGE, type: 'terminate', token: input.token }, '*'),
        destroy: () => {
          if (destroyed) return
          destroyed = true
          frame.removeEventListener('load', start)
          listeners.clear()
          channel.port1.close()
          try { channel.port2.close() } catch {}
          frame.remove()
        },
      }
    },
  }
}

export class HostDomWorkerBoundary {
  readonly ready: Promise<void>
  private currentStatus: HostDomWorkerStatus = Object.freeze({ status: 'starting' })
  private readonly listeners = new Set<(status: HostDomWorkerStatus) => void>()
  private readonly transport: HostDomWorkerTransport
  private readonly releaseTransportListener: () => void
  private readonly seenRequestIds = new Set<string>()
  private expectedSequence = 1
  private inflight = 0
  private startupTimer: ReturnType<typeof setTimeout> | undefined
  private disposedSignal: (() => void) | undefined
  private disposePromise: Promise<void> | undefined
  private clientDisposed = false
  private resourcesDestroyed = false
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void

  constructor(private readonly options: HostDomWorkerBoundaryOptions) {
    if (typeof options.artifactSource !== 'string' || byteSize(options.artifactSource) > MAX_ARTIFACT_BYTES) {
      throw new Error('Host DOM worker artifact exceeds the 1 MiB source limit')
    }
    const config = jsonSnapshot(options.config ?? null, MAX_CONFIG_BYTES)
    this.ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
    this.transport = (options.environment ?? browserEnvironment()).start({
      document: options.document,
      token: token(),
      iframeSandbox: 'allow-scripts',
      iframeSrcdoc: iframeSource(),
      bootstrapSource: workerBootstrapSource(),
      artifactSource: options.artifactSource,
      config,
    })
    this.releaseTransportListener = this.transport.subscribe(message => { void this.receive(message) })
    this.listeners.add(options.onStatus ?? (() => {}))
    options.onStatus?.(this.currentStatus)
    const timeout = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    this.startupTimer = setTimeout(() => this.fail('Host DOM worker startup timed out'), timeout)
  }

  status(): HostDomWorkerStatus {
    return this.currentStatus
  }

  subscribe(listener: (status: HostDomWorkerStatus) => void): () => void {
    this.listeners.add(listener)
    listener(this.currentStatus)
    return () => this.listeners.delete(listener)
  }

  async dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise
    this.disposePromise = this.disposeInternal()
    return this.disposePromise
  }

  private async receive(value: unknown): Promise<void> {
    if (this.resourcesDestroyed) return
    let message: Record<string, unknown> | undefined
    try {
      if (byteSize(JSON.stringify(value)) > MAX_RPC_BYTES) throw new Error('worker message exceeds byte limit')
      message = record(value)
    } catch {
      message = undefined
    }
    if (message === undefined || message.contract !== WORKER_MESSAGE || typeof message.type !== 'string') {
      this.fail('Host DOM worker sent an invalid envelope')
      return
    }
    if (message.type === 'status') {
      if (message.status === 'ready' && exact(message, ['contract', 'type', 'status']) && this.currentStatus.status === 'starting') {
        this.clearStartupTimer()
        this.setStatus({ status: 'ready' })
        this.resolveReady()
        return
      }
      if (message.status === 'error' && exact(message, ['contract', 'type', 'status', 'error']) && typeof message.error === 'string') {
        this.fail(message.error)
        return
      }
      if (message.status === 'disposed' && exact(message, ['contract', 'type', 'status'])) {
        this.disposedSignal?.()
        return
      }
      this.fail('Host DOM worker sent an invalid status')
      return
    }
    if (message.type !== 'rpc') {
      this.fail('Host DOM worker sent an unknown message')
      return
    }
    try { await this.rpc(message) } catch (error) { this.fail(error) }
  }

  private async rpc(message: Record<string, unknown>): Promise<void> {
    const method = message.method
    const keys = method === 'request' ? ['contract', 'type', 'sequence', 'requestId', 'method', 'payload'] : ['contract', 'type', 'sequence', 'requestId', 'method']
    if (!exact(message, keys)
      || !Number.isSafeInteger(message.sequence) || message.sequence !== this.expectedSequence
      || !boundedRequestId(message.requestId) || this.seenRequestIds.has(message.requestId)
      || typeof method !== 'string' || !['catalog', 'request', 'dispose'].includes(method)
      || this.expectedSequence > MAX_REQUESTS || this.inflight >= MAX_INFLIGHT) {
      this.fail('Host DOM worker violated RPC sequence or request bounds')
      return
    }
    const sequence = message.sequence as number
    const requestId = message.requestId
    this.expectedSequence += 1
    this.seenRequestIds.add(requestId)
    this.inflight += 1
    try {
      let result: HostDomRootCatalog | HostDomBridgeResult | null
      if (method === 'catalog') {
        result = await this.options.hostDom.catalog()
      } else if (method === 'request') {
        const payload = jsonSnapshot(message.payload, MAX_RPC_BYTES) as HostDomBridgeRequest
        if (record(payload)?.requestId !== requestId) throw new Error('Host DOM request id does not match its RPC envelope')
        result = await this.options.hostDom.request(payload)
      } else {
        this.disposeClient()
        result = null
      }
      this.respond({ contract: WORKER_MESSAGE, type: 'rpc-result', sequence, requestId, ok: true, value: jsonSnapshot(result, MAX_RPC_BYTES) })
    } catch (error) {
      this.respond({ contract: WORKER_MESSAGE, type: 'rpc-result', sequence, requestId, ok: false, error: boundedError(error) })
    } finally {
      this.inflight -= 1
    }
  }

  private respond(message: unknown): void {
    if (this.resourcesDestroyed) return
    const snapshot = jsonSnapshot(message, MAX_RPC_BYTES)
    this.transport.post(snapshot)
  }

  private fail(error: unknown): void {
    if (this.currentStatus.status === 'error' || this.currentStatus.status === 'disposed') return
    const message = boundedError(error)
    this.clearStartupTimer()
    if (this.currentStatus.status === 'starting') this.rejectReady(new Error(message))
    this.setStatus({ status: 'error', error: message })
    this.destroyResources()
  }

  private async disposeInternal(): Promise<void> {
    if (this.currentStatus.status === 'disposed') return
    this.clearStartupTimer()
    if (this.currentStatus.status === 'starting') this.rejectReady(new Error('Host DOM worker disposed before becoming ready'))
    if (!this.resourcesDestroyed) {
      const disposed = new Promise<void>(resolve => { this.disposedSignal = resolve })
      try { this.transport.post({ contract: WORKER_MESSAGE, type: 'dispose' }) } catch {}
      const timeout = this.options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS
      await Promise.race([disposed, new Promise<void>(resolve => setTimeout(resolve, timeout))])
    }
    this.destroyResources()
    this.setStatus({ status: 'disposed' })
  }

  private destroyResources(): void {
    if (this.resourcesDestroyed) return
    this.resourcesDestroyed = true
    this.disposeClient()
    this.releaseTransportListener()
    this.transport.terminate()
    this.transport.destroy()
  }

  private disposeClient(): void {
    if (this.clientDisposed) return
    this.clientDisposed = true
    this.options.hostDom.dispose()
  }

  private clearStartupTimer(): void {
    if (this.startupTimer !== undefined) clearTimeout(this.startupTimer)
    this.startupTimer = undefined
  }

  private setStatus(status: HostDomWorkerStatus): void {
    this.currentStatus = Object.freeze(status)
    for (const listener of this.listeners) listener(this.currentStatus)
  }
}

export function createHostDomWorkerBoundary(options: HostDomWorkerBoundaryOptions): HostDomWorkerBoundary {
  return new HostDomWorkerBoundary(options)
}
