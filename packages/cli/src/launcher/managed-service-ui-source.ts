import type {
  ManagedServiceAuthProjectionV1,
  ManagedServiceBindingV1,
  ManagedServiceCapabilitiesV1,
  ManagedServiceDiagnosticV1,
  ManagedServiceHealthProjectionV1,
  ManagedServiceIdentityV1,
  ManagedServiceLoginActionReasonV1,
  ManagedServiceLoginActionV1,
  ManagedServiceLoginRequestV1,
  ManagedServiceLoginResultV1,
  ManagedServiceLogoutRequestV1,
  ManagedServiceLogoutResultV1,
  ManagedServiceProjectionUpdateV1,
  ManagedServiceProjectionV1,
  ManagedServiceReadinessV1,
  ManagedServiceSnapshotResultV1,
  ManagedServiceSourceV1,
  ManagedServiceSubscribeResultV1,
  ManagedServiceSubscriptionClosedV1,
  ManagedServiceSubscriptionDescriptorV1,
  ManagedServiceSubscriptionPageV1,
  ManagedServiceSubscriptionV1,
} from '@cordisx/protocol/managed-service/v1'
import type {
  ManagedServiceProjectionV1 as RuntimeManagedServiceProjectionV1,
  ManagedServiceRegistrationHandleV1,
} from '@cordisx/protocol/managed-service-runtime/v1'
import type { ManagedServiceNodeUISourceExtensionV1 } from '@cordisx/protocol/managed-service-context/v1'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { ManagedServiceWebEntryReader } from './managed-service-web-entry.js'

const SUBSCRIPTION_PAGE_MAX_UPDATES = 32

export interface ManagedServiceNodeSourceBinding {
  readonly pluginId: string
  readonly pluginGeneration: string
  readonly serviceId: string
  readonly loginTimeoutMs?: number
  readonly source: ManagedServiceSourceV1
  readonly webEntry?: ManagedServiceWebEntryReader
}

export interface ManagedServiceSourceOptions {
  readonly profileId: string
  readonly runtimeGeneration: string
  readonly registrationHandle: ManagedServiceRegistrationHandleV1
  readonly healthIntervalMs: number
  readonly displayName: string
  readonly serviceKind: string
  readonly pluginId: string
  readonly pluginGeneration: string
  readonly serviceId: string
  readonly source?: `https://${string}`
  readonly authenticationMode: 'none' | 'host-secret' | 'cli'
  readonly logoutAvailable: boolean
  readonly extensionFactory?: (binding: ManagedServiceBindingV1) => ManagedServiceNodeUISourceExtensionV1
}

function safeBinding(options: ManagedServiceSourceOptions): ManagedServiceBindingV1 {
  return Object.freeze({
    bindingId: randomUUID(),
    identity: Object.freeze({
      ...(options.source === undefined ? {} : { source: options.source }),
      pluginId: options.pluginId,
      serviceId: options.serviceId,
    }),
    scope: Object.freeze({
      profileId: options.profileId,
      generation: options.runtimeGeneration,
    }),
  })
}

function mapReadiness(state: RuntimeManagedServiceProjectionV1['state']): ManagedServiceReadinessV1 {
  switch (state) {
    case 'registered':
    case 'preparing':
      return 'starting'
    case 'ready':
      return 'ready'
    case 'authentication-required':
      return 'stopped'
    case 'failed':
      return 'failed'
    case 'stopped':
    case 'disposed':
      return 'stopped'
  }
}

function mapHealthLevel(
  health: RuntimeManagedServiceProjectionV1['health'],
): ManagedServiceHealthProjectionV1['level'] {
  switch (health) {
    case 'starting':
      return 'warning'
    case 'ready':
      return 'healthy'
    case 'degraded':
      return 'warning'
    case 'unhealthy':
      return 'critical'
    case 'stopped':
      return 'critical'
  }
}

function mapAuth(
  options: ManagedServiceSourceOptions,
  projection: RuntimeManagedServiceProjectionV1,
  loggedOut: boolean,
): ManagedServiceAuthProjectionV1 {
  const auth = projection.authentication
  const state: ManagedServiceAuthProjectionV1['state'] = options.authenticationMode === 'none'
    ? 'missing'
    : auth.state === 'configured'
    ? 'authenticated'
    : loggedOut
    ? 'logged-out'
    : 'missing'
  return Object.freeze({
    state,
    accountHint: options.pluginId,
    ...(options.authenticationMode === 'cli' ? { providerLabel: options.serviceId } : {}),
  })
}

function mapDiagnostics(projection: RuntimeManagedServiceProjectionV1): readonly ManagedServiceDiagnosticV1[] {
  if (projection.diagnostic === undefined) return Object.freeze([])
  return Object.freeze([Object.freeze({
    code: projection.diagnostic.code,
    ...(projection.diagnostic.message === undefined ? {} : { message: projection.diagnostic.message }),
    retryable: projection.diagnostic.retryable,
  })])
}

function mapCapabilities(
  options: ManagedServiceSourceOptions,
  extension: ManagedServiceNodeUISourceExtensionV1 | undefined,
): ManagedServiceCapabilitiesV1 {
  return Object.freeze({
    explicitLogin: options.authenticationMode === 'cli',
    logout: options.logoutAvailable,
    readCatalog: extension?.readCatalog !== undefined,
  })
}

function mapUserAction(
  options: ManagedServiceSourceOptions,
  projection: RuntimeManagedServiceProjectionV1,
): ManagedServiceLoginActionV1 {
  if (options.authenticationMode === 'none') {
    return Object.freeze({ available: false, reason: 'policy-denied' })
  }
  if (projection.state === 'disposed') {
    return Object.freeze({ available: false, reason: 'generation-stale' })
  }
  if (projection.authentication.state === 'configured') {
    return Object.freeze({ available: false, reason: 'already-authenticated' })
  }
  if (projection.state === 'authentication-required') {
    return Object.freeze({ available: true, reason: 'ready' })
  }
  if (projection.state === 'ready') {
    return Object.freeze({ available: true, reason: 'ready' })
  }
  return Object.freeze({ available: false, reason: 'service-not-ready' })
}

function projectUI(
  options: ManagedServiceSourceOptions,
  extension: ManagedServiceNodeUISourceExtensionV1 | undefined,
  binding: ManagedServiceBindingV1,
  projection: RuntimeManagedServiceProjectionV1,
  sequence: number,
  observedAt: string,
  loggedOut: boolean,
): ManagedServiceProjectionV1 {
  return Object.freeze({
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-projection.v1.schema.json',
    contract: 'cordisx.managed-service-projection/v1',
    schemaVersion: 1,
    binding,
    sequence,
    observedAt,
    identity: Object.freeze({
      ...(options.source === undefined ? {} : { source: options.source }),
      pluginId: options.pluginId,
      serviceId: options.serviceId,
    }),
    displayName: options.displayName,
    serviceKind: options.serviceKind,
    readiness: mapReadiness(projection.state),
    ...(projection.binding.serviceGeneration === undefined
      ? {}
      : { serviceGeneration: projection.binding.serviceGeneration }),
    auth: mapAuth(options, projection, loggedOut),
    health: Object.freeze({ level: mapHealthLevel(projection.health) }),
    diagnostics: mapDiagnostics(projection),
    capabilities: mapCapabilities(options, extension),
    userAction: mapUserAction(options, projection),
  })
}

function deltaChanged(
  previous: ManagedServiceProjectionV1,
  current: ManagedServiceProjectionV1,
): ManagedServiceProjectionUpdateV1 | undefined {
  const delta: {
    readiness?: ManagedServiceReadinessV1
    auth?: ManagedServiceAuthProjectionV1
    health?: ManagedServiceHealthProjectionV1
    diagnostics?: readonly ManagedServiceDiagnosticV1[]
    userAction?: ManagedServiceLoginActionV1
  } = {}
  if (current.readiness !== previous.readiness) delta.readiness = current.readiness
  if (!isDeepStrictEqual(current.auth, previous.auth)) delta.auth = current.auth
  if (!isDeepStrictEqual(current.health, previous.health)) delta.health = current.health
  if (!isDeepStrictEqual(current.diagnostics, previous.diagnostics)) delta.diagnostics = current.diagnostics
  if (!isDeepStrictEqual(current.userAction, previous.userAction)) delta.userAction = current.userAction
  if (Object.keys(delta).length === 0) return undefined
  return Object.freeze({ kind: 'state-changed', sequence: current.sequence, delta: Object.freeze(delta) })
}

function projectionFields(value: ManagedServiceProjectionV1, ignored: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !ignored.has(key)))
}
const observationFields = new Set(['sequence', 'observedAt'])
const deltaFields = new Set([
  ...observationFields,
  'readiness',
  'auth',
  'health',
  'diagnostics',
  'userAction',
])
function sameProjection(left: ManagedServiceProjectionV1, right: ManagedServiceProjectionV1): boolean {
  return isDeepStrictEqual(projectionFields(left, observationFields), projectionFields(right, observationFields))
}
function projectionUpdate(
  previous: ManagedServiceProjectionV1,
  current: ManagedServiceProjectionV1,
): ManagedServiceProjectionUpdateV1 | undefined {
  if (sameProjection(previous, current)) return undefined
  if (isDeepStrictEqual(projectionFields(previous, deltaFields), projectionFields(current, deltaFields))) {
    const delta = deltaChanged(previous, current)
    if (delta !== undefined) return delta
  }
  return Object.freeze({ kind: 'snapshot-replaced', sequence: current.sequence, projection: current })
}

async function waitInterval(intervalMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('cancelled'))
      return
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, intervalMs)
    const onAbort = (): void => {
      clearTimeout(timeout)
      reject(signal.reason ?? new Error('cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Create a Host-private, renderer-safe ManagedServiceSourceV1 adapter. */
export function createManagedServiceSource(
  options: ManagedServiceSourceOptions,
): ManagedServiceSourceV1 {
  if (options.registrationHandle.binding.identity.pluginId !== options.pluginId) {
    throw new Error('managed service source plugin id mismatch')
  }
  if (options.registrationHandle.binding.identity.serviceId !== options.serviceId) {
    throw new Error('managed service source service id mismatch')
  }
  const binding = safeBinding(options)
  const extension = options.extensionFactory?.(binding)
  let disposed = false
  let sequence = 0
  let lastProjection: ManagedServiceProjectionV1 | undefined
  let loggedOut = false
  let authenticationInFlight = false
  let inspection: Promise<void> = Promise.resolve()
  interface SubscriptionHandle {
    readonly deliverPage: (phase: 'replay' | 'live', updates: ManagedServiceProjectionUpdateV1[]) => void
    readonly closed: () => boolean
    currentSequence: number
    lastProjection: ManagedServiceProjectionV1 | undefined
  }
  const subscriptionHandles: SubscriptionHandle[] = []
  const ensureNotDisposed = (): void => {
    if (disposed) throw new Error('managed service source is disposed')
  }
  const advanceSequence = (): void => {
    if (sequence >= Number.MAX_SAFE_INTEGER) throw new Error('managed service sequence is exhausted')
    sequence += 1
  }
  const readProjection = async () => {
    const reading = inspection.then(async () => {
      ensureNotDisposed()
      const runtimeProjection = await options.registrationHandle.inspect()
      ensureNotDisposed()
      const candidate = projectUI(
        options,
        extension,
        binding,
        runtimeProjection,
        sequence,
        new Date().toISOString(),
        loggedOut,
      )
      if (lastProjection === undefined || !sameProjection(lastProjection, candidate)) advanceSequence()
      const projection = Object.freeze({ ...candidate, sequence })
      lastProjection = projection
      return { projection, state: runtimeProjection.state }
    })
    inspection = reading.then(() => undefined, () => undefined)
    return await reading
  }

  const refreshAndBroadcast = () => {
    void (async () => {
      try {
        const { projection: uiProjection } = await readProjection()
        // Snapshot handles to avoid mutation during iteration
        const handles = subscriptionHandles.slice()
        for (const handle of handles) {
          if (handle.closed()) continue
          if (handle.lastProjection === undefined) {
            handle.lastProjection = uiProjection
            continue
          }
          const delta = projectionUpdate(handle.lastProjection, uiProjection)
          if (delta === undefined) continue
          handle.lastProjection = uiProjection
          handle.currentSequence = delta.sequence
          handle.deliverPage('live', [delta])
        }
      } catch {
        // silent — poll will catch up
      }
    })()
  }

  const snapshot = async (): Promise<ManagedServiceSnapshotResultV1> => {
    const { projection: uiProjection } = await readProjection()
    return Object.freeze({ status: 'available', projection: uiProjection })
  }

  const source = {
    binding,

    snapshot,

    subscribe(afterSequence: number): Promise<ManagedServiceSubscribeResultV1> {
      ensureNotDisposed()
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence > sequence) {
        return Promise.resolve({ status: 'unavailable', code: 'stale-generation' })
      }
      const controller = new AbortController()
      let disposedSubscription = false
      let closed = false
      let closedResolve!: (value: ManagedServiceSubscriptionClosedV1) => void
      const closedPromise = new Promise<ManagedServiceSubscriptionClosedV1>(resolve => {
        closedResolve = resolve
      })
      const subscriptionId = randomUUID()
      let descriptorSnapshotSequence = 0
      const descriptor: ManagedServiceSubscriptionDescriptorV1 = {
        subscriptionId,
        binding,
        afterSequence,
        get snapshotSequence() {
          return descriptorSnapshotSequence
        },
      }
      let currentSequence = sequence
      let snapshotSequence = 0
      const updates: ManagedServiceProjectionUpdateV1[] = []
      const pendingPullResolvers: Array<(value: IteratorResult<ManagedServiceSubscriptionPageV1>) => void> = []
      let pageBuffer: ManagedServiceSubscriptionPageV1[] = []
      const pages: AsyncIterable<ManagedServiceSubscriptionPageV1> = {
        [Symbol.asyncIterator](): AsyncIterator<ManagedServiceSubscriptionPageV1> {
          return {
            async next(): Promise<IteratorResult<ManagedServiceSubscriptionPageV1>> {
              if (closed) {
                return { done: true, value: undefined }
              }
              if (pageBuffer.length > 0) {
                return { done: false, value: pageBuffer.shift()! }
              }
              return await new Promise<IteratorResult<ManagedServiceSubscriptionPageV1>>(resolve => {
                pendingPullResolvers.push(resolve)
              })
            },
          }
        },
      }

      const deliverPage = (phase: 'replay' | 'live', pageUpdates: ManagedServiceProjectionUpdateV1[]): void => {
        if (pageUpdates.length === 0) return
        const page: ManagedServiceSubscriptionPageV1 = Object.freeze({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-subscription-page.v1.schema.json',
          contract: 'cordisx.managed-service-subscription-page/v1',
          schemaVersion: 1,
          subscription: descriptor,
          phase,
          updates: Object.freeze(pageUpdates),
          nextAfterSequence: handle.currentSequence,
          hasMore: false,
        })
        if (pendingPullResolvers.length > 0) {
          pendingPullResolvers.shift()!({ done: false, value: page })
        } else {
          pageBuffer.push(page)
        }
      }

      const handle: SubscriptionHandle = {
        deliverPage,
        closed: () => closed || disposedSubscription,
        currentSequence,
        lastProjection: undefined,
      }
      subscriptionHandles.push(handle)

      const emitClosed = (reason: ManagedServiceSubscriptionClosedV1['reason']): void => {
        if (closed) return
        closed = true
        const idx = subscriptionHandles.indexOf(handle)
        if (idx !== -1) subscriptionHandles.splice(idx, 1)
        controller.abort()
        const closedResult: ManagedServiceSubscriptionClosedV1 = Object.freeze({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-subscription-close.v1.schema.json',
          contract: 'cordisx.managed-service-subscription-close/v1',
          schemaVersion: 1,
          subscription: descriptor,
          closedAt: new Date().toISOString(),
          reason,
        })
        closedResolve(closedResult)
        for (const resolver of pendingPullResolvers) {
          resolver({ done: true, value: undefined })
        }
        pendingPullResolvers.length = 0
      }

      const unsubscribe = async (): Promise<ManagedServiceSubscriptionClosedV1> => {
        if (disposedSubscription) {
          return await closedPromise
        }
        disposedSubscription = true
        emitClosed('explicit')
        return await closedPromise
      }

      const subscription = {
        descriptor,
        pages,
        closed: closedPromise,
        unsubscribe,
      } as unknown as ManagedServiceSubscriptionV1

      const subscriptionDispose = (): void => {
        controller.abort()
        const idx = subscriptionHandles.indexOf(handle)
        if (idx !== -1) subscriptionHandles.splice(idx, 1)
        if (!disposedSubscription) {
          emitClosed('owner-disposed')
        }
      }

      const poll = async (): Promise<void> => {
        try {
          while (!controller.signal.aborted && !disposed && !disposedSubscription) {
            await waitInterval(options.healthIntervalMs, controller.signal)
            if (controller.signal.aborted || disposed || disposedSubscription) break

            const { projection: uiProjection, state } = await readProjection()
            if (controller.signal.aborted || disposed || disposedSubscription) break

            if (state === 'disposed') {
              emitClosed('service-disposed')
              break
            }

            if (snapshotSequence === 0) {
              currentSequence = uiProjection.sequence
              handle.currentSequence = currentSequence
              snapshotSequence = currentSequence
              descriptorSnapshotSequence = snapshotSequence
              const pageUpdate: ManagedServiceProjectionUpdateV1 = Object.freeze({
                kind: 'snapshot-replaced',
                sequence: currentSequence,
                projection: uiProjection,
              })
              updates.push(pageUpdate)
              deliverPage('replay', [pageUpdate])
              handle.lastProjection = uiProjection
            } else {
              const delta = handle.lastProjection !== undefined
                ? projectionUpdate(handle.lastProjection, uiProjection)
                : undefined
              if (delta !== undefined) {
                currentSequence = uiProjection.sequence
                handle.currentSequence = currentSequence
                updates.push(delta)
                deliverPage('live', [delta])
                handle.lastProjection = uiProjection
              }
            }

            if (updates.length > SUBSCRIPTION_PAGE_MAX_UPDATES) {
              updates.length = 0
              const snapshotUpdate: ManagedServiceProjectionUpdateV1 = Object.freeze({
                kind: 'snapshot-replaced',
                sequence: currentSequence,
                projection: uiProjection,
              })
              updates.push(snapshotUpdate)
            }
          }
        } catch (error) {
          if (!closed && !disposedSubscription) {
            emitClosed('service-disposed')
          }
        }
      }

      void poll()
      return Promise.resolve(Object.freeze({
        status: 'subscribed' as const,
        subscription: Object.freeze({
          ...subscription,
          dispose: subscriptionDispose,
        }) as unknown as ManagedServiceSubscriptionV1,
      }))
    },

    authenticate(request: ManagedServiceLoginRequestV1): Promise<ManagedServiceLoginResultV1> {
      ensureNotDisposed()
      if (authenticationInFlight) {
        return Promise.resolve(Object.freeze({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-login-result.v1.schema.json',
          contract: 'cordisx.managed-service-login-result/v1',
          schemaVersion: 1,
          requestId: request.requestId,
          binding,
          status: 'denied' as const,
          error: Object.freeze({ code: 'authenticating' as const, message: 'authentication is already in progress' }),
        }))
      }
      if (request.binding.bindingId !== binding.bindingId) {
        return Promise.resolve(Object.freeze({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-login-result.v1.schema.json',
          contract: 'cordisx.managed-service-login-result/v1',
          schemaVersion: 1,
          requestId: request.requestId,
          binding,
          status: 'failed' as const,
          error: Object.freeze({ code: 'binding-replaced' as const, message: 'binding was replaced' }),
        }))
      }
      if (request.expectedSequence !== sequence) {
        return Promise.resolve(Object.freeze({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-login-result.v1.schema.json',
          contract: 'cordisx.managed-service-login-result/v1',
          schemaVersion: 1,
          requestId: request.requestId,
          binding,
          status: 'denied' as const,
          error: Object.freeze({ code: 'stale-revision' as const, message: 'projection sequence is stale' }),
        }))
      }
      authenticationInFlight = true
      return Promise.resolve().then(async () => await options.registrationHandle.authenticate('login')).then(result => {
        ensureNotDisposed()
        advanceSequence()
        if (result.status === 'accepted' || result.status === 'ready') {
          loggedOut = false
          refreshAndBroadcast()
          return Object.freeze({
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-login-result.v1.schema.json',
            contract: 'cordisx.managed-service-login-result/v1',
            schemaVersion: 1,
            requestId: request.requestId,
            binding,
            status: 'accepted' as const,
            stateAt: 'authenticated' as const,
            sequence,
          })
        }
        return Object.freeze({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-login-result.v1.schema.json',
          contract: 'cordisx.managed-service-login-result/v1',
          schemaVersion: 1,
          requestId: request.requestId,
          binding,
          status: 'failed' as const,
          error: Object.freeze({
            code: 'authentication-failed' as const,
            message: 'diagnostic' in result ? result.diagnostic.code : result.status,
          }),
        })
      }).catch((error: unknown) => {
        return Object.freeze({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-login-result.v1.schema.json',
          contract: 'cordisx.managed-service-login-result/v1',
          schemaVersion: 1,
          requestId: request.requestId,
          binding,
          status: 'failed' as const,
          error: Object.freeze({
            code: 'authentication-failed' as const,
            message: error instanceof Error ? error.message : 'authentication failed',
          }),
        })
      }).finally(() => {
        authenticationInFlight = false
      })
    },
    logout(request: ManagedServiceLogoutRequestV1): Promise<ManagedServiceLogoutResultV1> {
      ensureNotDisposed()
      const unavailable = (
        status: 'denied' | 'failed' | 'unavailable',
        code:
          | 'binding-replaced'
          | 'stale-revision'
          | 'service-unavailable'
          | 'authentication-failed'
          | 'authenticating',
        message: string,
      ): ManagedServiceLogoutResultV1 =>
        Object.freeze({
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-logout-result.v1.schema.json',
          contract: 'cordisx.managed-service-logout-result/v1',
          schemaVersion: 1,
          requestId: request.requestId,
          binding,
          status,
          error: Object.freeze({ code, message }),
        })
      if (authenticationInFlight) {
        return Promise.resolve(unavailable('denied', 'authenticating', 'authentication is already in progress'))
      }
      if (request.binding.bindingId !== binding.bindingId) {
        return Promise.resolve(unavailable('failed', 'binding-replaced', 'binding was replaced'))
      }
      if (request.expectedSequence !== sequence) {
        return Promise.resolve(unavailable('denied', 'stale-revision', 'projection sequence is stale'))
      }
      if (!options.logoutAvailable) {
        return Promise.resolve(unavailable('unavailable', 'service-unavailable', 'logout is unavailable'))
      }
      authenticationInFlight = true
      return Promise.resolve().then(async () => await options.registrationHandle.authenticate('logout')).then(
        result => {
          ensureNotDisposed()
          advanceSequence()
          if (result.status === 'accepted' || result.status === 'ready') {
            loggedOut = true
            refreshAndBroadcast()
            return Object.freeze({
              $schema:
                'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-logout-result.v1.schema.json',
              contract: 'cordisx.managed-service-logout-result/v1',
              schemaVersion: 1,
              requestId: request.requestId,
              binding,
              status: 'accepted' as const,
              stateAt: 'logged-out' as const,
              sequence,
            })
          }
          return unavailable(
            'failed',
            'authentication-failed',
            'diagnostic' in result ? result.diagnostic.code : result.status,
          )
        },
      ).catch((error: unknown) =>
        unavailable('failed', 'authentication-failed', error instanceof Error ? error.message : 'logout failed')
      ).finally(() => {
        authenticationInFlight = false
      })
    },
    ...(extension?.readCatalog === undefined
      ? {}
      : { readCatalog: () => extension.readCatalog!() }),
    ...(extension?.readAccounts === undefined
      ? {}
      : { readAccounts: () => extension.readAccounts!() }),
    ...(extension?.toggleAccount === undefined
      ? {}
      : {
        toggleAccount: (request: Parameters<NonNullable<ManagedServiceNodeUISourceExtensionV1['toggleAccount']>>[0]) =>
          extension.toggleAccount!(request),
      }),
    ...(extension?.startOAuth === undefined
      ? {}
      : {
        startOAuth: (request: Parameters<NonNullable<ManagedServiceNodeUISourceExtensionV1['startOAuth']>>[0]) =>
          extension.startOAuth!(request),
      }),
    ...(extension?.pollOAuth === undefined
      ? {}
      : { pollOAuth: (sessionId: string) => extension.pollOAuth!(sessionId) }),
    ...(extension?.cancelOAuth === undefined
      ? {}
      : {
        cancelOAuth: (request: Parameters<NonNullable<ManagedServiceNodeUISourceExtensionV1['cancelOAuth']>>[0]) =>
          extension.cancelOAuth!(request),
      }),
  }

  return source as unknown as ManagedServiceSourceV1
}
