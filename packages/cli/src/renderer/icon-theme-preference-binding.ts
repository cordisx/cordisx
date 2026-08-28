import type { HomeConfigIconThemePreference } from '../config/home-config.js'
import type { RedactedIconThemeProvider } from './icon-theme-registry.js'

const BINDING = '__cordisxIconThemePreferenceRequestV1'
const RECEIVER = '__cordisxIconThemePreferenceReceiveV1'
const REQUEST_TIMEOUT_MS = 5_000

type IconThemePreferenceBinding = (payload: string) => void

interface Pending {
  readonly expectedRevision: number
  readonly candidate: Pick<RedactedIconThemeProvider, 'providerId' | 'namespace' | 'providerVersion' | 'providerGeneration'>
  readonly resolve: (preference: HomeConfigIconThemePreference) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

declare global {
  // eslint-disable-next-line no-var
  var __cordisxIconThemePreferenceRequestV1: IconThemePreferenceBinding | undefined
  // eslint-disable-next-line no-var
  var __cordisxIconThemePreferenceReceiveV1: ((payload: string) => void) | undefined
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
  private readonly listeners = new Set<(preference: HomeConfigIconThemePreference) => void>()
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
    this.listeners.clear()
  }

  private readonly receive = (payload: string): void => {
    if (this.closed) return
    let response: { kind?: unknown; requestId?: unknown; ok?: unknown; value?: unknown; code?: unknown; currentPreference?: unknown }
    try { response = JSON.parse(payload) as typeof response } catch { return }
    if (response.kind === 'sync') {
      if (validPreference(response.value)) this.acceptPreference(response.value)
      return
    }
    if (typeof response.requestId !== 'string') return
    const pending = this.pending.get(response.requestId)
    if (pending === undefined) return
    this.pending.delete(response.requestId)
    clearTimeout(pending.timer)
    if (response.ok !== true || !validPreference(response.value)) {
      if (validPreference(response.currentPreference)) this.acceptPreference(response.currentPreference)
      pending.reject(new Error(typeof response.code === 'string' ? response.code : 'icon-theme-persistence-rejected'))
      return
    }
    const preference = response.value
    if (preference.revision !== pending.expectedRevision + 1
      || preference.providerId !== pending.candidate.providerId
      || preference.namespace !== pending.candidate.namespace
      || preference.providerVersion !== pending.candidate.providerVersion
      || preference.providerGeneration !== pending.candidate.providerGeneration) {
      pending.reject(new Error('Icon theme preference persistence response was mismatched'))
      return
    }
    this.acceptPreference(preference)
    pending.resolve({ ...preference })
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
