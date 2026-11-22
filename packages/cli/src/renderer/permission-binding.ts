import { CORDISX_PLATFORM_CAPABILITIES, type CordisXPermissionPolicyRecordV1 } from '../platform-contracts.js'
import type {
  CordisXPermissionPolicyRecordV2,
  CordisXPermissionPolicyRecordV3,
  CordisXPermissionPolicyRecordV4,
} from '../permission-contracts.js'
import {
  type CordisXPersistedPermissionPolicyRecord,
  isPermissionPolicyRecordV2,
  isPermissionPolicyRecordV3,
  isPermissionPolicyRecordV4,
  normalizePersistedPermissionPolicyRecord,
  persistedPermissionMigrationKey,
  persistedPermissionRecordKey,
} from '../permission-persistence.js'
import type { LegacyStoredPolicy, PermissionPolicyStore } from './platform.js'

const PERMISSION_BINDING = '__cordisxPermissionPolicyRequestV1'
const PERMISSION_RECEIVER = '__cordisxPermissionPolicyReceiveV1'
const LEGACY_POLICY_STORAGE_KEY = 'cordisx.platform.permissionPolicies.v1'
const REQUEST_TIMEOUT_MS = 5_000

type PermissionBinding = (payload: string) => void

interface Pending {
  readonly resolve: (records: readonly CordisXPersistedPermissionPolicyRecord[]) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly records: readonly CordisXPersistedPermissionPolicyRecord[]
  adopted: boolean
  sent: boolean
}

interface PermissionResponse {
  readonly requestId?: unknown
  readonly ok?: unknown
  readonly value?: unknown
}

declare global {
  var __cordisxPermissionPolicyRequestV1: PermissionBinding | undefined
  var __cordisxPermissionPolicyReceiveV1: ((payload: string) => void) | undefined
}

function clone<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value
}

/** Launcher-backed, profile-projected persistent policy store. */
export class BindingPermissionPolicyStore implements PermissionPolicyStore {
  private readonly pending = new Map<string, Pending>()
  private readonly records = new Map<string, CordisXPersistedPermissionPolicyRecord>()
  private closed = false
  private uncertain = false

  private constructor(
    private readonly token: string,
    private readonly binding: PermissionBinding,
    initial: readonly CordisXPersistedPermissionPolicyRecord[],
    private readonly standalone?: {
      readonly onUnknown?: () => void
      readonly sign?: (
        requestId: string,
        records: readonly CordisXPersistedPermissionPolicyRecord[],
      ) => Promise<unknown>
    },
  ) {
    for (const record of initial) {
      const normalized = normalizePersistedPermissionPolicyRecord(record)
      this.records.set(persistedPermissionRecordKey(normalized), normalized)
    }
    globalThis[PERMISSION_RECEIVER] = this.receive
  }

  static connect(
    token: string,
    initial: readonly CordisXPersistedPermissionPolicyRecord[],
    standalone?: {
      readonly onUnknown?: () => void
      readonly sign?: (
        requestId: string,
        records: readonly CordisXPersistedPermissionPolicyRecord[],
      ) => Promise<unknown>
    },
  ): BindingPermissionPolicyStore {
    const binding = globalThis[PERMISSION_BINDING]
    if (typeof binding !== 'function') throw new Error('Permission policy persistence bridge is unavailable')
    return new BindingPermissionPolicyStore(token, binding, initial, standalone)
  }

  read(): readonly CordisXPermissionPolicyRecordV1[] {
    return clone(
      [...this.records.values()].filter(record =>
        !isPermissionPolicyRecordV2(record) && !isPermissionPolicyRecordV3(record)
        && !isPermissionPolicyRecordV4(record)
      ),
    )
  }

  readV2(): readonly CordisXPermissionPolicyRecordV2[] {
    return clone([...this.records.values()].filter(isPermissionPolicyRecordV2))
  }

  readV3(): readonly CordisXPermissionPolicyRecordV3[] {
    return clone([...this.records.values()].filter(isPermissionPolicyRecordV3))
  }

  readV4(): readonly CordisXPermissionPolicyRecordV4[] {
    return clone([...this.records.values()].filter(isPermissionPolicyRecordV4))
  }

  async write(records: readonly CordisXPermissionPolicyRecordV1[]): Promise<void> {
    await this.writeRecords(records)
  }

  async writeV2(records: readonly CordisXPermissionPolicyRecordV2[]): Promise<void> {
    await this.writeRecords(records)
  }

  async writeV3(records: readonly CordisXPermissionPolicyRecordV3[]): Promise<void> {
    await this.writeRecords(records)
  }

  canAdoptStandaloneV3(requestId: string, records: readonly CordisXPermissionPolicyRecordV3[]): boolean {
    const pending = this.pending.get(requestId)
    if (
      !this.standalone || this.closed || !pending || !pending.sent || pending.adopted
      || !pending.records.every(isPermissionPolicyRecordV3)
    ) {
      return false
    }
    try {
      return JSON.stringify(pending.records)
        === JSON.stringify(records.map(record => normalizePersistedPermissionPolicyRecord(record)))
    } catch {
      return false
    }
  }

  markAdoptedStandaloneV3(requestId: string, records: readonly CordisXPermissionPolicyRecordV3[]): boolean {
    if (!this.canAdoptStandaloneV3(requestId, records)) return false
    this.pending.get(requestId)!.adopted = true
    return true
  }

  async writeV4(records: readonly CordisXPermissionPolicyRecordV4[]): Promise<void> {
    await this.writeRecords(records)
  }

  async writeAll(records: readonly CordisXPersistedPermissionPolicyRecord[]): Promise<void> {
    await this.writeRecords(records)
  }

  private async writeRecords(records: readonly CordisXPersistedPermissionPolicyRecord[]): Promise<void> {
    const normalized = records.map(item => normalizePersistedPermissionPolicyRecord(item))
    const persisted = await this.request(normalized)
    if (
      persisted.length !== normalized.length || persisted.some((record, index) => (
        persistedPermissionRecordKey(record) !== persistedPermissionRecordKey(normalized[index]!)
        || record.policy !== normalized[index]!.policy
      ))
    ) {
      if (this.standalone) this.markUnknown()
      throw new Error('Permission policy persistence returned mismatched records')
    }
    const migrations = new Set(persisted.filter(isPermissionPolicyRecordV2).map(persistedPermissionMigrationKey))
    for (const [key, record] of this.records) {
      if (!isPermissionPolicyRecordV2(record) && migrations.has(persistedPermissionMigrationKey(record))) {
        this.records.delete(key)
      }
    }
    for (const record of persisted) this.records.set(persistedPermissionRecordKey(record), record)
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
      if (this.standalone && pending.sent) this.markUnknown()
    }
    this.pending.clear()
  }

  private request(
    records: readonly CordisXPersistedPermissionPolicyRecord[],
  ): Promise<readonly CordisXPersistedPermissionPolicyRecord[]> {
    if (this.closed) return Promise.reject(new Error('Permission policy persistence bridge is closed'))
    const requestId = typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId)
        this.pending.delete(requestId)
        reject(new Error('Permission policy persistence request timed out'))
        if (this.standalone && pending?.sent) this.markUnknown()
      }, this.standalone ? 75_000 : REQUEST_TIMEOUT_MS)
      const pending: Pending = { resolve, reject, timer, records, adopted: false, sent: false }
      this.pending.set(requestId, pending)
      void (async () => {
        const proof = this.standalone?.sign === undefined ? undefined : await this.standalone.sign(requestId, records)
        if (this.standalone?.sign !== undefined && proof === undefined) {
          throw new Error('Permission policy decision is unavailable')
        }
        if (this.closed || this.pending.get(requestId) !== pending) return
        pending.sent = true
        this.binding(JSON.stringify({
          requestId,
          token: this.token,
          records,
          ...(proof === undefined ? {} : { proof }),
        }))
      })().catch(error => {
        if (this.pending.get(requestId) !== pending) return
        this.pending.delete(requestId)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error('Permission policy persistence is unavailable'))
        if (this.standalone && pending.sent) this.markUnknown()
      })
    })
  }

  private readonly receive = (payload: string): void => {
    let response: PermissionResponse
    try {
      response = JSON.parse(payload) as PermissionResponse
    } catch {
      return
    }
    if (typeof response.requestId !== 'string') return
    const pending = this.pending.get(response.requestId)
    if (pending === undefined) return
    this.pending.delete(response.requestId)
    clearTimeout(pending.timer)
    if (response.ok !== true) {
      pending.reject(new Error('Permission policy persistence request was rejected'))
      if (this.standalone && pending.sent) this.markUnknown()
      return
    }
    if (this.standalone && !pending.adopted) {
      pending.reject(new Error('Permission policy adoption was not confirmed'))
      this.markUnknown()
      return
    }
    try {
      if (!Array.isArray(response.value)) throw new Error('response value must be an array')
      pending.resolve(response.value.map(item => normalizePersistedPermissionPolicyRecord(item)))
    } catch {
      pending.reject(new Error('Permission policy persistence response was invalid'))
      if (this.standalone) this.markUnknown()
    }
  }

  private markUnknown(): void {
    if (this.uncertain) return
    this.uncertain = true
    try {
      this.standalone?.onUnknown?.()
    } catch { /* the uncertain request remains rejected */ }
  }
}
