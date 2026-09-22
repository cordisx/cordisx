import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import { CDP_REQUEST_TIMEOUT_MS } from './cdp-session.js'

const SHA256 = /^[a-f0-9]{64}$/u
const ACKNOWLEDGEMENT_POLL_MS = 25

export const CODEX_BUILD_8109_NATIVE_RESOURCE_PINS = Object.freeze({
  appInitial: Object.freeze({
    url: 'app://-/assets/app-initial-cadb12d4a15e.js',
    sha256: '73594359b28d81b6fcc9a52aac808f6a2e9fc32ced661adb3e23d297827b9285',
  }),
  appPrimary: Object.freeze({
    url: 'app://-/assets/app-primary-6cd7b8b3f5e3.js',
    sha256: '35d81a22c75f5a44b58baee0c0045ba6bb36cc9b387f43fab82178b4a2236849',
  }),
})

export interface NativeResourceInterceptionSession {
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  onEvent(method: string, listener: (params: Record<string, unknown>) => void): () => void
}

export interface NativeResourceTransformResult {
  /** Complete replacement source. A rejects transforms that do not report one unique anchor. */
  readonly source: string
  readonly anchorMatches: number
  /** Must return true only after this exact transformed resource has executed. */
  readonly acknowledgementExpression: string
  /** Must synchronously remove or disable the transform's renderer-owned authority. */
  readonly fenceExpression: string
}

export interface NativeResourceTransform {
  readonly url: string
  readonly sha256: string
  readonly transform: (source: string) => NativeResourceTransformResult
  /** Defaults to true. Lazy transforms remain intercepted but do not block document readiness. */
  readonly requiredForDocumentReady?: boolean
}

export type NativeResourceInterceptionStatus = 'installing' | 'active' | 'unavailable' | 'disposed'

export interface NativeResourceEvidence {
  readonly url: string
  readonly expectedSha256: string
  observedSha256?: string
  transformedSha256?: string
  state: 'pending' | 'fulfilled' | 'acknowledged' | 'unavailable'
  reason?: string
}

export interface NativeResourceInterception {
  readonly target: Readonly<{ id: string; url: string }>
  /** Remains false until the coordinator wires and proves the complete managed runtime. */
  readonly managedRuntimeFlag: false
  readonly evidence: readonly NativeResourceEvidence[]
  readonly status: NativeResourceInterceptionStatus
  dispose(): Promise<void>
}

export interface NativeResourceInterceptionOptions {
  readonly session: NativeResourceInterceptionSession
  readonly target: Readonly<{ id: string; url: string }>
  readonly transforms: readonly NativeResourceTransform[]
  /**
   * Fetch interception is listening and enabled before this exact-document transition runs.
   * Omit it to arm interception for the next natural top-level navigation without replacing
   * an already interactive document.
   */
  readonly reloadDocument?: () => Promise<void>
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly onStatusChange?: (
    status: NativeResourceInterceptionStatus,
    evidence: readonly NativeResourceEvidence[],
  ) => void
}

interface FetchPaused {
  readonly requestId: string
  readonly request?: { readonly url?: string }
  readonly resourceType?: string
  readonly responseStatusCode?: number
  readonly responseHeaders?: readonly Readonly<{ name: string; value: string }>[]
}

interface State {
  status: NativeResourceInterceptionStatus
  disposed: boolean
  fetchEnabled: boolean
  cacheDisabled: boolean
  removeListener: (() => void) | undefined
  removeLifecycleListener: (() => void) | undefined
  removeAbortListener: (() => void) | undefined
  readonly requests: Map<string, 'paused' | 'settling'>
  readonly operations: Set<Promise<void>>
  readonly acknowledgements: Map<string, string>
  readonly fences: Set<string>
  documentGeneration: number
  topLevelLoadPending: boolean
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function decodeBody(response: Record<string, unknown>): Buffer {
  if (typeof response.body !== 'string') throw new Error('Fetch.getResponseBody returned no body')
  return Buffer.from(response.body, response.base64Encoded === true ? 'base64' : 'utf8')
}

function filteredHeaders(
  headers: FetchPaused['responseHeaders'],
): readonly Readonly<{ name: string; value: string }>[] {
  return (headers ?? []).filter(header => !['content-length', 'content-encoding'].includes(header.name.toLowerCase()))
}

function validate(options: NativeResourceInterceptionOptions): string | undefined {
  if (options.target.id.length === 0 || !options.target.url.startsWith('app://')) {
    return 'native resource interception requires one exact app:// target'
  }
  if (options.transforms.length === 0) return 'native resource interception requires at least one transform'
  const urls = new Set<string>()
  for (const transform of options.transforms) {
    if (!transform.url.startsWith('app://') || urls.has(transform.url) || !SHA256.test(transform.sha256)) {
      return `invalid or duplicate native resource transform: ${transform.url}`
    }
    urls.add(transform.url)
  }
  return undefined
}

async function evaluateBoolean(
  session: NativeResourceInterceptionSession,
  expression: string,
  timeoutMs: number,
): Promise<boolean> {
  const response = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, timeoutMs)
  if (response.exceptionDetails !== undefined) return false
  return (response.result as { value?: unknown } | undefined)?.value === true
}

async function settle(operation: Promise<unknown>, failures: unknown[]): Promise<void> {
  await operation.catch(error => failures.push(error))
}

async function bounded<Value>(
  operation: Promise<Value>,
  timeoutMs: number,
  name: string,
  signal?: AbortSignal,
): Promise<Value> {
  if (signal?.aborted === true) throw new Error(`native resource interception aborted during ${name}`)
  let timer: ReturnType<typeof setTimeout> | undefined
  let removeAbort: (() => void) | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`native resource interception timed out: ${name}`)), timeoutMs)
        if (signal !== undefined) {
          const abort = (): void => reject(new Error(`native resource interception aborted during ${name}`))
          signal.addEventListener('abort', abort, { once: true })
          removeAbort = () => signal.removeEventListener('abort', abort)
        }
      }),
    ])
  } finally {
    clearTimeout(timer)
    removeAbort?.()
  }
}

class Handle implements NativeResourceInterception {
  readonly managedRuntimeFlag = false as const

  constructor(
    readonly target: Readonly<{ id: string; url: string }>,
    readonly evidence: readonly NativeResourceEvidence[],
    private readonly state: State,
    private readonly cleanup: (finalStatus: 'unavailable' | 'disposed') => Promise<void>,
  ) {}

  get status(): NativeResourceInterceptionStatus {
    return this.state.status
  }

  async dispose(): Promise<void> {
    await this.cleanup('disposed')
  }
}

/**
 * Installs exact, pinned response-stage Script transforms for each native document.
 * Transform semantics remain owned by the caller; this helper only owns transport,
 * execution acknowledgement, and honest lifecycle downgrade.
 */
export async function installNativeResourceInterception(
  options: NativeResourceInterceptionOptions,
): Promise<NativeResourceInterception> {
  const timeoutMs = options.timeoutMs ?? CDP_REQUEST_TIMEOUT_MS
  const transforms = new Map(options.transforms.map(transform => [transform.url, transform]))
  const requiredUrls = new Set(
    options.transforms.filter(transform => transform.requiredForDocumentReady !== false).map(transform =>
      transform.url
    ),
  )
  const evidence = new Map<string, NativeResourceEvidence>(options.transforms.map(transform => [
    transform.url,
    {
      url: transform.url,
      expectedSha256: transform.sha256,
      state: 'pending',
    } satisfies NativeResourceEvidence,
  ]))
  const state: State = {
    status: 'installing',
    disposed: false,
    fetchEnabled: false,
    cacheDisabled: false,
    removeListener: undefined,
    removeLifecycleListener: undefined,
    removeAbortListener: undefined,
    requests: new Map(),
    operations: new Set(),
    acknowledgements: new Map(),
    fences: new Set(),
    documentGeneration: 0,
    topLevelLoadPending: false,
  }
  const publish = (status: NativeResourceInterceptionStatus): void => {
    state.status = status
    if (status === 'active') state.topLevelLoadPending = false
    options.onStatusChange?.(status, [...evidence.values()])
  }
  let cleanupPromise: Promise<void> | undefined
  let cleanupFinalStatus: 'unavailable' | 'disposed' = 'unavailable'

  const settleRequest = async (
    requestId: string,
    method: 'Fetch.continueRequest' | 'Fetch.fulfillRequest',
    params: Record<string, unknown>,
  ): Promise<void> => {
    if (state.requests.get(requestId) !== 'paused') return
    state.requests.set(requestId, 'settling')
    try {
      await options.session.send(method, { requestId, ...params }, timeoutMs)
      state.requests.delete(requestId)
    } catch (error) {
      state.requests.set(requestId, 'paused')
      throw error
    }
  }
  const continueOriginal = async (requestId: string): Promise<void> => {
    await settleRequest(requestId, 'Fetch.continueRequest', {})
  }
  const fence = async (): Promise<void> => {
    const failures: unknown[] = []
    for (const expression of state.fences) {
      await settle(
        (async () => {
          const response = await options.session.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true,
          }, timeoutMs)
          if (response.exceptionDetails !== undefined) {
            throw new Error('native resource interception fence threw in the renderer')
          }
        })(),
        failures,
      )
    }
    if (failures.length > 0) throw new AggregateError(failures, 'native resource interception fence was incomplete')
  }
  const cleanup = async (finalStatus: 'unavailable' | 'disposed'): Promise<void> => {
    if (finalStatus === 'disposed') cleanupFinalStatus = 'disposed'
    if (cleanupPromise !== undefined) {
      await cleanupPromise
      publish(cleanupFinalStatus)
      return
    }
    cleanupPromise = (async () => {
      state.disposed = true
      if (state.status === 'active') publish('unavailable')
      const failures: unknown[] = []
      await settle(fence(), failures)
      state.removeListener?.()
      state.removeListener = undefined
      state.removeLifecycleListener?.()
      state.removeLifecycleListener = undefined
      state.removeAbortListener?.()
      state.removeAbortListener = undefined
      await Promise.allSettled([...state.operations])
      for (const requestId of state.requests.keys()) await settle(continueOriginal(requestId), failures)
      if (state.fetchEnabled) await settle(options.session.send('Fetch.disable', {}, timeoutMs), failures)
      state.fetchEnabled = false
      if (state.cacheDisabled) {
        await settle(options.session.send('Network.setCacheDisabled', { cacheDisabled: false }, timeoutMs), failures)
        state.cacheDisabled = false
      }
      publish(cleanupFinalStatus)
      if (failures.length > 0) {
        throw new AggregateError(failures, 'native resource interception cleanup was incomplete')
      }
    })()
    await cleanupPromise
  }
  const handle = new Handle(options.target, [...evidence.values()], state, cleanup)
  const unavailable = (item: NativeResourceEvidence, reason: string): void => {
    item.state = 'unavailable'
    item.reason = reason
    if (state.status === 'active') publish('unavailable')
  }

  const beginDocument = (): number => {
    state.documentGeneration += 1
    state.acknowledgements.clear()
    state.fences.clear()
    for (const item of evidence.values()) {
      delete item.observedSha256
      delete item.transformedSha256
      delete item.reason
      item.state = 'pending'
    }
    state.topLevelLoadPending = false
    if (state.status !== 'installing') publish('installing')
    return state.documentGeneration
  }
  const aborted = (): boolean => options.signal?.aborted === true

  const acknowledgeItem = async (
    item: NativeResourceEvidence,
    generation: number,
    deadline: number,
  ): Promise<void> => {
    const expression = state.acknowledgements.get(item.url)
    let acknowledged = false
    while (
      generation === state.documentGeneration && expression !== undefined
      && Date.now() < deadline && !aborted()
      && !(acknowledged = await evaluateBoolean(
        options.session,
        expression,
        Math.max(1, deadline - Date.now()),
      ).catch(() => false))
    ) await delay(ACKNOWLEDGEMENT_POLL_MS)
    if (generation !== state.documentGeneration) return
    if (state.disposed || aborted()) {
      throw new Error('native resource interception was disposed during acknowledgement')
    }
    if (!acknowledged) unavailable(item, 'native resource execution acknowledgement was not observed')
    else item.state = 'acknowledged'
  }

  const acknowledgeDocument = async (generation: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (
      generation === state.documentGeneration
      && [...evidence.values()].some(item => requiredUrls.has(item.url) && item.state === 'pending')
      && Date.now() < deadline && !aborted()
    ) await delay(ACKNOWLEDGEMENT_POLL_MS)
    if (generation !== state.documentGeneration) return
    if (state.disposed || aborted()) {
      await cleanup('unavailable')
      return
    }
    for (const item of evidence.values()) {
      if (requiredUrls.has(item.url) && item.state === 'pending') {
        unavailable(item, 'native resource was not observed before timeout')
      }
    }
    if ([...evidence.values()].some(item => requiredUrls.has(item.url) && item.state === 'unavailable')) {
      throw new Error('required native document resource is unavailable')
    }
    for (const item of evidence.values()) {
      if (requiredUrls.has(item.url)) await acknowledgeItem(item, generation, deadline)
    }
    if (
      generation === state.documentGeneration && !state.disposed && !aborted()
      && [...evidence.values()].every(item => !requiredUrls.has(item.url) || item.state === 'acknowledged')
    ) publish('active')
    else throw new Error('native document acknowledgement did not complete')
  }

  const invalid = validate(options)
  if (invalid !== undefined) {
    for (const item of evidence.values()) unavailable(item, invalid)
    publish('unavailable')
    return handle
  }

  const handlePaused = async (params: Record<string, unknown>): Promise<void> => {
    const event = params as unknown as FetchPaused
    if (typeof event.requestId !== 'string') return
    if (state.requests.has(event.requestId)) return
    state.requests.set(event.requestId, 'paused')
    const transform = typeof event.request?.url === 'string' ? transforms.get(event.request.url) : undefined
    if (
      transform === undefined || event.resourceType !== 'Script'
      || !Number.isSafeInteger(event.responseStatusCode)
    ) {
      await continueOriginal(event.requestId)
      return
    }
    const item = evidence.get(transform.url)!
    try {
      const response = await options.session.send('Fetch.getResponseBody', { requestId: event.requestId }, timeoutMs)
      const original = decodeBody(response)
      item.observedSha256 = digest(original)
      if (item.observedSha256 !== transform.sha256) {
        unavailable(item, `native resource pin mismatch: ${item.observedSha256}`)
        await continueOriginal(event.requestId)
        return
      }
      const result = transform.transform(original.toString('utf8'))
      if (result.anchorMatches !== 1) {
        throw new Error(`native resource transform anchor count was ${result.anchorMatches}`)
      }
      if (
        result.source.length === 0 || result.acknowledgementExpression.length === 0
        || result.fenceExpression.length === 0
      ) throw new Error('native resource transform returned an incomplete lifecycle contract')
      if (state.disposed) {
        await continueOriginal(event.requestId)
        return
      }
      const transformed = Buffer.from(result.source)
      item.transformedSha256 = digest(transformed)
      state.acknowledgements.set(transform.url, result.acknowledgementExpression)
      state.fences.add(result.fenceExpression)
      await settleRequest(event.requestId, 'Fetch.fulfillRequest', {
        responseCode: event.responseStatusCode,
        responseHeaders: filteredHeaders(event.responseHeaders),
        body: transformed.toString('base64'),
      })
      item.state = 'fulfilled'
    } catch (error) {
      if (item.state !== 'unavailable') unavailable(item, message(error))
      await continueOriginal(event.requestId).catch(() => undefined)
    }
  }
  const listener = (params: Record<string, unknown>): void => {
    const event = params as unknown as FetchPaused
    const item = typeof event.request?.url === 'string' ? evidence.get(event.request.url) : undefined
    const isPinnedScript = typeof event.request?.url === 'string'
      && transforms.has(event.request.url)
      && event.resourceType === 'Script'
      && Number.isSafeInteger(event.responseStatusCode)
    const generation = state.topLevelLoadPending && isPinnedScript
        && (state.status === 'active' || state.documentGeneration === 0)
      ? beginDocument()
      : undefined
    const operation = (async () => {
      const deferredTransform = state.status === 'active' && item?.state === 'pending'
      if (state.status === 'active' && !deferredTransform && typeof event.requestId === 'string') {
        state.requests.set(event.requestId, 'paused')
        await continueOriginal(event.requestId)
        throw new Error('native document resource lifecycle changed without navigation')
      }
      await handlePaused(params)
      if (
        item !== undefined && item.state === 'fulfilled'
        && !requiredUrls.has(item.url)
      ) await acknowledgeItem(item, state.documentGeneration, Date.now() + timeoutMs)
      if (generation !== undefined) await acknowledgeDocument(generation)
    })()
    state.operations.add(operation)
    void operation.catch(error => {
      for (const item of evidence.values()) {
        if (item.state !== 'unavailable') unavailable(item, message(error))
      }
      void cleanup('unavailable').catch(() => undefined)
    }).finally(() => state.operations.delete(operation))
  }

  try {
    state.removeListener = options.session.onEvent('Fetch.requestPaused', listener)
    state.removeLifecycleListener = options.session.onEvent('Page.frameStartedLoading', params => {
      if (params.frameId === options.target.id) state.topLevelLoadPending = true
    })
    if (options.signal !== undefined) {
      const abort = (): void => {
        for (const item of evidence.values()) unavailable(item, 'native resource interception aborted')
        publish('unavailable')
        void cleanup('unavailable').catch(() => undefined)
      }
      options.signal.addEventListener('abort', abort, { once: true })
      state.removeAbortListener = () => options.signal?.removeEventListener('abort', abort)
    }
    await options.session.send('Network.setCacheDisabled', { cacheDisabled: true }, timeoutMs)
    state.cacheDisabled = true
    await options.session.send('Fetch.enable', {
      patterns: options.transforms.map(transform => ({
        urlPattern: transform.url,
        resourceType: 'Script',
        requestStage: 'Response',
      })),
    }, timeoutMs)
    state.fetchEnabled = true
    if (options.reloadDocument === undefined) return handle
    const generation = beginDocument()
    await bounded(options.reloadDocument(), timeoutMs, 'document reload', options.signal)
    await acknowledgeDocument(generation)
  } catch (error) {
    for (const item of evidence.values()) {
      if (item.state !== 'acknowledged' && item.state !== 'unavailable') unavailable(item, message(error))
    }
    await cleanup('unavailable').catch(() => undefined)
  }
  return handle
}
