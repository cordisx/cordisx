import type { HomeConfigIconThemePreference } from '../config/home-config.js'
import type { RedactedIconThemeProvider } from './icon-theme-registry.js'

const BINDING = '__cordisxIconThemePreferenceRequestV1'
const RECEIVER = '__cordisxIconThemePreferenceReceiveV1'
const REQUEST_TIMEOUT_MS = 5_000
const READY_RETRY_DELAYS_MS = [25, 50] as const

type IconThemePreferenceBinding = (payload: string) => void

interface IconThemePreferenceDeliveryAck {
  readonly documentEpoch: string
  readonly currentRevision: number
}

interface Pending {
  readonly expectedRevision: number
  readonly candidate: Pick<RedactedIconThemeProvider, 'providerId' | 'namespace' | 'providerVersion' | 'providerGeneration'>
  readonly resolve: (preference: HomeConfigIconThemePreference) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

interface ReadyPending {
  readonly expectedRevision: number
  readonly resolve: (status: IconThemePreferenceReadyStatus) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

interface IconThemePreferenceReadyStatus {
  readonly synchronization: 'complete' | 'pending'
  readonly requiredRevision: number
  readonly currentRevision: number
}

interface ReadyRetryWaiter {
  readonly timer: ReturnType<typeof setTimeout>
  readonly reject: (error: Error) => void
}

declare global {
  // eslint-disable-next-line no-var
  var __cordisxIconThemePreferenceRequestV1: IconThemePreferenceBinding | undefined
  // eslint-disable-next-line no-var
  var __cordisxIconThemePreferenceReceiveV1: ((payload: string) => IconThemePreferenceDeliveryAck) | undefined
}

function validPreference(value: unknown): value is HomeConfigIconThemePreference {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return Object.keys(item).sort().join(',') === 'namespace,providerGeneration,providerId,providerVersion,revision'
    && Number.isSafeInteger(item.revision) && (item.revision as number) >= 1
    && typeof item.providerId === 'string' && typeof item.namespace === 'string'
    && typeof item.providerVersion === 'string' && typeof item.providerGeneration === 'string'
}

/** Host-private persistence client; only exact redacted identity crosses CDP. */
export class BrowserIconThemePreferenceBridge {
  private readonly pending = new Map<string, Pending>()
  private readonly readyPending = new Map<string, ReadyPending>()
  private readonly readyRetryWaiters = new Set<ReadyRetryWaiter>()
  private readonly listeners = new Set<(preference: HomeConfigIconThemePreference) => void>()
  private readonly documentEpoch = typeof globalThis.crypto?.randomUUID === 'function'
    ? `doc_${globalThis.crypto.randomUUID().replaceAll('-', '_')}`
    : `doc_${Date.now()}_${Math.random().toString(36).slice(2)}`
  private closed = false
  private preferenceRevision: number
  private preference: HomeConfigIconThemePreference | undefined

  constructor(
    private readonly token: string,
    private readonly appId: string,
    private readonly profileId: string,
    private readonly hostGeneration: string,
    initial: HomeConfigIconThemePreference | undefined,
  ) {
    this.preferenceRevision = initial?.revision ?? 0
    this.preference = initial === undefined ? undefined : { ...initial }
    globalThis[RECEIVER] = this.receive
  }

  revision(): number { return this.preferenceRevision }

  current(): HomeConfigIconThemePreference | undefined {
    return this.preference === undefined ? undefined : { ...this.preference }
  }

  subscribe(listener: (preference: HomeConfigIconThemePreference) => void): () => void {
    if (this.closed) throw new Error('Icon theme preference persistence bridge is closed')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async ready(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Icon theme preference persistence bridge is closed'))
    let requiredRevision = this.preferenceRevision
    for (let round = 0; round <= READY_RETRY_DELAYS_MS.length; round += 1) {
      const status = await this.requestReady(requiredRevision)
      requiredRevision = Math.max(requiredRevision, status.requiredRevision)
      if (status.synchronization === 'complete') return
      if (round === READY_RETRY_DELAYS_MS.length) {
        throw new Error(`Icon theme preference document remains pending at revision ${status.currentRevision}; required ${requiredRevision}`)
      }
      await this.waitForReadyRetry(READY_RETRY_DELAYS_MS[round]!)
    }
  }

  private requestReady(requiredRevision: number): Promise<IconThemePreferenceReadyStatus> {
    if (this.closed) return Promise.reject(new Error('Icon theme preference persistence bridge is closed'))
    const binding = globalThis[BINDING]
    if (typeof binding !== 'function') return Promise.reject(new Error('Icon theme preference persistence bridge is unavailable'))
    const requestId = typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const expectedRevision = Math.max(this.preferenceRevision, requiredRevision)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyPending.delete(requestId)
        reject(new Error('Icon theme preference document ready request timed out'))
      }, REQUEST_TIMEOUT_MS)
      this.readyPending.set(requestId, { expectedRevision, resolve, reject, timer })
      try {
        binding(JSON.stringify({
          version: 1,
          kind: 'document-ready',
          token: this.token,
          requestId,
          scope: { appId: this.appId, profileId: this.profileId, hostGeneration: this.hostGeneration },
          documentEpoch: this.documentEpoch,
          currentRevision: this.preferenceRevision,
        }))
      } catch (error) {
        this.readyPending.delete(requestId)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  private waitForReadyRetry(delayMs: number): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Icon theme preference persistence bridge is closed'))
    return new Promise((resolve, reject) => {
      const waiter: ReadyRetryWaiter = {
        timer: setTimeout(() => {
          this.readyRetryWaiters.delete(waiter)
          resolve()
        }, delayMs),
        reject,
      }
      this.readyRetryWaiters.add(waiter)
    })
  }

  persist(
    expectedProfileRevision: number,
    selectedProfileRevision: number,
    candidate: Pick<RedactedIconThemeProvider, 'providerId' | 'namespace' | 'providerVersion' | 'providerGeneration'>,
  ): Promise<HomeConfigIconThemePreference> {
    if (this.closed) return Promise.reject(new Error('Icon theme preference persistence bridge is closed'))
    const binding = globalThis[BINDING]
    if (typeof binding !== 'function') return Promise.reject(new Error('Icon theme preference persistence bridge is unavailable'))
    const requestId = typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const expectedRevision = this.preferenceRevision
    const persistenceCandidate = {
      providerId: candidate.providerId,
      namespace: candidate.namespace,
      providerVersion: candidate.providerVersion,
      providerGeneration: candidate.providerGeneration,
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('Icon theme preference persistence request timed out'))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(requestId, { expectedRevision, candidate: persistenceCandidate, resolve, reject, timer })
      try {
        binding(JSON.stringify({
          version: 1,
          token: this.token,
          requestId,
          scope: { appId: this.appId, profileId: this.profileId, hostGeneration: this.hostGeneration },
          expectedPreferenceRevision: expectedRevision,
          expectedProfileRevision,
          selectedProfileRevision,
          candidate: persistenceCandidate,
        }))
      } catch (error) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    if (globalThis[RECEIVER] === this.receive) globalThis[RECEIVER] = undefined
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Icon theme preference persistence bridge was disposed'))
    }
    this.pending.clear()
    for (const pending of this.readyPending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Icon theme preference persistence bridge was disposed'))
    }
    this.readyPending.clear()
    for (const waiter of this.readyRetryWaiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('Icon theme preference persistence bridge was disposed'))
    }
    this.readyRetryWaiters.clear()
    this.listeners.clear()
  }

  private readonly receive = (payload: string): IconThemePreferenceDeliveryAck => {
    if (this.closed) throw new Error('Icon theme preference persistence bridge is closed')
    let response: {
      kind?: unknown
      requestId?: unknown
      ok?: unknown
      value?: unknown
      code?: unknown
      currentPreference?: unknown
      documentEpoch?: unknown
      currentRevision?: unknown
      requiredRevision?: unknown
      synchronization?: unknown
    }
    try { response = JSON.parse(payload) as typeof response } catch { throw new Error('icon theme preference response is invalid') }
    if (response.kind === 'sync') {
      if (validPreference(response.value)) this.acceptPreference(response.value)
      return this.deliveryAck()
    }
    if (response.kind === 'document-ready' && typeof response.requestId === 'string') {
      const pending = this.readyPending.get(response.requestId)
      if (pending === undefined) return this.deliveryAck()
      this.readyPending.delete(response.requestId)
      clearTimeout(pending.timer)
      const currentRevision = response.currentRevision
      const requiredRevision = response.requiredRevision
      const synchronization = response.synchronization
      if (response.ok !== true || response.documentEpoch !== this.documentEpoch
        || !Number.isSafeInteger(response.currentRevision)
        || !Number.isSafeInteger(requiredRevision)
        || (currentRevision as number) < 0
        || (requiredRevision as number) < pending.expectedRevision
        || (synchronization !== 'complete' && synchronization !== 'pending')
        || (synchronization === 'complete' && ((currentRevision as number) < (requiredRevision as number)
          || this.preferenceRevision < (requiredRevision as number)))
        || (synchronization === 'pending' && (currentRevision as number) >= (requiredRevision as number))) {
        pending.reject(new Error('icon theme preference document ready acknowledgement is invalid'))
      } else {
        pending.resolve({
          synchronization,
          requiredRevision: requiredRevision as number,
          currentRevision: currentRevision as number,
        })
      }
      return this.deliveryAck()
    }
    if (typeof response.requestId !== 'string') return this.deliveryAck()
    const pending = this.pending.get(response.requestId)
    if (pending === undefined) return this.deliveryAck()
    this.pending.delete(response.requestId)
    clearTimeout(pending.timer)
    if (response.ok !== true || !validPreference(response.value)) {
      if (validPreference(response.currentPreference)) this.acceptPreference(response.currentPreference)
      pending.reject(new Error(typeof response.code === 'string' ? response.code : 'icon-theme-persistence-rejected'))
      return this.deliveryAck()
    }
    const preference = response.value
    if (preference.revision !== pending.expectedRevision + 1
      || preference.providerId !== pending.candidate.providerId
      || preference.namespace !== pending.candidate.namespace
      || preference.providerVersion !== pending.candidate.providerVersion
      || preference.providerGeneration !== pending.candidate.providerGeneration) {
      pending.reject(new Error('Icon theme preference persistence response was mismatched'))
      return this.deliveryAck()
    }
    this.acceptPreference(preference)
    pending.resolve({ ...preference })
    return this.deliveryAck()
  }

  private deliveryAck(): IconThemePreferenceDeliveryAck {
    return { documentEpoch: this.documentEpoch, currentRevision: this.preferenceRevision }
  }

  private acceptPreference(preference: HomeConfigIconThemePreference): void {
    if (preference.revision < this.preferenceRevision) return
    if (preference.revision === this.preferenceRevision && this.preference !== undefined) {
      if (JSON.stringify(preference) !== JSON.stringify(this.preference)) return
      return
    }
    this.preferenceRevision = preference.revision
    this.preference = { ...preference }
    for (const listener of this.listeners) listener({ ...preference })
  }
}
