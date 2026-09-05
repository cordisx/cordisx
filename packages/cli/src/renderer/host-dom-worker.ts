import type {
  BoundHostDomClient,
  HostDomBridgeRequest,
  HostDomBridgeResult,
  HostDomRootCatalog,
} from '@cordisx/protocol/host-dom/v1'
import type { TransientCanvasRegistrationV1 } from '@cordisx/protocol/transient-canvas/v1'
import type { TransientCanvasStart, TransientCanvasWorkerSink } from './transient-canvas.js'

const FRAME_MESSAGE = 'cordisx.host-dom-worker-frame/v1'
const WORKER_MESSAGE = 'cordisx.host-dom-worker/v1'
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024
const MAX_CONFIG_BYTES = 64 * 1024
const MAX_RPC_BYTES = 128 * 1024
const MAX_INFLIGHT = 16
const MAX_REQUESTS = 4096
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000
const DEFAULT_DISPOSE_TIMEOUT_MS = 1_000
const TOKEN = /^[a-f0-9]{32}$/u

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
  'worker-src blob:',
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
  readonly interfaces: readonly ('ui.host-dom/v1' | 'ui.transient-canvas/v1')[]
}

export interface HostDomWorkerTransport {
  readonly post: (message: unknown, transfer?: readonly Transferable[]) => void
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
  readonly hostDom?: BoundHostDomClient
  readonly transientCanvas?: Readonly<{
    register(declaration: TransientCanvasRegistrationV1): Promise<void>
    unregister(id: string): Promise<void>
    dispose(): void
  }>
  /** Captured before plugin activation; activation-time global lookup is forbidden. */
  readonly environment: HostDomWorkerEnvironment
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
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('payload must contain plain objects only')
      }
      for (const child of Object.values(candidate)) validate(child, depth + 1)
    }
    seen.delete(candidate)
  }
  validate(value, 0)
  const serialized = JSON.stringify(value)
  if (serialized === undefined || byteSize(serialized) > maximumBytes) {
    throw new Error('serializable payload exceeds byte limit')
  }
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
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('secure randomness is required for Host DOM worker isolation')
  }
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
        if (workerEvent.data?.contract === '${WORKER_MESSAGE}' && workerEvent.data.token === activeToken
          && workerEvent.data.type === 'artifact-loaded') {
          clearUrl(artifactUrl); artifactUrl = undefined
        }
      })
      worker.postMessage({ contract: '${WORKER_MESSAGE}', token: activeToken, type: 'initialize', artifactUrl, config: data.config, interfaces: data.interfaces }, event.ports)
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
    const NativeAbortController = globalThis.AbortController
    const messagePortPrototype = globalThis.MessagePort?.prototype
    const promiseReject = globalThis.Promise.reject.bind(globalThis.Promise)
    const promiseResolve = globalThis.Promise.resolve.bind(globalThis.Promise)
    const promiseThen = globalThis.Promise.prototype.then
    const consoleFacade = freeze({
      debug: globalThis.console.debug.bind(globalThis.console),
      log: globalThis.console.log.bind(globalThis.console),
      info: globalThis.console.info.bind(globalThis.console),
      warn: globalThis.console.warn.bind(globalThis.console),
      error: globalThis.console.error.bind(globalThis.console),
    })
    const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
    const tokenPattern = /^[a-f0-9]{32}$/
    const requestIdTest = requestIdPattern.test.bind(requestIdPattern)
    const tokenTest = tokenPattern.test.bind(tokenPattern)
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
      const blockedConstructors = ['Worker', 'SharedWorker', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'WebTransport', 'RTCPeerConnection', 'BroadcastChannel', 'MessageChannel', 'MessagePort', 'Function']
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
        || typeof event.data.token !== 'string' || !tokenTest(event.data.token)
        || typeof event.data.artifactUrl !== 'string' || event.ports.length !== 1) return
      initialized = true
      const boundaryToken = event.data.token
      const port = event.ports[0]
      const portPost = port.postMessage.bind(port)
      const portClose = port.close.bind(port)
      const portStart = port.start?.bind(port)
      const post = (message) => {
        const envelope = { ...message, token: boundaryToken }
        if (size(envelope) > MAX_RPC_BYTES) throw new NativeError('RPC envelope exceeds byte limit')
        portPost(envelope)
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
      const canvasPresenters = new NativeMap()
      const canvasSessions = new NativeMap()
      const enabledInterfaces = new NativeSet(arrayIsArray(event.data.interfaces) ? event.data.interfaces : [])
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
        if (!message || message.contract !== CONTRACT || message.token !== boundaryToken) return
        if (message.type === 'rpc-result') {
          const item = pendingGet(message.sequence)
          if (!item || item.requestId !== message.requestId) return
          pendingDelete(message.sequence); pendingCount -= 1
          if (message.ok === true) item.resolve(snapshot(message.value))
          else item.reject(new NativeError(typeof message.error === 'string' ? message.error.slice(0, 512) : 'Host DOM RPC failed'))
          return
        }
        if (message.type === 'canvas-start') {
          const presenter = canvasPresenters.get(message.registrationId)
          if (typeof presenter !== 'function' || typeof message.sessionId !== 'string'
            || typeof message.width !== 'number' || typeof message.height !== 'number'
            || typeof message.pixelRatio !== 'number' || typeof message.reducedMotion !== 'boolean'
            || typeof message.startedAt !== 'number' || !message.canvas) return
          const controller = new NativeAbortController()
          canvasSessions.set(message.sessionId, controller)
          const session = freeze({
            canvas: message.canvas,
            width: message.width,
            height: message.height,
            pixelRatio: message.pixelRatio,
            reducedMotion: message.reducedMotion,
            startedAt: message.startedAt,
            signal: controller.signal,
          })
          promiseResolve(applyFunction(presenter, undefined, [session])).catch(fail)
          return
        }
        if (message.type === 'canvas-stop') {
          const controller = canvasSessions.get(message.sessionId)
          if (controller) { controller.abort(); canvasSessions.delete(message.sessionId) }
          return
        }
        if (message.type !== 'dispose' || disposing) return
        disposing = true; accepting = false
        for (const controller of canvasSessions.values()) controller.abort()
        canvasSessions.clear(); canvasPresenters.clear()
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
        const moduleKeys = ['__cordisxHostDomPluginModuleV1', '__cordisxPendingPluginModuleV1', '__cordisxPendingPluginModuleFactoryV1']
        for (const key of moduleKeys) defineProperty(globalThis, key, { configurable: true, enumerable: false, writable: true, value: undefined })
        nativeImportScripts(event.data.artifactUrl)
        notifyOwner({ contract: CONTRACT, token: boundaryToken, type: 'artifact-loaded' })
        const direct = objectDescriptor(globalThis, '__cordisxHostDomPluginModuleV1')
        const pending = objectDescriptor(globalThis, '__cordisxPendingPluginModuleV1')
        const factory = objectDescriptor(globalThis, '__cordisxPendingPluginModuleFactoryV1')
        if (moduleKeys.some(key => objectDescriptor(globalThis, key)?.configurable !== true)) {
          throw new Error('artifact module globals must remain Host-configurable')
        }
        const pluginModule = direct?.value ?? pending?.value
          ?? (typeof factory?.value === 'function' ? applyFunction(factory.value, undefined, [consoleFacade]) : undefined)
        for (const key of moduleKeys) {
          delete globalThis[key]
          defineProperty(globalThis, key, { configurable: false, enumerable: false, writable: false, value: undefined })
        }
        if (!pluginModule || typeof pluginModule !== 'object' || typeof pluginModule.apply !== 'function') {
          throw new Error('artifact must provide one Host-recognized plugin module with apply')
        }
        const hostDom = enabledInterfaces.has('ui.host-dom/v1') ? freeze({
          catalog: () => rpc('catalog'),
          request: (request) => rpc('request', request, request?.requestId),
          dispose: () => { if (accepting) void rpc('dispose').catch(() => {}); accepting = false },
        }) : undefined
        const transientCanvas = enabledInterfaces.has('ui.transient-canvas/v1') ? freeze({
          register: (declaration, presenter) => {
            const value = snapshot(declaration)
            if (!value || typeof value.id !== 'string' || typeof presenter !== 'function' || canvasPresenters.has(value.id)) {
              return promiseReject(new NativeError('invalid or duplicate transient canvas registration'))
            }
            canvasPresenters.set(value.id, presenter)
            return rpc('canvas-register', value).then(() => freeze({
              dispose: () => {
                if (!canvasPresenters.has(value.id)) return promiseResolve()
                canvasPresenters.delete(value.id)
                return rpc('canvas-unregister', { id: value.id })
              },
            }), (error) => { canvasPresenters.delete(value.id); throw error })
          },
        }) : undefined
        const onDispose = (cleanup) => {
          if (!accepting || typeof cleanup !== 'function' || cleanups.length >= 32) throw new NativeError('invalid cleanup registration')
          cleanups[cleanups.length] = async () => { const result = cleanup(); if (result !== undefined && !(result instanceof NativePromise)) throw new NativeError('cleanup must return void or Promise<void>'); await result }
        }
        const config = snapshot(event.data.config)
        const context = freeze({
          ...(hostDom === undefined ? {} : { hostDom }),
          ...(transientCanvas === undefined ? {} : { transientCanvas }),
          onDispose,
        })
        const applied = promiseResolve(applyFunction(pluginModule.apply, pluginModule, [context, config]))
        applyFunction(promiseThen, applied, [(result) => {
          if (result !== undefined) throw new NativeError('plugin apply must return void or Promise<void>')
          post({ contract: CONTRACT, type: 'status', status: 'ready' })
        }, fail])
      } catch (error) { fail(error) }
    }
  })()`
}

/**
 * Capture the browser transport primitives before any plugin artifact runs.
 * Dynamic plugin generations reuse this environment instead of reading
 * renderer globals or mutable DOM prototypes at activation time.
 */
export function createBrowserHostDomWorkerEnvironment(document: Document): HostDomWorkerEnvironment {
  const apply = Reflect.apply.bind(Reflect)
  const createElement = document.createElement
  const sampleFrame = apply(createElement, document, ['iframe']) as HTMLIFrameElement
  const setAttribute = sampleFrame.setAttribute
  const addEventListener = sampleFrame.addEventListener
  const removeEventListener = sampleFrame.removeEventListener
  const appendChild = document.documentElement.appendChild
  const removeChild = document.documentElement.removeChild
  const parentNodeDescriptor = (() => {
    for (let prototype: object | null = sampleFrame; prototype !== null; prototype = Object.getPrototypeOf(prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'parentNode')
      if (descriptor?.get !== undefined) return descriptor.get
    }
    return undefined
  })()
  const contentWindowDescriptor = (() => {
    for (let prototype: object | null = sampleFrame; prototype !== null; prototype = Object.getPrototypeOf(prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'contentWindow')
      if (descriptor?.get !== undefined) return descriptor.get
    }
    return undefined
  })()
  const Channel = globalThis.MessageChannel
  const view = document.defaultView
  if (
    typeof Channel !== 'function' || view === null || typeof view.postMessage !== 'function'
    || parentNodeDescriptor === undefined || contentWindowDescriptor === undefined
  ) {
    throw new Error('native browser primitives are required for Host DOM worker isolation')
  }
  const windowPostMessage = view.postMessage
  const sampleChannel = new Channel()
  const portPostMessage = sampleChannel.port1.postMessage
  const portAddEventListener = sampleChannel.port1.addEventListener
  const portRemoveEventListener = sampleChannel.port1.removeEventListener
  const portStart = sampleChannel.port1.start
  const portClose = sampleChannel.port1.close
  apply(portClose, sampleChannel.port1, [])
  apply(portClose, sampleChannel.port2, [])

  return {
    start(input) {
      if (input.document !== document || !TOKEN.test(input.token)) {
        throw new Error('Host DOM worker environment scope is invalid')
      }
      const frame = apply(createElement, document, ['iframe']) as HTMLIFrameElement
      apply(setAttribute, frame, ['hidden', ''])
      apply(setAttribute, frame, ['aria-hidden', 'true'])
      apply(setAttribute, frame, ['tabindex', '-1'])
      apply(setAttribute, frame, ['sandbox', input.iframeSandbox])
      apply(setAttribute, frame, ['srcdoc', input.iframeSrcdoc])
      const channel = new Channel()
      const listeners = new Set<(message: unknown) => void>()
      const receive = (event: MessageEvent): void => {
        for (const listener of listeners) listener(event.data)
      }
      apply(portAddEventListener, channel.port1, ['message', receive])
      apply(portStart, channel.port1, [])
      let started = false
      let destroyed = false
      const start = () => {
        const contentWindow = apply(contentWindowDescriptor, frame, []) as Window | null
        if (started || destroyed || contentWindow === null) return
        started = true
        apply(windowPostMessage, contentWindow, [
          {
            contract: FRAME_MESSAGE,
            type: 'start',
            token: input.token,
            bootstrapSource: input.bootstrapSource,
            artifactSource: input.artifactSource,
            config: input.config,
            interfaces: input.interfaces,
          },
          '*',
          [channel.port2],
        ])
      }
      apply(addEventListener, frame, ['load', start, { once: true }])
      apply(appendChild, input.document.body ?? input.document.documentElement, [frame])
      return {
        post: (message, transfer = []) => {
          apply(portPostMessage, channel.port1, [message, transfer])
        },
        subscribe: listener => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        terminate: () => {
          const contentWindow = apply(contentWindowDescriptor, frame, []) as Window | null
          if (contentWindow !== null) {
            apply(windowPostMessage, contentWindow, [
              { contract: FRAME_MESSAGE, type: 'terminate', token: input.token },
              '*',
            ])
          }
        },
        destroy: () => {
          if (destroyed) return
          destroyed = true
          apply(removeEventListener, frame, ['load', start])
          apply(portRemoveEventListener, channel.port1, ['message', receive])
          listeners.clear()
          apply(portClose, channel.port1, [])
          try {
            apply(portClose, channel.port2, [])
          } catch {}
          const parent = apply(parentNodeDescriptor, frame, []) as Node | null
          if (parent !== null) apply(removeChild, parent, [frame])
        },
      }
    },
  }
}

export class HostDomWorkerBoundary {
  readonly ready: Promise<void>
  private readonly boundaryToken: string
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
      throw new Error('Host DOM worker artifact exceeds the 8 MiB source limit')
    }
    const config = jsonSnapshot(options.config ?? null, MAX_CONFIG_BYTES)
    this.boundaryToken = token()
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.transport = options.environment.start({
      document: options.document,
      token: this.boundaryToken,
      iframeSandbox: 'allow-scripts',
      iframeSrcdoc: iframeSource(),
      bootstrapSource: workerBootstrapSource(),
      artifactSource: options.artifactSource,
      config,
      interfaces: Object.freeze([
        ...(options.hostDom === undefined ? [] : ['ui.host-dom/v1' as const]),
        ...(options.transientCanvas === undefined ? [] : ['ui.transient-canvas/v1' as const]),
      ]),
    })
    this.releaseTransportListener = this.transport.subscribe(message => {
      void this.receive(message)
    })
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

  startTransientCanvas(input: TransientCanvasStart): void {
    if (this.currentStatus.status !== 'ready') throw new Error('isolated plugin worker is not ready')
    this.transport.post({
      contract: WORKER_MESSAGE,
      token: this.boundaryToken,
      type: 'canvas-start',
      sessionId: input.sessionId,
      registrationId: input.registrationId,
      canvas: input.canvas,
      width: input.width,
      height: input.height,
      pixelRatio: input.pixelRatio,
      reducedMotion: input.reducedMotion,
      startedAt: input.startedAt,
    }, [input.canvas])
  }

  stopTransientCanvas(sessionId: string): void {
    if (this.currentStatus.status !== 'ready') return
    this.transport.post({ contract: WORKER_MESSAGE, token: this.boundaryToken, type: 'canvas-stop', sessionId })
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
    if (
      message === undefined || message.contract !== WORKER_MESSAGE
      || message.token !== this.boundaryToken || typeof message.type !== 'string'
    ) {
      this.fail('Host DOM worker sent an invalid envelope')
      return
    }
    if (message.type === 'status') {
      if (
        message.status === 'ready' && exact(message, ['contract', 'token', 'type', 'status'])
        && this.currentStatus.status === 'starting'
      ) {
        this.clearStartupTimer()
        this.setStatus({ status: 'ready' })
        this.resolveReady()
        return
      }
      if (
        message.status === 'error' && exact(message, ['contract', 'token', 'type', 'status', 'error'])
        && typeof message.error === 'string'
      ) {
        this.fail(message.error)
        return
      }
      if (message.status === 'disposed' && exact(message, ['contract', 'token', 'type', 'status'])) {
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
    try {
      await this.rpc(message)
    } catch (error) {
      this.fail(error)
    }
  }

  private async rpc(message: Record<string, unknown>): Promise<void> {
    const method = message.method
    const keys = ['request', 'canvas-register', 'canvas-unregister'].includes(String(method))
      ? ['contract', 'token', 'type', 'sequence', 'requestId', 'method', 'payload']
      : ['contract', 'token', 'type', 'sequence', 'requestId', 'method']
    if (
      !exact(message, keys)
      || !Number.isSafeInteger(message.sequence) || message.sequence !== this.expectedSequence
      || !boundedRequestId(message.requestId) || this.seenRequestIds.has(message.requestId)
      || typeof method !== 'string'
      || !['catalog', 'request', 'dispose', 'canvas-register', 'canvas-unregister'].includes(method)
      || this.expectedSequence > MAX_REQUESTS || this.inflight >= MAX_INFLIGHT
    ) {
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
        if (this.options.hostDom === undefined) throw new Error('Host DOM interface is unavailable')
        result = await this.options.hostDom.catalog()
      } else if (method === 'request') {
        if (this.options.hostDom === undefined) throw new Error('Host DOM interface is unavailable')
        const payload = jsonSnapshot(message.payload, MAX_RPC_BYTES) as HostDomBridgeRequest
        if (record(payload)?.requestId !== requestId) {
          throw new Error('Host DOM request id does not match its RPC envelope')
        }
        result = await this.options.hostDom.request(payload)
      } else if (method === 'canvas-register') {
        if (this.options.transientCanvas === undefined) throw new Error('transient canvas interface is unavailable')
        const payload = jsonSnapshot(message.payload, MAX_RPC_BYTES) as TransientCanvasRegistrationV1
        await this.options.transientCanvas.register(payload)
        result = null
      } else if (method === 'canvas-unregister') {
        if (this.options.transientCanvas === undefined) throw new Error('transient canvas interface is unavailable')
        const payload = jsonSnapshot(message.payload, MAX_RPC_BYTES) as { readonly id?: unknown }
        if (typeof payload.id !== 'string') throw new Error('transient canvas registration id is invalid')
        await this.options.transientCanvas.unregister(payload.id)
        result = null
      } else {
        this.disposeClient()
        result = null
      }
      this.respond({
        contract: WORKER_MESSAGE,
        token: this.boundaryToken,
        type: 'rpc-result',
        sequence,
        requestId,
        ok: true,
        value: jsonSnapshot(result, MAX_RPC_BYTES),
      })
    } catch (error) {
      this.respond({
        contract: WORKER_MESSAGE,
        token: this.boundaryToken,
        type: 'rpc-result',
        sequence,
        requestId,
        ok: false,
        error: boundedError(error),
      })
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
    if (this.currentStatus.status === 'starting') {
      this.rejectReady(new Error('Host DOM worker disposed before becoming ready'))
    }
    if (!this.resourcesDestroyed) {
      const disposed = new Promise<void>(resolve => {
        this.disposedSignal = resolve
      })
      try {
        this.transport.post({ contract: WORKER_MESSAGE, token: this.boundaryToken, type: 'dispose' })
      } catch {}
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
    this.options.hostDom?.dispose()
    this.options.transientCanvas?.dispose()
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

export type IsolatedPluginWorkerBoundary = HostDomWorkerBoundary
export type IsolatedPluginWorkerSink = TransientCanvasWorkerSink
