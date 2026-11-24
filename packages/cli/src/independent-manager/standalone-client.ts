import type { CordisXRuntimeHandle } from '../renderer/runtime-shared.js'
import type { StandaloneDomPolicyAdopter } from '../standalone-permission-contract.js'
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
import { createStandalonePermissionSigner, type StandalonePermissionSigner } from './standalone-permission-signer.js'

const tokenPattern = /^[a-f0-9]{64}$/u
const scopePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const bundleUrl = '/api/renderer/bundle.js'
const heartbeatMilliseconds = 15_000
const requestMilliseconds = 20_000
const bootMilliseconds = 60_000
const resumeMilliseconds = 45_000
const resumePendingLimit = 80
const resumePollMilliseconds = 250
const resumeStorageKey = 'cordisx-manager-resume-id'
const resumeAttemptStorageKey = 'cordisx-manager-resume-attempt'
const entryStorageKey = 'cordisx-manager-entry-attempt'

class ManagerSessionTransportError extends Error {}
class ManagerResumeTransportError extends Error {}

type Runtime = Parameters<typeof createManagerRendererLifecycleClient>[0]['runtime']
type ResourceFactory = typeof createManagerResourceAuthClient
type Composition = {
  startStandaloneManagerComposition(
    signal: AbortSignal,
    verifySession: () => Promise<boolean>,
    onResultUnknown: (source?: 'permission-policy') => void,
    registerPolicyAdopter?: (adopt: StandaloneDomPolicyAdopter) => void,
    permissionSigner?: StandalonePermissionSigner,
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
  let policyAdopter: StandaloneDomPolicyAdopter | undefined
  let permissionSigner: StandalonePermissionSigner | undefined
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
      const transportFailure = (error: unknown): never => {
        if (!closed && !lifetime.signal.aborted) {
          if (path === '/api/renderer/session') {
            throw new ManagerSessionTransportError('manager-session-transport', { cause: error })
          }
          if (path.startsWith('/api/session/resume/')) {
            throw new ManagerResumeTransportError('manager-resume-transport', { cause: error })
          }
        }
        throw error
      }
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
      }).catch(transportFailure)
      if ((!response.ok && !(allowPending && response.status === 409)) || closed || timeout.signal.aborted) {
        throw new Error('manager-session-unavailable')
      }
      const text = await response.text().catch(transportFailure)
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
  const readResumeId = (): string | undefined => {
    try {
      const value = browser.sessionStorage.getItem(resumeStorageKey)
      return value && tokenPattern.test(value) ? value : undefined
    } catch {
      return undefined
    }
  }
  const resumeAttempt = (id: string): string | undefined => {
    try {
      const prefix = `${id}:`
      const existing = browser.sessionStorage.getItem(resumeAttemptStorageKey)
      const attempt = existing?.startsWith(prefix) ? existing.slice(prefix.length) : undefined
      if (attempt && tokenPattern.test(attempt)) return attempt
      const bytes = browser.crypto.getRandomValues(new Uint8Array(32))
      const value = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
      browser.sessionStorage.setItem(resumeAttemptStorageKey, `${prefix}${value}`)
      return value
    } catch {
      return undefined
    }
  }
  const forgetResumeAttempt = (id: string | undefined) => {
    if (!id) return
    try {
      if (browser.sessionStorage.getItem(resumeAttemptStorageKey)?.startsWith(`${id}:`)) {
        browser.sessionStorage.removeItem(resumeAttemptStorageKey)
      }
    } catch { /* storage may be disabled */ }
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
    forgetResumeAttempt(resumeId)
    resumeId = undefined
  }
  const resumeSession = async (id: string, attempt: string | undefined): Promise<Record<string, unknown>> => {
    let retriedTransport = false
    let pending = 0
    while (pending < resumePendingLimit) {
      let result: Record<string, unknown>
      try {
        result = await post(
          `/api/session/resume/${id}`,
          attempt === undefined ? {} : { attempt },
          undefined,
          true,
          true,
        )
      } catch (error) {
        // The owner retires any session issued by the first exchange before
        // accepting the same attempt again. Never retry a legacy exchange.
        if (retriedTransport || attempt === undefined || !(error instanceof ManagerResumeTransportError)) throw error
        retriedTransport = true
        await bounded(new Promise(resolve => setTimeout(resolve, 100)), lifetime.signal, 1_000)
        continue
      }
      if (result.error !== 'RESUME_PENDING' || Object.keys(result).length !== 1) return result
      // An interrupted exchange can still be retiring the old renderer. The
      // owner allows up to 15 seconds for that confirmation; do not exhaust
      // the polling budget before the owner can report its result.
      pending++
      if (pending < resumePendingLimit) {
        await bounded(new Promise(resolve => setTimeout(resolve, resumePollMilliseconds)), lifetime.signal, 1_000)
      }
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
    policyAdopter = undefined
    permissionSigner?.close()
    permissionSigner = undefined
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
    const uncertain = reason === 'result-unknown' || removeBindings?.canQuiesce() === false
    if (!notified) {
      notified = true
      try {
        input.onUnavailable?.(uncertain ? 'result-unknown' : undefined)
      } catch { /* presentation cannot keep an invalid session alive */ }
    }
    // An interrupted exchange has not dispatched a new session operation. The
    // same tab can retry it; the owner still has to confirm every retirement.
    void close(sessionToken === undefined && resumeId !== undefined)
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
      if (removeBindings?.hasUncertainWrite()) fail('result-unknown')
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
      const previousResume = readResumeId()
      resumeId = previousResume
      if (isEntry) forgetResumeId()
      const attempt = isEntry ? entryAttempt() : undefined
      const recoveryAttempt = !isEntry && previousResume ? resumeAttempt(previousResume) : undefined
      const exchanged = isEntry
        ? await post(
          '/api/session',
          { token: entryToken, resume: true, ...(attempt ? { attempt } : {}) },
          undefined,
          true,
        )
        : entryToken !== '' || previousResume === undefined
        ? undefined
        : await bounded(resumeSession(previousResume, recoveryAttempt), lifetime.signal, resumeMilliseconds)
      if (!exchanged || typeof exchanged.token !== 'string' || !tokenPattern.test(exchanged.token)) {
        throw new Error('manager-session-invalid')
      }
      if (Object.keys(exchanged).some(key => key !== 'token' && key !== 'resumeId')) {
        throw new Error('manager-session-invalid')
      }
      sessionToken = exchanged.token
      const nextResume = saveResumeId(exchanged.resumeId)
      if (!nextResume) forgetResumeId()
      resumeId = nextResume
      if (!isEntry) forgetResumeAttempt(previousResume)
      if (isEntry) {
        // Keep the bootstrap in the fragment until exchange succeeds, then
        // remove it before starting any owner operation.
        browser.history.replaceState(null, '', `${url.pathname}${url.search}`)
        forgetEntryAttempt()
      }
      // The server retires the prior recovery cookie on the first authorized
      // request. Accept that Set-Cookie without sending cookies to other APIs.
      const opened = record(await post('/api/renderer/open', {}, sessionToken, recoveryAttempt !== undefined), [
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
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const state = record(await post('/api/renderer/session', {}, token), [
              'current',
              'rendererId',
              'generation',
            ])
            return state.current === true && state.rendererId === scope.rendererId
              && state.generation === scope.generation
          } catch (error) {
            // Only this read-only check may be retried. An explicit rejection,
            // invalid response, or mismatched owner remains immediately fatal.
            if (!(error instanceof ManagerSessionTransportError) || attempt !== 0 || closed) return false
            try {
              await bounded(new Promise(resolve => setTimeout(resolve, 100)), lifetime.signal, 1_000)
            } catch {
              return false
            }
          }
        }
        return false
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
      if (opened.channels.includes('permission-policy')) {
        const creating = createStandalonePermissionSigner(scope, { crypto: browser.crypto })
        void creating.then(signer => {
          if (closed) signer.close()
        }, () => undefined)
        permissionSigner = await bounded(creating, lifetime.signal, bootMilliseconds)
      }
      const bootstrap = record(
        await post(
          '/api/renderer/bootstrap',
          permissionSigner === undefined ? {} : { permissionPublicKey: permissionSigner.publicKey },
          token,
        ),
        [
          'status',
          'bundleUrl',
          'initialGraphs',
        ],
      )
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
        isNavigating: () => navigating,
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
          (source?: 'permission-policy') => {
            // Permission persistence and its adoption both report unknown
            // results. Only an interrupted navigation may retain recovery;
            // the owner still has to confirm retirement before a new session.
            if (
              source === 'permission-policy' && navigating && removeBindings?.hasUncertainWrite()
              && canPreserveResume()
            ) return
            fail('result-unknown')
          },
          (adopt: StandaloneDomPolicyAdopter) => {
            if (closed || policyAdopter !== undefined || typeof adopt !== 'function') {
              throw new Error('manager-policy-adoption-unavailable')
            }
            policyAdopter = adopt
          },
          permissionSigner,
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
        onManagedServiceAccounts: async value =>
          await (startedRuntime.adoptStandaloneManagedServiceAccounts?.(value) ?? Promise.resolve(false)),
        onDesktopPackageConfiguration: async value =>
          await (startedRuntime.adoptStandaloneDesktopPackageConfig?.(value) ?? Promise.resolve(false)),
        onPermissionPolicy: async value => {
          const adopt = policyAdopter
          return !closed && adopt !== undefined && await adopt(value) && !closed
        },
        onQuiesce: async () => {
          // Do not acknowledge a fence while an operation may have written or
          // while resource recovery has an unresolved result.
          if (!removeBindings?.canQuiesce() || !resourceAuth || heartbeatRunning) return false
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
