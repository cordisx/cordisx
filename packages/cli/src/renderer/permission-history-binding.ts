import type { PermissionDecisionHistoryItem } from '../permission-decision-history.js'
import { normalizePersistedPermissionPolicyRecord } from '../permission-persistence.js'

const REQUEST = '__cordisxPermissionHistoryRequestV1'
const RECEIVE = '__cordisxPermissionHistoryReceiveV1'

declare global {
  var __cordisxPermissionHistoryRequestV1: ((payload: string) => void) | undefined
  var __cordisxPermissionHistoryReceiveV1: ((payload: string) => void) | undefined
}

/** Validate the service projection before presenting it in either client. */
export function parsePermissionHistory(value: unknown, pluginId: string): readonly PermissionDecisionHistoryItem[] {
  if (!Array.isArray(value) || value.length > 2300) throw new Error('permission history is unavailable')
  return value.map((raw): PermissionDecisionHistoryItem => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('permission history is invalid')
    const item = raw as Record<string, unknown>
    if (
      Object.keys(item).some(key => !['record', 'decision', 'client', 'requestedAt', 'committedAt'].includes(key))
      || item.client !== 'web' && item.client !== 'codex' || typeof item.requestedAt !== 'string'
      || !Number.isFinite(Date.parse(item.requestedAt))
      || item.committedAt !== undefined && (typeof item.committedAt !== 'string'
          || !Number.isFinite(Date.parse(item.committedAt)))
      || typeof item.decision !== 'string'
      || !['ask', 'allow', 'deny', 'allow-persistent', 'deny-persistent', 'allow-once', 'deny-once'].includes(
        item.decision,
      )
    ) throw new Error('permission history is invalid')
    const record = normalizePersistedPermissionPolicyRecord(item.record)
    if (record.key.identity.pluginId !== pluginId) throw new Error('permission history is invalid')
    return {
      record,
      decision: item.decision as PermissionDecisionHistoryItem['decision'],
      client: item.client,
      requestedAt: item.requestedAt,
      ...(typeof item.committedAt === 'string' ? { committedAt: item.committedAt } : {}),
    }
  })
}

/** A read-only view of decisions held by the currently admitted service owner. */
export class BrowserPermissionHistoryBinding {
  private readonly pending = new Map<string, {
    readonly resolve: (value: readonly PermissionDecisionHistoryItem[]) => void
    readonly reject: (error: Error) => void
    readonly timer: ReturnType<typeof setTimeout>
    readonly pluginId: string
  }>()
  private closed = false

  private constructor(private readonly requestBinding: (payload: string) => void) {
    globalThis[RECEIVE] = this.receive
  }

  static connect(): BrowserPermissionHistoryBinding | undefined {
    const binding = globalThis[REQUEST]
    if (typeof binding !== 'function') return undefined
    if (globalThis[RECEIVE] !== undefined) throw new Error('permission history is already connected')
    return new BrowserPermissionHistoryBinding(binding)
  }

  read(pluginId: string): Promise<readonly PermissionDecisionHistoryItem[]> {
    if (this.closed || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(pluginId)) {
      return Promise.reject(new Error('permission history is unavailable'))
    }
    const requestId = globalThis.crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('permission history timed out'))
      }, 15_000)
      this.pending.set(requestId, { resolve, reject, timer, pluginId })
      try {
        this.requestBinding(JSON.stringify({ requestId, pluginId }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(error instanceof Error ? error : new Error('permission history is unavailable'))
      }
    })
  }

  private readonly receive = (payload: string) => {
    let response: Record<string, unknown>
    try {
      response = JSON.parse(payload) as Record<string, unknown>
    } catch {
      return
    }
    if (!response || typeof response.requestId !== 'string') return
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    this.pending.delete(response.requestId)
    clearTimeout(pending.timer)
    try {
      if (response.ok !== true) throw new Error('permission history is unavailable')
      pending.resolve(parsePermissionHistory(response.value, pending.pluginId))
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error('permission history is unavailable'))
    }
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    if (globalThis[RECEIVE] === this.receive) globalThis[RECEIVE] = undefined
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      item.reject(new Error('permission history is unavailable'))
    }
    this.pending.clear()
  }
}
