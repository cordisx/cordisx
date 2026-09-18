import type {
  PluginManagementConfigRequest,
  PluginManagementLegacySourceMigration,
  PluginManagementMigrationResult,
  PluginManagementResult,
  PluginManagementSnapshot,
} from '../management/contracts.js'

const BINDING = '__cordisxPluginManagementRequestV1'
const RECEIVER = '__cordisxPluginManagementReceiveV1'

declare global {
  interface Window {
    __cordisxPluginManagementRequestV1?: (payload: string) => void
    __cordisxPluginManagementReceiveV1?: (payload: string) => void
  }
}

export interface PluginManagementBinding {
  query(): Promise<PluginManagementSnapshot>
  subscribe(listener: (snapshot: PluginManagementSnapshot) => void): () => void
  mutate(request: PluginManagementConfigRequest, expectedRevision: number): Promise<PluginManagementResult>
  migrateLegacySources(input: PluginManagementLegacySourceMigration): Promise<PluginManagementMigrationResult>
}

export class BrowserPluginManagementBinding implements PluginManagementBinding {
  private readonly pending = new Map<string, {
    readonly resolve: (value: unknown) => void
    readonly reject: (error: Error) => void
    readonly timer: ReturnType<typeof setTimeout>
  }>()
  private readonly listeners = new Set<(snapshot: PluginManagementSnapshot) => void>()
  private disposed = false

  constructor(private readonly token: string, private readonly profileId: string) {
    window[RECEIVER] = payload => this.receive(payload)
  }

  query(): Promise<PluginManagementSnapshot> {
    return this.send({ kind: 'query' })
  }

  subscribe(listener: (snapshot: PluginManagementSnapshot) => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  mutate(request: PluginManagementConfigRequest, expectedRevision: number): Promise<PluginManagementResult> {
    return this.send({ kind: 'execute', request, expectedRevision })
  }

  migrateLegacySources(input: PluginManagementLegacySourceMigration): Promise<PluginManagementMigrationResult> {
    return this.send({ kind: 'migrate-legacy-sources', input })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (window[RECEIVER] !== undefined) delete window[RECEIVER]
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('plugin management bridge is disposed'))
    }
    this.pending.clear()
    this.listeners.clear()
  }

  private send<Value>(operation: object): Promise<Value> {
    if (this.disposed) return Promise.reject(new Error('plugin management bridge is disposed'))
    const binding = window[BINDING]
    if (typeof binding !== 'function') return Promise.reject(new Error('plugin management is unavailable'))
    const requestId = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `management-${Date.now()}-${Math.random().toString(36).slice(2)}`
    return new Promise<Value>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('plugin management request timed out'))
      }, 60_000)
      this.pending.set(requestId, { resolve: value => resolve(value as Value), reject, timer })
      try {
        binding(JSON.stringify({ version: 1, requestId, token: this.token, profileId: this.profileId, operation }))
      } catch (error) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private receive(payload: string): void {
    let response: Record<string, unknown>
    try {
      response = JSON.parse(payload) as Record<string, unknown>
    } catch {
      return
    }
    if (response.kind === 'snapshot' && response.profileId === this.profileId) {
      const snapshot = response.snapshot as PluginManagementSnapshot
      for (const listener of this.listeners) listener(snapshot)
      return
    }
    if (typeof response.requestId !== 'string') return
    const pending = this.pending.get(response.requestId)
    if (pending === undefined) return
    this.pending.delete(response.requestId)
    clearTimeout(pending.timer)
    if (response.ok === true) pending.resolve(response.value)
    else {pending.reject(
        new Error(typeof response.error === 'string' ? response.error : 'plugin management request failed'),
      )}
  }
}
