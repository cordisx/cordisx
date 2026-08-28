import { randomUUID, timingSafeEqual } from 'node:crypto'
import {
  updateHomeConfigAtomic,
  type HomeConfigIconThemePreference,
} from '../config/home-config.js'

export const ICON_THEME_PREFERENCE_BINDING = '__cordisxIconThemePreferenceRequestV1'
export const ICON_THEME_PREFERENCE_RECEIVER = '__cordisxIconThemePreferenceReceiveV1'
export const MAX_ICON_THEME_PREFERENCE_REQUEST_BYTES = 16 * 1024

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const PROVIDER_ID = /^(?:builtin:[a-z0-9][a-z0-9._-]{0,63}|plugin:[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,63})$/
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export interface IconThemePreferenceCandidate {
  readonly providerId: HomeConfigIconThemePreference['providerId']
  readonly namespace: string
  readonly providerVersion: string
  readonly providerGeneration: string
}

export interface IconThemePreferenceBindingRequest {
  readonly requestId: string
  readonly expectedPreferenceRevision: number
  readonly expectedProfileRevision: number
  readonly selectedProfileRevision: number
  readonly candidate: IconThemePreferenceCandidate
}

export interface IconThemePreferenceDocumentReadyRequest {
  readonly requestId: string
  readonly documentEpoch: string
  readonly currentRevision: number
}

export interface IconThemePreferenceDeliveryAck {
  readonly documentEpoch: string
  readonly currentRevision: number
}

export interface IconThemePreferenceReadyResponseAck extends IconThemePreferenceDeliveryAck {
  readonly readyLeaseToken: string
  readonly readyLeaseRevision: number
}

export interface IconThemePreferenceDocumentReceiver {
  readonly receive: (preference: HomeConfigIconThemePreference) => Promise<IconThemePreferenceDeliveryAck>
}

export interface IconThemePreferenceDocumentIdentity {
  readonly targetId: string
  readonly sessionId: string
  readonly documentEpoch: string
  readonly executionContextId: number
  readonly currentRevision: number
  readonly signal: AbortSignal
}

export interface IconThemePreferenceDocumentSynchronization {
  readonly synchronization: 'complete' | 'pending'
  readonly requiredRevision: number
  readonly currentRevision: number
}

export interface IconThemePreferenceReadyResponseLease {
  readonly token: string
  readonly revision: number
  readonly requiredRevision: number
  readonly signal: AbortSignal
}

export interface IconThemePreferenceDocumentRegistration {
  readonly currentRevision: number
  readonly synchronization: 'complete' | 'pending'
  respondReady(
    probeAck: IconThemePreferenceDeliveryAck,
    respond: (
      status: IconThemePreferenceDocumentSynchronization,
      lease: IconThemePreferenceReadyResponseLease,
    ) => Promise<IconThemePreferenceReadyResponseAck>,
  ): Promise<IconThemePreferenceDocumentSynchronization>
  unregister(): void
}

export interface IconThemePreferenceDocumentReservation {
  register(receiver: IconThemePreferenceDocumentReceiver): Promise<IconThemePreferenceDocumentRegistration>
  cancel(): void
}

export interface IconThemePreferenceBroadcastResult {
  readonly attempted: number
  readonly delivered: number
  readonly failed: number
  readonly pending: number
}

export interface IconThemePreferencePersistenceContext {
  readonly configPath: string
  readonly appId: string
  readonly profileId: string
  readonly hostGeneration: string
  readonly token: string
}

interface IconThemePreferenceDocumentState {
  active: boolean
  booting: boolean
  tail: Promise<void>
  ackedRevision: number
  pending: HomeConfigIconThemePreference | undefined
  readonly cancellation: AbortController
  removeExternalAbort: (() => void) | undefined
  readonly identity: IconThemePreferenceDocumentIdentity
  readonly documentKey: string
  readonly entryGeneration: number
  readyLease: IconThemePreferenceReadyLease | undefined
  receiver: IconThemePreferenceDocumentReceiver | undefined
}

interface IconThemePreferenceReadyLease {
  readonly token: string
  readonly revision: number
  readonly requiredRevision: number
  readonly documentKey: string
  readonly entryGeneration: number
  readonly status: IconThemePreferenceDocumentSynchronization
  readonly cancellation: AbortController
}

export class IconThemePreferenceConflictError extends Error {
  constructor(
    readonly actualRevision: number,
    readonly currentPreference: HomeConfigIconThemePreference | undefined,
  ) {
    super(`icon theme preference revision conflict: expected a different revision; actual ${actualRevision}`)
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} shape is invalid`)
  }
}

function sameToken(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function revision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid`)
  return value as number
}

function samePreference(left: HomeConfigIconThemePreference, right: HomeConfigIconThemePreference): boolean {
  return left.revision === right.revision
    && left.providerId === right.providerId
    && left.namespace === right.namespace
    && left.providerVersion === right.providerVersion
    && left.providerGeneration === right.providerGeneration
}

function candidate(value: unknown): IconThemePreferenceCandidate {
  const item = object(value, 'icon theme preference candidate')
  exact(item, ['providerId', 'namespace', 'providerVersion', 'providerGeneration'], 'icon theme preference candidate')
  if (typeof item.providerId !== 'string' || !PROVIDER_ID.test(item.providerId)
    || typeof item.namespace !== 'string' || !ID.test(item.namespace)
    || typeof item.providerVersion !== 'string' || !SEMVER.test(item.providerVersion)
    || typeof item.providerGeneration !== 'string' || !GENERATION.test(item.providerGeneration)) {
    throw new Error('icon theme preference candidate is invalid')
  }
  return {
    providerId: item.providerId as HomeConfigIconThemePreference['providerId'],
    namespace: item.namespace,
    providerVersion: item.providerVersion,
    providerGeneration: item.providerGeneration,
  }
}

export function parseIconThemePreferenceBindingRequest(
  value: unknown,
  context: Omit<IconThemePreferencePersistenceContext, 'configPath'>,
): IconThemePreferenceBindingRequest {
  const request = object(value, 'icon theme preference request')
  exact(request, [
    'version', 'token', 'requestId', 'scope', 'expectedPreferenceRevision',
    'expectedProfileRevision', 'selectedProfileRevision', 'candidate',
  ], 'icon theme preference request')
  if (request.version !== 1) throw new Error('icon theme preference request version is invalid')
  if (typeof request.token !== 'string' || !sameToken(request.token, context.token)) throw new Error('icon theme preference token is invalid')
  if (typeof request.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(request.requestId)) throw new Error('icon theme preference request id is invalid')
  const scope = object(request.scope, 'icon theme preference scope')
  exact(scope, ['appId', 'profileId', 'hostGeneration'], 'icon theme preference scope')
  if (scope.appId !== context.appId || scope.profileId !== context.profileId || scope.hostGeneration !== context.hostGeneration) {
    throw new Error('icon theme preference scope is stale or spoofed')
  }
  const expectedProfileRevision = revision(request.expectedProfileRevision, 'icon theme expected profile revision')
  const selectedProfileRevision = revision(request.selectedProfileRevision, 'icon theme selected profile revision')
  if (selectedProfileRevision !== expectedProfileRevision + 1) throw new Error('icon theme profile revision transition is invalid')
  return {
    requestId: request.requestId,
    expectedPreferenceRevision: revision(request.expectedPreferenceRevision, 'icon theme expected preference revision'),
    expectedProfileRevision,
    selectedProfileRevision,
    candidate: candidate(request.candidate),
  }
}

export function parseIconThemePreferenceDocumentReadyRequest(
  value: unknown,
  context: Omit<IconThemePreferencePersistenceContext, 'configPath'>,
): IconThemePreferenceDocumentReadyRequest {
  const request = object(value, 'icon theme preference document ready request')
  exact(request, ['version', 'kind', 'token', 'requestId', 'scope', 'documentEpoch', 'currentRevision'], 'icon theme preference document ready request')
  if (request.version !== 1 || request.kind !== 'document-ready') throw new Error('icon theme preference document ready version is invalid')
  if (typeof request.token !== 'string' || !sameToken(request.token, context.token)) throw new Error('icon theme preference token is invalid')
  if (typeof request.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(request.requestId)) throw new Error('icon theme preference request id is invalid')
  const scope = object(request.scope, 'icon theme preference scope')
  exact(scope, ['appId', 'profileId', 'hostGeneration'], 'icon theme preference scope')
  if (scope.appId !== context.appId || scope.profileId !== context.profileId || scope.hostGeneration !== context.hostGeneration) {
    throw new Error('icon theme preference scope is stale or spoofed')
  }
  if (typeof request.documentEpoch !== 'string' || !/^[A-Za-z0-9_-]{8,96}$/.test(request.documentEpoch)) {
    throw new Error('icon theme preference document epoch is invalid')
  }
  return {
    requestId: request.requestId,
    documentEpoch: request.documentEpoch,
    currentRevision: revision(request.currentRevision, 'icon theme preference current revision'),
  }
}

export async function persistIconThemePreference(
  context: IconThemePreferencePersistenceContext,
  request: IconThemePreferenceBindingRequest,
): Promise<HomeConfigIconThemePreference> {
  let persisted: HomeConfigIconThemePreference | undefined
  await updateHomeConfigAtomic(current => {
    const app = Object.hasOwn(current.apps, context.appId) ? current.apps[context.appId] : undefined
    const profile = app !== undefined && Object.hasOwn(app.profiles, context.profileId) ? app.profiles[context.profileId] : undefined
    if (app === undefined || profile === undefined) throw new Error('icon theme preference profile is unavailable')
    const actualRevision = profile.iconTheme?.revision ?? 0
    if (actualRevision !== request.expectedPreferenceRevision) {
      throw new IconThemePreferenceConflictError(actualRevision, profile.iconTheme)
    }
    persisted = { revision: actualRevision + 1, ...request.candidate }
    return {
      ...current,
      apps: {
        ...current.apps,
        [context.appId]: {
          ...app,
          profiles: {
            ...app.profiles,
            [context.profileId]: { ...profile, iconTheme: persisted },
          },
        },
      },
    }
  }, context.configPath)
  if (persisted === undefined) throw new Error('icon theme preference persistence failed')
  return persisted
}

export function iconThemePreferenceBridgeError(error: unknown): {
  readonly code: string
  readonly error: string
  readonly actualRevision?: number
  readonly currentPreference?: HomeConfigIconThemePreference
} {
  if (error instanceof IconThemePreferenceConflictError) {
    return {
      code: 'conflict', error: error.message, actualRevision: error.actualRevision,
      ...(error.currentPreference === undefined ? {} : { currentPreference: error.currentPreference }),
    }
  }
  return { code: 'rejected', error: error instanceof Error ? error.message : String(error) }
}

/** Host-private fan-out for durable preference convergence within one profile. */
export class IconThemePreferenceBroadcastHub {
  private readonly receivers = new Map<string, IconThemePreferenceDocumentState>()
  private winner: HomeConfigIconThemePreference | undefined
  private operationTail = Promise.resolve()
  private operationDepth = 0
  private nextEntryGeneration = 1
  private nextReadyLeaseRevision = 1

  constructor(
    readonly appId: string,
    readonly profileId: string,
  ) {}

  assertScope(context: Pick<IconThemePreferencePersistenceContext, 'appId' | 'profileId'>): void {
    if (context.appId !== this.appId || context.profileId !== this.profileId) {
      throw new Error('icon theme preference broadcast scope is mismatched')
    }
  }

  reserve(identity: IconThemePreferenceDocumentIdentity): IconThemePreferenceDocumentReservation {
    if (!Number.isSafeInteger(identity.executionContextId) || identity.executionContextId < 0) {
      throw new Error('icon theme preference document execution context is invalid')
    }
    const key = `${identity.targetId}\u0000${identity.sessionId}`
    const documentKey = `${key}\u0000${identity.documentEpoch}\u0000${identity.executionContextId}`
    const previous = this.receivers.get(key)
    if (previous !== undefined) this.deactivate(key, previous)
    const cancellation = new AbortController()
    const entry: IconThemePreferenceDocumentState = {
      active: true,
      booting: true,
      tail: Promise.resolve(),
      ackedRevision: identity.currentRevision,
      pending: this.winner !== undefined && identity.currentRevision < this.winner.revision
        ? { ...this.winner }
        : undefined,
      cancellation,
      removeExternalAbort: undefined,
      identity,
      documentKey,
      entryGeneration: this.nextEntryGeneration++,
      readyLease: undefined,
      receiver: undefined,
    }
    this.receivers.set(key, entry)
    const externalAbort = (): void => this.deactivate(key, entry)
    identity.signal.addEventListener('abort', externalAbort, { once: true })
    entry.removeExternalAbort = () => identity.signal.removeEventListener('abort', externalAbort)
    if (identity.signal.aborted) this.deactivate(key, entry)
    return {
      register: async receiver => await this.activate(key, entry, receiver),
      cancel: () => this.deactivate(key, entry),
    }
  }

  async register(identity: IconThemePreferenceDocumentIdentity & IconThemePreferenceDocumentReceiver): Promise<IconThemePreferenceDocumentRegistration> {
    const reservation = this.reserve(identity)
    const registration = await reservation.register({ receive: identity.receive })
    await registration.respondReady(
      { documentEpoch: identity.documentEpoch, currentRevision: registration.currentRevision },
      async (status, lease) => ({
        documentEpoch: identity.documentEpoch,
        currentRevision: status.currentRevision,
        readyLeaseToken: lease.token,
        readyLeaseRevision: lease.revision,
      }),
    )
    return registration
  }

  async broadcast(preference: HomeConfigIconThemePreference): Promise<IconThemePreferenceBroadcastResult> {
    const entries = await this.serialize(() => {
      if (this.winner !== undefined) {
        if (preference.revision < this.winner.revision) return []
        if (preference.revision === this.winner.revision
          && !samePreference(preference, this.winner)) {
          throw new Error('icon theme preference winner revision is divergent')
        }
      }
      // Durable cache advancement is intentionally independent from delivery.
      // A failed/destroyed document never rolls the winner back.
      this.winner = { ...preference }
      for (const entry of this.receivers.values()) {
        const lease = entry.readyLease
        if (entry.active && lease !== undefined && lease.requiredRevision < preference.revision) {
          entry.readyLease = undefined
          lease.cancellation.abort()
        }
      }
      const pending = [...this.receivers.values()].filter(entry => entry.active && entry.ackedRevision < preference.revision)
      for (const entry of pending) entry.pending = { ...preference }
      return pending.filter(entry => entry.receiver !== undefined)
    })
    const deliverable = entries
    const results = await Promise.all(deliverable.map(async entry => await this.enqueue(entry)))
    const attempted = results.filter(result => result !== 'inactive').length
    const delivered = results.filter(result => result === 'delivered').length
    return {
      attempted,
      delivered,
      failed: results.filter(result => result === 'failed').length,
      pending: this.pendingCount(),
    }
  }

  current(): HomeConfigIconThemePreference | undefined {
    return this.winner === undefined ? undefined : { ...this.winner }
  }

  async retryPending(): Promise<IconThemePreferenceBroadcastResult> {
    if (this.winner === undefined) return { attempted: 0, delivered: 0, failed: 0, pending: 0 }
    return await this.broadcast(this.winner)
  }

  private async serialize<Value>(operation: () => Value): Promise<Value> {
    const result = this.operationTail.then(() => {
      this.operationDepth += 1
      try {
        const value = operation()
        if (value !== null && typeof value === 'object' && 'then' in value) {
          throw new Error('icon theme preference profile operation lock cannot await external work')
        }
        return value
      } finally {
        this.operationDepth -= 1
      }
    })
    this.operationTail = result.then(() => undefined, () => undefined)
    return await result
  }

  private pendingCount(): number {
    return [...this.receivers.values()].filter(entry => entry.active && (entry.booting || entry.pending !== undefined)).length
  }

  private async activate(
    key: string,
    entry: IconThemePreferenceDocumentState,
    receiver: IconThemePreferenceDocumentReceiver,
  ): Promise<IconThemePreferenceDocumentRegistration> {
    if (!entry.active || this.receivers.get(key) !== entry || entry.receiver !== undefined) {
      throw new Error('icon theme preference document reservation is stale')
    }
    entry.receiver = receiver
    return {
      get currentRevision() { return entry.ackedRevision },
      get synchronization() { return entry.pending === undefined ? 'complete' as const : 'pending' as const },
      respondReady: async (probeAck, respond) => {
        await this.serializeEntry(entry, async () => await this.serialize(() => {
          this.assertActiveAck(key, entry, probeAck, 0)
          entry.ackedRevision = Math.max(entry.ackedRevision, probeAck.currentRevision)
          this.refreshPending(entry)
        }))
        if (entry.pending !== undefined) await this.enqueue(entry)
        // A ready request normally needs one response. One replacement lease is
        // allowed when a higher durable winner invalidates an in-flight response.
        // Browser.ready() owns the bounded outer redrive rounds.
        for (let responseRound = 0; responseRound < 2; responseRound += 1) {
          const lease = await this.prepareReadyLease(key, entry)
          let responseAck: IconThemePreferenceReadyResponseAck | undefined
          let responseError: unknown
          try {
            responseAck = await this.respondWithReadyLease(respond, lease)
          } catch (error) {
            responseError = error
          }
          const finalized = await this.finalizeReadyLease(key, entry, lease, responseAck)
          if (finalized !== undefined) return finalized
          if (!entry.active) throw new Error('icon theme preference ready acknowledgement is stale')
          if (responseError !== undefined && !lease.cancellation.signal.aborted) throw responseError
          if (entry.pending !== undefined) await this.enqueue(entry)
        }
        const requiredRevision = this.winner?.revision ?? entry.ackedRevision
        return {
          synchronization: 'pending',
          requiredRevision,
          currentRevision: entry.ackedRevision,
        }
      },
      unregister: () => this.deactivate(key, entry),
    }
  }

  private assertActiveAck(
    key: string,
    entry: IconThemePreferenceDocumentState,
    ack: IconThemePreferenceDeliveryAck,
    minimumRevision = entry.ackedRevision,
  ): void {
    this.assertActive(key, entry)
    if (ack.documentEpoch !== entry.identity.documentEpoch
      || !Number.isSafeInteger(ack.currentRevision)
      || ack.currentRevision < minimumRevision) {
      throw new Error('icon theme preference ready acknowledgement is stale')
    }
  }

  private assertActive(key: string, entry: IconThemePreferenceDocumentState): void {
    const documentKey = `${key}\u0000${entry.identity.documentEpoch}\u0000${entry.identity.executionContextId}`
    if (!entry.active || this.receivers.get(key) !== entry || entry.documentKey !== documentKey || entry.identity.signal.aborted) {
      throw new Error('icon theme preference ready acknowledgement is stale')
    }
  }

  private refreshPending(entry: IconThemePreferenceDocumentState): void {
    if (entry.pending !== undefined && entry.ackedRevision >= entry.pending.revision) entry.pending = undefined
    if (this.winner !== undefined && entry.ackedRevision < this.winner.revision) entry.pending = { ...this.winner }
  }

  private async prepareReadyLease(
    key: string,
    entry: IconThemePreferenceDocumentState,
  ): Promise<IconThemePreferenceReadyLease> {
    return await this.serializeEntry(entry, async () => await this.serialize(() => {
      this.assertActive(key, entry)
      this.refreshPending(entry)
      const requiredRevision = this.winner?.revision ?? entry.ackedRevision
      const previous = entry.readyLease
      if (previous !== undefined) previous.cancellation.abort()
      const lease: IconThemePreferenceReadyLease = {
        token: `ready_${randomUUID().replaceAll('-', '_')}`,
        revision: this.nextReadyLeaseRevision++,
        requiredRevision,
        documentKey: entry.documentKey,
        entryGeneration: entry.entryGeneration,
        status: {
          synchronization: entry.pending === undefined && entry.ackedRevision >= requiredRevision ? 'complete' : 'pending',
          requiredRevision,
          currentRevision: entry.ackedRevision,
        },
        cancellation: new AbortController(),
      }
      entry.readyLease = lease
      return lease
    }))
  }

  private async respondWithReadyLease(
    respond: (
      status: IconThemePreferenceDocumentSynchronization,
      lease: IconThemePreferenceReadyResponseLease,
    ) => Promise<IconThemePreferenceReadyResponseAck>,
    lease: IconThemePreferenceReadyLease,
  ): Promise<IconThemePreferenceReadyResponseAck> {
    this.assertExternalCallUnlocked('ready response')
    let rejectCancelled!: (error: Error) => void
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject })
    const onAbort = (): void => rejectCancelled(new Error('icon theme preference ready response lease was invalidated'))
    lease.cancellation.signal.addEventListener('abort', onAbort, { once: true })
    if (lease.cancellation.signal.aborted) onAbort()
    try {
      return await Promise.race([
        respond(lease.status, {
          token: lease.token,
          revision: lease.revision,
          requiredRevision: lease.requiredRevision,
          signal: lease.cancellation.signal,
        }),
        cancelled,
      ])
    } finally {
      lease.cancellation.signal.removeEventListener('abort', onAbort)
    }
  }

  private async finalizeReadyLease(
    key: string,
    entry: IconThemePreferenceDocumentState,
    lease: IconThemePreferenceReadyLease,
    responseAck: IconThemePreferenceReadyResponseAck | undefined,
  ): Promise<IconThemePreferenceDocumentSynchronization | undefined> {
    return await this.serializeEntry(entry, async () => await this.serialize(() => {
      this.assertActive(key, entry)
      const latestRequiredRevision = this.winner?.revision ?? entry.ackedRevision
      if (entry.readyLease !== lease
        || lease.cancellation.signal.aborted
        || lease.documentKey !== entry.documentKey
        || lease.entryGeneration !== entry.entryGeneration
        || lease.requiredRevision < latestRequiredRevision
        || responseAck === undefined
        || responseAck.readyLeaseToken !== lease.token
        || responseAck.readyLeaseRevision !== lease.revision) {
        return undefined
      }
      this.assertActiveAck(key, entry, responseAck, lease.status.currentRevision)
      entry.ackedRevision = Math.max(entry.ackedRevision, responseAck.currentRevision)
      this.refreshPending(entry)
      const finalRequiredRevision = this.winner?.revision ?? entry.ackedRevision
      if (lease.requiredRevision < finalRequiredRevision) return undefined
      entry.readyLease = undefined
      const converged = entry.pending === undefined && entry.ackedRevision >= finalRequiredRevision
      const finalStatus: IconThemePreferenceDocumentSynchronization = {
        synchronization: lease.status.synchronization === 'complete' && converged ? 'complete' : 'pending',
        requiredRevision: finalRequiredRevision,
        currentRevision: entry.ackedRevision,
      }
      if (finalStatus.synchronization === 'complete') entry.booting = false
      return finalStatus
    }))
  }

  private deactivate(key: string, entry: IconThemePreferenceDocumentState): void {
    if (!entry.active) return
    entry.active = false
    entry.pending = undefined
    entry.removeExternalAbort?.()
    entry.removeExternalAbort = undefined
    entry.readyLease?.cancellation.abort()
    entry.readyLease = undefined
    entry.cancellation.abort()
    if (this.receivers.get(key) === entry) this.receivers.delete(key)
  }

  private assertExternalCallUnlocked(label: string): void {
    if (this.operationDepth !== 0) throw new Error(`icon theme preference ${label} cannot run under the profile operation lock`)
  }

  private async enqueue(
    entry: IconThemePreferenceDocumentState,
  ): Promise<'delivered' | 'failed' | 'inactive'> {
    return await this.serializeEntry(entry, async () => {
      let failed = false
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!entry.active) return 'inactive' as const
        const value = entry.pending
        if (value === undefined || entry.ackedRevision >= value.revision) {
          entry.pending = undefined
          return 'delivered' as const
        }
        try {
          let rejectCancelled!: (error: Error) => void
          const cancelled = new Promise<never>((_resolve, reject) => {
            rejectCancelled = reject
          })
          const onAbort = (): void => rejectCancelled(new Error('icon theme preference document receiver is disposed'))
          entry.cancellation.signal.addEventListener('abort', onAbort, { once: true })
          if (entry.cancellation.signal.aborted) onAbort()
          let ack: IconThemePreferenceDeliveryAck
          try {
            const receiver = entry.receiver
            if (receiver === undefined) return 'failed' as const
            this.assertExternalCallUnlocked('document receiver')
            ack = await Promise.race([receiver.receive({ ...value }), cancelled])
          } finally {
            entry.cancellation.signal.removeEventListener('abort', onAbort)
          }
          if (!entry.active) return 'inactive' as const
          if (ack.documentEpoch !== entry.identity.documentEpoch || ack.currentRevision < value.revision) {
            throw new Error('icon theme preference delivery acknowledgement is invalid')
          }
          entry.ackedRevision = Math.max(entry.ackedRevision, ack.currentRevision)
          const readyLease = entry.readyLease
          if (readyLease !== undefined && entry.ackedRevision > readyLease.status.currentRevision) {
            entry.readyLease = undefined
            readyLease.cancellation.abort()
          }
          if (entry.pending !== undefined && entry.ackedRevision >= entry.pending.revision) entry.pending = undefined
          return entry.pending === undefined ? 'delivered' as const : 'failed' as const
        } catch {
          if (!entry.active) return 'inactive' as const
          failed = true
        }
      }
      return failed ? 'failed' as const : 'delivered' as const
    })
  }

  private async serializeEntry<Value>(entry: IconThemePreferenceDocumentState, operation: () => Promise<Value>): Promise<Value> {
    const delivery = entry.tail.then(operation)
    // Keep serialization usable after failure. The pending state and returned
    // result make failure observable without losing the durable winner.
    entry.tail = delivery.then(() => undefined, () => undefined)
    return await delivery
  }
}
