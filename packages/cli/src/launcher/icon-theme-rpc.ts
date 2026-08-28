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
  readonly targetId: string
  readonly sessionId: string
  readonly documentEpoch: string
  readonly currentRevision: number
  readonly receive: (preference: HomeConfigIconThemePreference) => Promise<IconThemePreferenceDeliveryAck>
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
  tail: Promise<void>
  ackedRevision: number
  pending: HomeConfigIconThemePreference | undefined
  readonly receiver: IconThemePreferenceDocumentReceiver
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

  constructor(
    readonly appId: string,
    readonly profileId: string,
  ) {}

  assertScope(context: Pick<IconThemePreferencePersistenceContext, 'appId' | 'profileId'>): void {
    if (context.appId !== this.appId || context.profileId !== this.profileId) {
      throw new Error('icon theme preference broadcast scope is mismatched')
    }
  }

  async register(receiver: IconThemePreferenceDocumentReceiver): Promise<{
    readonly currentRevision: number
    readonly synchronization: 'complete' | 'pending'
    readonly unregister: () => void
  }> {
    const key = `${receiver.targetId}\u0000${receiver.sessionId}`
    const previous = this.receivers.get(key)
    if (previous !== undefined) {
      previous.active = false
      previous.pending = undefined
    }
    const entry: IconThemePreferenceDocumentState = {
      active: true,
      tail: Promise.resolve(),
      ackedRevision: receiver.currentRevision,
      pending: undefined,
      receiver,
    }
    this.receivers.set(key, entry)
    if (this.winner !== undefined && entry.ackedRevision < this.winner.revision) {
      entry.pending = { ...this.winner }
      await this.enqueue(entry)
    }
    const unregister = (): void => {
      entry.active = false
      entry.pending = undefined
      if (this.receivers.get(key) === entry) this.receivers.delete(key)
    }
    return {
      currentRevision: entry.ackedRevision,
      synchronization: entry.pending === undefined ? 'complete' : 'pending',
      unregister,
    }
  }

  async broadcast(preference: HomeConfigIconThemePreference): Promise<IconThemePreferenceBroadcastResult> {
    if (this.winner !== undefined) {
      if (preference.revision < this.winner.revision) {
        return { attempted: 0, delivered: 0, failed: 0, pending: this.pendingCount() }
      }
      if (preference.revision === this.winner.revision
        && !samePreference(preference, this.winner)) {
        throw new Error('icon theme preference winner revision is divergent')
      }
    }
    // Durable cache advancement is intentionally independent from delivery.
    // A failed/destroyed document never rolls the winner back.
    this.winner = { ...preference }
    const entries = [...this.receivers.values()].filter(entry => entry.active && entry.ackedRevision < preference.revision)
    for (const entry of entries) entry.pending = { ...preference }
    const results = await Promise.all(entries.map(async entry => await this.enqueue(entry)))
    const delivered = results.filter(result => result === 'delivered').length
    return {
      attempted: entries.length,
      delivered,
      failed: results.filter(result => result !== 'delivered').length,
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

  private pendingCount(): number {
    return [...this.receivers.values()].filter(entry => entry.active && entry.pending !== undefined).length
  }

  private async enqueue(
    entry: IconThemePreferenceDocumentState,
  ): Promise<'delivered' | 'failed' | 'inactive'> {
    const delivery = entry.tail.then(async () => {
      let failed = false
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!entry.active) return 'inactive' as const
        const value = entry.pending
        if (value === undefined || entry.ackedRevision >= value.revision) {
          entry.pending = undefined
          return 'delivered' as const
        }
        try {
          const ack = await entry.receiver.receive({ ...value })
          if (!entry.active) return 'inactive' as const
          if (ack.documentEpoch !== entry.receiver.documentEpoch || ack.currentRevision < value.revision) {
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
    // Keep serialization usable after failure. The pending state and returned
    // result make failure observable without losing the durable winner.
    entry.tail = delivery.then(() => undefined, () => undefined)
    return await delivery
  }
}
