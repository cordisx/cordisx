import {
  CORDISX_PLATFORM_CAPABILITIES,
  type CordisXPermissionPolicyRecordV1,
} from '../platform-contracts.js'
import { normalizePermissionPolicyRecord, permissionRecordKey } from '../permissions.js'
import type { LegacyStoredPolicy, PermissionPolicyStore } from './platform.js'

const PERMISSION_BINDING = '__cordisxPermissionPolicyRequestV1'
const PERMISSION_RECEIVER = '__cordisxPermissionPolicyReceiveV1'
const LEGACY_POLICY_STORAGE_KEY = 'cordisx.platform.permissionPolicies.v1'
const REQUEST_TIMEOUT_MS = 5_000

type PermissionBinding = (payload: string) => void

interface Pending {
  readonly resolve: (records: readonly CordisXPermissionPolicyRecordV1[]) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

interface PermissionResponse {
  readonly requestId?: unknown
  readonly ok?: unknown
  readonly value?: unknown
}

declare global {
  // eslint-disable-next-line no-var
  var __cordisxPermissionPolicyRequestV1: PermissionBinding | undefined
  // eslint-disable-next-line no-var
  var __cordisxPermissionPolicyReceiveV1: ((payload: string) => void) | undefined
}

function clone<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value
}

/** Launcher-backed, profile-projected persistent policy store. */
export class BindingPermissionPolicyStore implements PermissionPolicyStore {
  private readonly pending = new Map<string, Pending>()
  private readonly records = new Map<string, CordisXPermissionPolicyRecordV1>()
  private closed = false

  private constructor(
    private readonly token: string,
    private readonly binding: PermissionBinding,
    initial: readonly CordisXPermissionPolicyRecordV1[],
  ) {
    for (const record of initial) {
      const normalized = normalizePermissionPolicyRecord(record)
      this.records.set(permissionRecordKey(normalized), normalized)
    }
    globalThis[PERMISSION_RECEIVER] = this.receive
  }

  static connect(
    token: string,
    initial: readonly CordisXPermissionPolicyRecordV1[],
  ): BindingPermissionPolicyStore {
    const binding = globalThis[PERMISSION_BINDING]
    if (typeof binding !== 'function') throw new Error('Permission policy persistence bridge is unavailable')
    return new BindingPermissionPolicyStore(token, binding, initial)
  }

  read(): readonly CordisXPermissionPolicyRecordV1[] {
    return clone([...this.records.values()])
  }

  async write(records: readonly CordisXPermissionPolicyRecordV1[]): Promise<void> {
    const normalized = records.map(item => normalizePermissionPolicyRecord(item))
    const persisted = await this.request(normalized)
    if (persisted.length !== normalized.length || persisted.some((record, index) => (
      permissionRecordKey(record) !== permissionRecordKey(normalized[index]!)
      || record.policy !== normalized[index]!.policy
    ))) {
      throw new Error('Permission policy persistence returned mismatched records')
    }
    for (const record of persisted) this.records.set(permissionRecordKey(record), record)
  }

  legacy(): readonly LegacyStoredPolicy[] {
    try {
      const value = localStorage.getItem(LEGACY_POLICY_STORAGE_KEY)
      if (value === null) return []
      const records = JSON.parse(value) as unknown
      if (!Array.isArray(records)) return []
      return records.filter((item): item is LegacyStoredPolicy => {
        if (item === null || typeof item !== 'object') return false
        const record = item as Partial<LegacyStoredPolicy>
        return typeof record.identityKey === 'string'
          && typeof record.capability === 'string'
          && (CORDISX_PLATFORM_CAPABILITIES as readonly string[]).includes(record.capability)
          && typeof record.fingerprint === 'string'
          && (record.policy === 'ask' || record.policy === 'deny' || record.policy === 'allow')
      })
    } catch {
      return []
    }
  }

  retireLegacy(record: LegacyStoredPolicy): void {
    try {
      const retained = this.legacy().filter(item => JSON.stringify(item) !== JSON.stringify(record))
      if (retained.length === 0) localStorage.removeItem(LEGACY_POLICY_STORAGE_KEY)
      else localStorage.setItem(LEGACY_POLICY_STORAGE_KEY, JSON.stringify(retained))
    } catch {
      // The new durable record is already acknowledged; stale legacy data is ignored.
    }
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    if (globalThis[PERMISSION_RECEIVER] === this.receive) globalThis[PERMISSION_RECEIVER] = undefined
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Permission policy persistence bridge was disposed'))
    }
    this.pending.clear()
  }

  private request(records: readonly CordisXPermissionPolicyRecordV1[]): Promise<readonly CordisXPermissionPolicyRecordV1[]> {
    if (this.closed) return Promise.reject(new Error('Permission policy persistence bridge is closed'))
    const requestId = typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('Permission policy persistence request timed out'))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(requestId, { resolve, reject, timer })
      try {
        this.binding(JSON.stringify({ requestId, token: this.token, records }))
      } catch (error) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  private readonly receive = (payload: string): void => {
    let response: PermissionResponse
    try { response = JSON.parse(payload) as PermissionResponse } catch { return }
    if (typeof response.requestId !== 'string') return
    const pending = this.pending.get(response.requestId)
    if (pending === undefined) return
    this.pending.delete(response.requestId)
    clearTimeout(pending.timer)
    if (response.ok !== true) {
      pending.reject(new Error('Permission policy persistence request was rejected'))
      return
    }
    try {
      if (!Array.isArray(response.value)) throw new Error('response value must be an array')
      pending.resolve(response.value.map(item => normalizePermissionPolicyRecord(item)))
    } catch {
      pending.reject(new Error('Permission policy persistence response was invalid'))
    }
  }
}
