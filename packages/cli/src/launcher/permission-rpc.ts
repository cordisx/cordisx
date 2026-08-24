import { timingSafeEqual } from 'node:crypto'
import type { CordisXPluginIdentity } from '../platform-contracts.js'
import { updateHomeConfigAtomic } from '../config/home-config.js'
import {
  isPermissionPolicyRecordV2,
  normalizePersistedPermissionPolicyRecord,
  persistedPermissionMigrationKey,
  persistedPermissionRecordKey,
  type CordisXPersistedPermissionPolicyRecord,
} from '../permission-persistence.js'

export const PERMISSION_BINDING = '__cordisxPermissionPolicyRequestV1'
export const PERMISSION_RECEIVER = '__cordisxPermissionPolicyReceiveV1'
export const MAX_PERMISSION_REQUEST_BYTES = 32 * 1024
export const MAX_PERMISSION_REQUESTS = 4
export const MAX_PERMISSION_POLICY_BATCH = 22

export interface PermissionBindingRequest {
  readonly requestId: string
  readonly records: readonly CordisXPersistedPermissionPolicyRecord[]
}

export interface PermissionPersistenceContext {
  readonly configPath: string
  readonly profileId: string
  readonly token: string
  readonly identities: readonly CordisXPluginIdentity[]
  readonly identityAllowed?: (identity: CordisXPluginIdentity) => boolean
}

/** Mutable Host-owned identity fence for package generations not present in launcher config. */
export class PluginPermissionIdentityRegistry {
  private current = new Map<string, string>()
  private readonly previous = new Map<string, Map<string, string>>()

  constructor(identities: readonly CordisXPluginIdentity[] = []) {
    this.current = new Map(identities.map(identity => [identity.id, identity.source]))
  }

  allowed(identity: CordisXPluginIdentity): boolean {
    return this.current.get(identity.id) === identity.source
  }

  stage(transactionId: string, operation: string, targetId: string, affected: readonly string[], source?: string): void {
    if (this.previous.has(transactionId)) throw new Error('permission identity transaction already exists')
    this.previous.set(transactionId, new Map(this.current))
    if (operation === 'uninstall') for (const id of affected) this.current.delete(id)
    else if (source !== undefined) this.current.set(targetId, source)
  }

  commit(transactionId: string): void {
    this.previous.delete(transactionId)
  }

  abort(transactionId: string): void {
    const previous = this.previous.get(transactionId)
    if (previous === undefined) return
    this.current = previous
    this.previous.delete(transactionId)
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function sameToken(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

export function parsePermissionBindingRequest(
  value: unknown,
  context: Omit<PermissionPersistenceContext, 'configPath'>,
): PermissionBindingRequest {
  const request = object(value, 'permission request')
  const unknown = Object.keys(request).filter(key => !['token', 'requestId', 'records'].includes(key))
  if (unknown.length > 0) throw new Error(`permission request contains unknown field ${unknown[0]}`)
  if (typeof request.token !== 'string' || !sameToken(request.token, context.token)) throw new Error('permission request token is invalid')
  if (typeof request.requestId !== 'string' || !/^[a-z0-9-]{1,96}$/i.test(request.requestId)) {
    throw new Error('permission request id is invalid')
  }
  if (!Array.isArray(request.records) || request.records.length < 1 || request.records.length > MAX_PERMISSION_POLICY_BATCH) {
    throw new Error('permission request records are invalid')
  }
  const records = request.records.map(item => normalizePersistedPermissionPolicyRecord(item))
  const keys = new Set<string>()
  for (const record of records) {
    if (record.key.profileId !== context.profileId) throw new Error('permission request profile is invalid')
    if (!context.identities.some(identity => (
      identity.source === record.key.identity.source && identity.id === record.key.identity.pluginId
    )) && context.identityAllowed?.({ source: record.key.identity.source, id: record.key.identity.pluginId }) !== true) {
      throw new Error('permission request identity is invalid')
    }
    const key = persistedPermissionRecordKey(record)
    if (keys.has(key)) throw new Error('permission request contains a duplicate policy key')
    keys.add(key)
  }
  return { requestId: request.requestId, records }
}

export async function persistPermissionPolicies(
  context: Pick<PermissionPersistenceContext, 'configPath'>,
  records: readonly CordisXPersistedPermissionPolicyRecord[],
): Promise<readonly CordisXPersistedPermissionPolicyRecord[]> {
  const normalized = records.map(item => normalizePersistedPermissionPolicyRecord(item))
  const keys = new Set(normalized.map(persistedPermissionRecordKey))
  const migrated = new Set(normalized.filter(isPermissionPolicyRecordV2).map(persistedPermissionMigrationKey))
  const updated = await updateHomeConfigAtomic(current => ({
    ...current,
    permissions: [
      ...current.permissions.filter(item => !keys.has(persistedPermissionRecordKey(item))
        && !(migrated.has(persistedPermissionMigrationKey(item)) && !isPermissionPolicyRecordV2(item))),
      ...normalized,
    ],
  }), context.configPath)
  const persisted = new Map(updated.permissions.map(item => [persistedPermissionRecordKey(item), item]))
  return normalized.map((record) => {
    const readback = persisted.get(persistedPermissionRecordKey(record))
    if (readback === undefined) throw new Error('permission policy persistence readback failed')
    return readback
  })
}
