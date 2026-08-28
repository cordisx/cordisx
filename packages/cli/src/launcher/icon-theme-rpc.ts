import { timingSafeEqual } from 'node:crypto'
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

export interface IconThemePreferenceDocumentRegistration {
  readonly currentRevision: number
  readonly synchronization: 'complete' | 'pending'
  respondReady(
    probeAck: IconThemePreferenceDeliveryAck,
    respond: (status: IconThemePreferenceDocumentSynchronization) => Promise<IconThemePreferenceDeliveryAck>,
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
  receiver: IconThemePreferenceDocumentReceiver | undefined
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
      async status => ({ documentEpoch: identity.documentEpoch, currentRevision: status.currentRevision }),
    )
    return registration
  }

  async broadcast(preference: HomeConfigIconThemePreference): Promise<IconThemePreferenceBroadcastResult> {
    const entries = await this.serialize(async () => {
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

  private async serialize<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = this.operationTail.then(operation)
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
        await this.serializeEntry(entry, async () => await this.serialize(async () => {
          this.assertActiveAck(key, entry, probeAck, 0)
          entry.ackedRevision = Math.max(entry.ackedRevision, probeAck.currentRevision)
          this.refreshPending(entry)
        }))
        if (entry.pending !== undefined) await this.enqueue(entry)
        return await this.serializeEntry(entry, async () => await this.serialize(async () => {
          this.assertActive(key, entry)
          this.refreshPending(entry)
          const requiredRevision = this.winner?.revision ?? entry.ackedRevision
          const status: IconThemePreferenceDocumentSynchronization = {
            synchronization: entry.pending === undefined && entry.ackedRevision >= requiredRevision ? 'complete' : 'pending',
            requiredRevision,
            currentRevision: entry.ackedRevision,
          }
          const responseAck = await respond(status)
          this.assertActiveAck(key, entry, responseAck)
          entry.ackedRevision = Math.max(entry.ackedRevision, responseAck.currentRevision)
          this.refreshPending(entry)
          const finalRequiredRevision = this.winner?.revision ?? entry.ackedRevision
          const converged = entry.pending === undefined && entry.ackedRevision >= finalRequiredRevision
          const finalStatus: IconThemePreferenceDocumentSynchronization = {
            synchronization: status.synchronization === 'complete' && converged ? 'complete' : 'pending',
            requiredRevision: finalRequiredRevision,
            currentRevision: entry.ackedRevision,
          }
          if (finalStatus.synchronization === 'complete') entry.booting = false
          return finalStatus
        }))
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

  private deactivate(key: string, entry: IconThemePreferenceDocumentState): void {
    if (!entry.active) return
    entry.active = false
    entry.pending = undefined
    entry.removeExternalAbort?.()
    entry.removeExternalAbort = undefined
    entry.cancellation.abort()
    if (this.receivers.get(key) === entry) this.receivers.delete(key)
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
            ack = await Promise.race([receiver.receive({ ...value }), cancelled])
          } finally {
            entry.cancellation.signal.removeEventListener('abort', onAbort)
          }
          if (!entry.active) return 'inactive' as const
          if (ack.documentEpoch !== entry.identity.documentEpoch || ack.currentRevision < value.revision) {
            throw new Error('icon theme preference delivery acknowledgement is invalid')
          }
          entry.ackedRevision = Math.max(entry.ackedRevision, ack.currentRevision)
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
