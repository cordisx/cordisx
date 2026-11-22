import type { CordisXRuntimeHandle } from '../renderer/runtime-shared.js'
import {
  createManagerRendererGraphLoader,
  type ManagerRendererGraph,
  type ManagerRendererResourceRegistry,
  parseManagerRendererGraph,
} from './graph-stage-loader.js'
import {
  INDEPENDENT_HOST_CHANNELS,
  type IndependentHostChannel,
  installIndependentHostBindings,
} from './host-bindings.js'
import { createManagerRendererLifecycleClient, type ManagerRendererStageLoader } from './lifecycle-client.js'
import { startManagerRendererLifecyclePump } from './lifecycle-pump.js'
import { createManagerResourceAuthClient, type ManagerResourceAuthClient } from './resource-auth-client.js'

const tokenPattern = /^[a-f0-9]{64}$/u
const scopePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const bundleUrl = '/api/renderer/bundle.js'
const heartbeatMilliseconds = 15_000
const requestMilliseconds = 20_000
const bootMilliseconds = 60_000
const resumeStorageKey = 'cordisx-manager-resume-id'
const entryStorageKey = 'cordisx-manager-entry-attempt'

type Runtime = Parameters<typeof createManagerRendererLifecycleClient>[0]['runtime']
type ResourceFactory = typeof createManagerResourceAuthClient
type Composition = {
  startStandaloneManagerComposition(
    signal: AbortSignal,
    verifySession: () => Promise<boolean>,
    onResultUnknown: () => void,
  ): Promise<CordisXRuntimeHandle>
}
type Browser = Window & {
  __cordisxRuntime?: CordisXRuntimeHandle
  __cordisxPluginGenerationResourcesV1?: ManagerRendererResourceRegistry
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('manager-response-invalid')
  const result = value as Record<string, unknown>
  if (Object.keys(result).length !== keys.length || Object.keys(result).some(key => !keys.includes(key))) {
    throw new Error('manager-response-invalid')
  }
  return result
}

async function bounded<T>(work: Promise<T>, signal: AbortSignal, milliseconds: number): Promise<T> {
  if (signal.aborted) throw new Error('manager-session-revoked')
  return await new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
    const abort = () => {
      cleanup()
      reject(new Error('manager-session-revoked'))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('manager-session-timeout'))
    }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
    work.then(value => {
      cleanup()
      resolve(value)
    }, error => {
      cleanup()
      reject(error)
    })
    if (signal.aborted) abort()
  })
}

function verifyInitialGraphs(
  initialGraphs: readonly ManagerRendererGraph[],
  runtime: Runtime & Pick<CordisXRuntimeHandle, 'configuredPluginGraphGenerations'>,
  scope: { readonly profileId: string; readonly generation: string },
): void {
  const active = runtime.activePluginGeneration()
  const epoch = runtime.pluginRegistryEpoch()
  if (
    !active || active.recordKind !== 'active' || active.profileId !== scope.profileId
    || active.runtimeGeneration !== scope.generation || !Array.isArray(active.plugins)
    || !Number.isSafeInteger(epoch) || epoch < 0
  ) throw new Error('manager-runtime-stale')
  const plugins = new Map(active.plugins.map(plugin => [plugin.id, plugin]))
  if (plugins.size !== active.plugins.length) throw new Error('manager-runtime-stale')
  const configured = runtime.configuredPluginGraphGenerations?.() ?? []
  if (!Array.isArray(configured) || configured.length > 256) throw new Error('manager-runtime-stale')
  const configuredById = new Map(configured.map(plugin => [plugin.pluginId, plugin]))
  if (
    configuredById.size !== configured.length
    || configured.some(plugin =>
      !plugin || typeof plugin.pluginId !== 'string'
      || typeof plugin.moduleGeneration !== 'string' || plugins.has(plugin.pluginId)
    )
    || configured.some(plugin =>
      !initialGraphs.some(graph =>
        graph.pluginId === plugin.pluginId && graph.moduleGeneration === plugin.moduleGeneration
      )
    )
  ) throw new Error('manager-runtime-stale')
  for (const graph of initialGraphs) {
    const plugin = plugins.get(graph.pluginId)
    const configuredPlugin = configuredById.get(graph.pluginId)
    if (plugin === undefined) {
      if (configuredPlugin?.moduleGeneration !== graph.moduleGeneration) throw new Error('manager-runtime-stale')
    } else if (!plugin.enabled || plugin.moduleGeneration !== graph.moduleGeneration) {
      throw new Error('manager-runtime-stale')
    }
  }
}

/**
 * Start one owner-authorized Manager document. The bearer token stays in
 * memory. A tab-local non-secret handle and an HttpOnly cookie permit a fresh
 * session after confirmed retirement; uncertain operations are never replayed.
 */
export function startStandaloneManager(input: {
  readonly window: Window
  readonly onUnavailable?: (reason?: 'result-unknown') => void
  /** Test seams. The application uses the fixed service worker and native ESM import. */
  readonly createResourceAuth?: ResourceFactory
  readonly importBundle?: (url: string) => Promise<Composition>
}): { readonly ready: Promise<boolean>; close(): Promise<void> } {
  const browser = input.window as Browser
  const lifetime = new AbortController()
  let settleRendererAdmission!: (admitted: boolean) => void
  const rendererAdmission = new Promise<boolean>(resolve => {
    settleRendererAdmission = resolve
  })
  const workerContainer = browser.navigator.serviceWorker
  let closed = false
  let closing: Promise<void> | undefined
  let sessionToken: string | undefined
  let resourceAuth: ManagerResourceAuthClient | undefined
  let removeBindings: ReturnType<typeof installIndependentHostBindings> | undefined
  let runtime: Runtime | undefined
  let graphLoader: ManagerRendererStageLoader | undefined
  let lifecycle: ReturnType<typeof createManagerRendererLifecycleClient> | undefined
  let pump: ReturnType<typeof startManagerRendererLifecyclePump> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let heartbeatRunning = false
  let watchWorker = false
  let notified = false
  let resumeId: string | undefined
  let navigating = false
  let navigationTimer: ReturnType<typeof setTimeout> | undefined

  const post = async (
    path: string,
    body: unknown,
    token?: string,
    withCookies = false,
    allowPending = false,
  ): Promise<Record<string, unknown>> => {
    if (closed) throw new Error('manager-session-revoked')
    const timeout = new AbortController()
    // The owner builds and compresses the initial renderer bundle on demand.
    // Give that one operation the same bounded startup budget as bundle import.
    const deadline = path === '/api/renderer/bootstrap' ? bootMilliseconds : requestMilliseconds
    const timer = setTimeout(() => timeout.abort(), deadline)
    try {
      const response = await browser.fetch(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
        cache: 'no-store',
        credentials: withCookies ? 'same-origin' : 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.any([lifetime.signal, timeout.signal]),
      })
      if ((!response.ok && !(allowPending && response.status === 409)) || closed || timeout.signal.aborted) {
        throw new Error('manager-session-unavailable')
      }
      const text = await response.text()
      if (text.length > 1_048_576 || closed || timeout.signal.aborted) throw new Error('manager-response-invalid')
      const value: unknown = JSON.parse(text)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('manager-response-invalid')
      return value as Record<string, unknown>
    } finally {
      clearTimeout(timer)
    }
  }
  const entryAttempt = (): string | undefined => {
    try {
      const existing = browser.sessionStorage.getItem(entryStorageKey)
      if (existing && tokenPattern.test(existing)) return existing
      const bytes = browser.crypto.getRandomValues(new Uint8Array(32))
      const value = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
      browser.sessionStorage.setItem(entryStorageKey, value)
      return value
    } catch {
      return undefined
    }
  }
  const forgetEntryAttempt = () => {
    try {
      browser.sessionStorage.removeItem(entryStorageKey)
    } catch { /* storage may be disabled */ }
  }
  const takeResumeId = (): string | undefined => {
    try {
      const value = browser.sessionStorage.getItem(resumeStorageKey)
      browser.sessionStorage.removeItem(resumeStorageKey)
      return value && tokenPattern.test(value) ? value : undefined
    } catch {
      return undefined
    }
  }
  const saveResumeId = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || !tokenPattern.test(value)) return undefined
    try {
      browser.sessionStorage.setItem(resumeStorageKey, value)
      return value
    } catch {
      return undefined
    }
  }
  const forgetResumeId = () => {
    try {
      if (browser.sessionStorage.getItem(resumeStorageKey) === resumeId) {
        browser.sessionStorage.removeItem(resumeStorageKey)
      }
    } catch { /* storage may be disabled */ }
    resumeId = undefined
  }
  const resumeSession = async (id: string): Promise<Record<string, unknown>> => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await post(`/api/session/resume/${id}`, {}, undefined, true, true)
      if (result.error !== 'RESUME_PENDING' || Object.keys(result).length !== 1) return result
      await bounded(new Promise(resolve => setTimeout(resolve, 100)), lifetime.signal, 1_000)
    }
    throw new Error('manager-resume-unavailable')
  }
  const revokeServer = async (token: string, preserveResume: boolean) => {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 3_000)
    try {
      await browser.fetch('/api/renderer/close', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(preserveResume ? { preserveResume: true } : {}),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        keepalive: true,
        signal: abort.signal,
      })
    } catch {
      /* server authority also expires on disconnect */
    } finally {
      clearTimeout(timer)
    }
  }
  const close = (preserveResume = false): Promise<void> => {
    if (closing) return closing
    closed = true
    settleRendererAdmission(false)
    lifetime.abort()
    if (heartbeat !== undefined) clearInterval(heartbeat)
    if (navigationTimer !== undefined) clearTimeout(navigationTimer)
    browser.removeEventListener('beforeunload', onBeforeUnload)
    browser.removeEventListener('pagehide', onPageHide)
    workerContainer?.removeEventListener('controllerchange', onControllerChange)
    removeBindings?.()
    const token = sessionToken
    sessionToken = undefined
    if (!preserveResume) forgetResumeId()
    const pending: Promise<unknown>[] = []
    if (resourceAuth) pending.push(resourceAuth.revokeLocal())
    if (pump) pending.push(pump.close())
    else if (lifecycle) pending.push(lifecycle.close())
    else {
      if (runtime) pending.push(Promise.resolve().then(() => runtime?.dispose()))
      if (graphLoader) pending.push(Promise.resolve().then(() => graphLoader?.dispose()))
      else pending.push(Promise.resolve().then(() => browser.__cordisxPluginGenerationResourcesV1?.dispose?.()))
    }
    if (token) pending.push(revokeServer(token, preserveResume))
    closing = Promise.allSettled(pending).then(() => undefined)
    return closing
  }
  const fail = (reason?: 'result-unknown') => {
    if (closed) return
    const uncertain = reason === 'result-unknown' || removeBindings?.canResume() === false
    if (!notified) {
      notified = true
      try {
        input.onUnavailable?.(uncertain ? 'result-unknown' : undefined)
      } catch { /* presentation cannot keep an invalid session alive */ }
    }
    void close()
  }
  const canPreserveResume = () =>
    resumeId !== undefined
    // Before the lifecycle pump exists, no lifecycle command can have been
    // delivered. The owner still has to confirm retirement before resuming.
    && (lifecycle === undefined || lifecycle.canResume())
    && (removeBindings === undefined || removeBindings.canResume())
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!event.isTrusted) return
    navigating = true
    if (navigationTimer !== undefined) clearTimeout(navigationTimer)
    navigationTimer = setTimeout(() => {
      navigating = false
    }, 3_000)
  }
  const onPageHide = (event: PageTransitionEvent) => {
    void close(event.isTrusted && canPreserveResume())
  }
  const onControllerChange = () => {
    if (watchWorker) fail()
  }
  browser.addEventListener('beforeunload', onBeforeUnload)
  browser.addEventListener('pagehide', onPageHide, { once: true })
  workerContainer?.addEventListener('controllerchange', onControllerChange)

  const ready = (async (): Promise<boolean> => {
    try {
      const url = new URL(browser.location.href)
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === '' || url.pathname !== '/') {
        throw new Error('manager-origin-invalid')
      }
      const entryToken = url.hash.slice(1)
      const isEntry = tokenPattern.test(entryToken)
      if (!isEntry) browser.history.replaceState(null, '', `${url.pathname}${url.search}`)
      const previousResume = takeResumeId()
      const attempt = isEntry ? entryAttempt() : undefined
      const exchanged = isEntry
        ? await post(
          '/api/session',
          { token: entryToken, resume: true, ...(attempt ? { attempt } : {}) },
          undefined,
          true,
        )
        : entryToken !== '' || previousResume === undefined
        ? undefined
        : await resumeSession(previousResume)
      if (!exchanged || typeof exchanged.token !== 'string' || !tokenPattern.test(exchanged.token)) {
        throw new Error('manager-session-invalid')
      }
      if (Object.keys(exchanged).some(key => key !== 'token' && key !== 'resumeId')) {
        throw new Error('manager-session-invalid')
      }
      sessionToken = exchanged.token
      resumeId = saveResumeId(exchanged.resumeId)
      if (isEntry) {
        // Keep the bootstrap in the fragment until exchange succeeds, then
        // remove it before starting any owner operation.
        browser.history.replaceState(null, '', `${url.pathname}${url.search}`)
        forgetEntryAttempt()
      }
      const opened = record(await post('/api/renderer/open', {}, sessionToken), [
        'status',
        'rendererId',
        'generation',
        'profileId',
        'channels',
        'commands',
      ])
      if (
        opened.status !== 'ok' || opened.commands !== true
        || typeof opened.rendererId !== 'string' || !tokenPattern.test(opened.rendererId)
        || typeof opened.generation !== 'string' || !scopePattern.test(opened.generation)
        || typeof opened.profileId !== 'string' || !scopePattern.test(opened.profileId)
        || !Array.isArray(opened.channels)
        || opened.channels.some(channel =>
          typeof channel !== 'string' || !Object.hasOwn(INDEPENDENT_HOST_CHANNELS, channel)
        )
        || new Set(opened.channels).size !== opened.channels.length
      ) throw new Error('manager-owner-unavailable')
      const scope = { rendererId: opened.rendererId, generation: opened.generation, profileId: opened.profileId }
      const token = sessionToken
      const isSessionCurrent = async (): Promise<boolean> => {
        try {
          const state = record(await post('/api/renderer/session', {}, token), ['current', 'rendererId', 'generation'])
          return state.current === true && state.rendererId === scope.rendererId
            && state.generation === scope.generation
        } catch {
          return false
        }
      }
      const verifyReviewSession = async (): Promise<boolean> => {
        if (!await rendererAdmission || closed || !resourceAuth || lifecycle?.canResume() !== true) return false
        if (await resourceAuth.isBound() !== true) {
          fail()
          return false
        }
        const current = await isSessionCurrent()
        if (!current) fail()
        return current && !closed && lifecycle?.canResume() === true
      }
      resourceAuth = (input.createResourceAuth ?? createManagerResourceAuthClient)({
        window: browser,
        sessionToken: token,
        isSessionCurrent,
      })
      if (!await resourceAuth.start() || closed) throw new Error('manager-resource-unavailable')
      watchWorker = true
      if (!await resourceAuth.isBound() || closed) throw new Error('manager-resource-unavailable')
      heartbeat = setInterval(() => {
        if (closed || heartbeatRunning || !resourceAuth) return
        heartbeatRunning = true
        void (async () => {
          const bound = await resourceAuth!.isBound()
          if (bound === true) {
            if (!await isSessionCurrent()) fail()
            return
          }
          if (bound !== false) {
            fail()
            return
          }
          // A worker may lose its in-memory state without its controller
          // changing. Rebind only while the lifecycle is idle and the owner
          // still recognizes this exact renderer; never replay a command.
          const recovered = await lifecycle?.recoverResources(async () =>
            await isSessionCurrent() && await resourceAuth!.recover()
            && await resourceAuth!.isBound() === true && await isSessionCurrent()
          )
          if (!recovered) fail()
        })().catch(fail).finally(() => {
          heartbeatRunning = false
        })
      }, heartbeatMilliseconds)
      const bootstrap = record(await post('/api/renderer/bootstrap', {}, token), [
        'status',
        'bundleUrl',
        'initialGraphs',
      ])
      if (bootstrap.status !== 'ok' || bootstrap.bundleUrl !== bundleUrl || !Array.isArray(bootstrap.initialGraphs)) {
        throw new Error('manager-bootstrap-unavailable')
      }
      const initialGraphs = bootstrap.initialGraphs.map(graph => parseManagerRendererGraph(graph, url.origin))
      if (
        initialGraphs.length > 256 || new Set(initialGraphs.map(graph => graph.leaseId)).size !== initialGraphs.length
        || new Set(initialGraphs.map(graph => graph.pluginId)).size !== initialGraphs.length
      ) throw new Error('manager-bootstrap-invalid')
      removeBindings = installIndependentHostBindings({
        window: browser,
        sessionToken: token,
        channels: opened.channels as IndependentHostChannel[],
        rendererAdmission,
        onSessionLost: fail,
      })
      const importBundle = input.importBundle ?? (async (path: string) => await import(/* @vite-ignore */ path))
      const composition = await bounded(importBundle(bundleUrl), lifetime.signal, bootMilliseconds)
      if (typeof composition?.startStandaloneManagerComposition !== 'function' || !await isSessionCurrent() || closed) {
        throw new Error('manager-owner-unavailable')
      }
      const starting = Promise.resolve().then(() =>
        composition.startStandaloneManagerComposition(
          lifetime.signal,
          verifyReviewSession,
          () => fail('result-unknown'),
        )
      )
      void starting.then(started => {
        if (closed) {
          void Promise.allSettled([
            Promise.resolve().then(() => started.dispose()),
            Promise.resolve().then(() => browser.__cordisxPluginGenerationResourcesV1?.dispose?.()),
          ])
        }
      }, () => undefined)
      const startedRuntime = await bounded(starting, lifetime.signal, bootMilliseconds)
      runtime = startedRuntime
      if (
        closed || browser.__cordisxRuntime !== startedRuntime || !await resourceAuth.isBound()
        || !await isSessionCurrent()
      ) {
        throw new Error('manager-runtime-unavailable')
      }
      verifyInitialGraphs(initialGraphs, startedRuntime, scope)
      const registry = browser.__cordisxPluginGenerationResourcesV1
      if (
        !registry || typeof registry.stage !== 'function' || typeof registry.publish !== 'function'
        || typeof registry.retire !== 'function'
      ) throw new Error('manager-resource-unavailable')
      graphLoader = createManagerRendererGraphLoader({ origin: url.origin, registry, initialGraphs })
      lifecycle = createManagerRendererLifecycleClient({
        runtime: startedRuntime,
        scope,
        loader: graphLoader,
        signal: lifetime.signal,
        onChannelConfiguration: (projection, revision) =>
          startedRuntime.adoptStandaloneChannelProjection?.(projection, revision) === true,
        onManagedServiceState: async value =>
          await (startedRuntime.confirmStandaloneManagedServiceState?.(value) ?? Promise.resolve(false)),
        onDesktopPackageConfiguration: value => startedRuntime.adoptStandaloneDesktopPackageConfig?.(value) === true,
        onQuiesce: async () => {
          // Do not acknowledge a fence while an operation may have written or
          // while resource recovery has an unresolved result.
          if (!removeBindings?.canResume() || !resourceAuth || heartbeatRunning) return false
          removeBindings()
          if (heartbeat !== undefined) clearInterval(heartbeat)
          heartbeat = undefined
          watchWorker = false
          return await resourceAuth.revokeLocal()
        },
      })
      pump = startManagerRendererLifecyclePump({
        window: browser,
        sessionToken: token,
        client: lifecycle,
        onFailure: () => {
          if (navigating && canPreserveResume()) void close(true)
          else fail()
        },
        onQuiesced: fail,
      })
      const admitted = await pump.admitted
      settleRendererAdmission(admitted && !closed)
      if (!admitted || closed) throw new Error('manager-admission-unavailable')
      return true
    } catch {
      // Navigation can abort a startup request after beforeunload but before
      // pagehide. Preserve only the same idle session that pagehide could
      // preserve; the owner still has to confirm its retirement.
      if (navigating && canPreserveResume()) void close(true)
      else fail()
      return false
    }
  })()
  return { ready, close: () => close(false) }
}
