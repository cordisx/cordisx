import { timingSafeEqual } from 'node:crypto'
import type { CordisXPermissionPolicyRecordV1, CordisXPluginIdentity } from '../platform-contracts.js'
import { updateHomeConfigAtomic } from '../config/home-config.js'
import { normalizePermissionPolicyRecord, permissionRecordKey } from '../permissions.js'

export const PERMISSION_BINDING = '__cordisxPermissionPolicyRequestV1'
export const PERMISSION_RECEIVER = '__cordisxPermissionPolicyReceiveV1'
export const MAX_PERMISSION_REQUEST_BYTES = 32 * 1024
export const MAX_PERMISSION_REQUESTS = 4
export const MAX_PERMISSION_POLICY_BATCH = 14

export interface PermissionBindingRequest {
  readonly requestId: string
  readonly records: readonly CordisXPermissionPolicyRecordV1[]
}

export interface PermissionPersistenceContext {
  readonly configPath: string
  readonly profileId: string
  readonly token: string
  readonly identities: readonly CordisXPluginIdentity[]
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
  const records = request.records.map(item => normalizePermissionPolicyRecord(item))
  const keys = new Set<string>()
  for (const record of records) {
    if (record.key.profileId !== context.profileId) throw new Error('permission request profile is invalid')
    if (!context.identities.some(identity => (
      identity.source === record.key.identity.source && identity.id === record.key.identity.pluginId
    ))) throw new Error('permission request identity is invalid')
    const key = permissionRecordKey(record)
    if (keys.has(key)) throw new Error('permission request contains a duplicate policy key')
    keys.add(key)
  }
  return { requestId: request.requestId, records }
}

export async function persistPermissionPolicies(
  context: Pick<PermissionPersistenceContext, 'configPath'>,
  records: readonly CordisXPermissionPolicyRecordV1[],
): Promise<readonly CordisXPermissionPolicyRecordV1[]> {
  const keys = new Set(records.map(permissionRecordKey))
  const updated = await updateHomeConfigAtomic(current => ({
    ...current,
    permissions: [
      ...current.permissions.filter(item => !keys.has(permissionRecordKey(item))),
      ...records,
    ],
  }), context.configPath)
  const persisted = new Map(updated.permissions.map(item => [permissionRecordKey(item), item]))
  return records.map((record) => {
    const readback = persisted.get(permissionRecordKey(record))
    if (readback === undefined) throw new Error('permission policy persistence readback failed')
    return readback
  })
}
