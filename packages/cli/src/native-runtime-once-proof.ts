import type { CordisXPermissionPolicyRecordV2, CordisXPermissionPolicyV2 } from './permission-contracts.js'
import { normalizePermissionPolicyRecordV2 } from './permission-model-v2.js'

/** A Host-only runtime decision, bound to its current native document and plugin generation. */
export interface NativeRuntimeOnceProof {
  readonly version: 1
  readonly kind: 'native-runtime-v2'
  readonly rendererId: string
  readonly profileId: string
  readonly ownerGeneration: string
  readonly moduleGeneration: string
  readonly requestId: string
  readonly decisionId: string
  readonly planId: string
  readonly issuedAt: number
  readonly observed: CordisXPermissionPolicyV2
  readonly record: CordisXPermissionPolicyRecordV2
  readonly decision: 'allow-once' | 'deny-once'
}

export function normalizeNativeRuntimeOnceProof(value: unknown): NativeRuntimeOnceProof {
  const invalid = (): never => {
    throw new Error('native-runtime-once-proof-invalid')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const item = value as Record<string, unknown>
  const keys = [
    'version',
    'kind',
    'rendererId',
    'profileId',
    'ownerGeneration',
    'moduleGeneration',
    'requestId',
    'decisionId',
    'planId',
    'issuedAt',
    'observed',
    'record',
    'decision',
  ]
  if (
    Object.keys(item).length !== keys.length || Object.keys(item).some(key => !keys.includes(key))
    || item.version !== 1 || item.kind !== 'native-runtime-v2'
    || typeof item.rendererId !== 'string' || !/^[a-f0-9]{64}$/u.test(item.rendererId)
    || typeof item.profileId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(item.profileId)
    || typeof item.ownerGeneration !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(item.ownerGeneration)
    || typeof item.moduleGeneration !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(item.moduleGeneration)
    || typeof item.requestId !== 'string' || !/^[A-Za-z0-9-]{1,96}$/u.test(item.requestId)
    || typeof item.decisionId !== 'string' || !/^[a-f0-9]{64}$/u.test(item.decisionId)
    || typeof item.planId !== 'string' || item.planId.length === 0 || item.planId.length > 256
    || /[\u0000-\u001f\u007f]/u.test(item.planId) || !Number.isSafeInteger(item.issuedAt)
    || Number(item.issuedAt) < 0 || item.observed !== 'ask' && item.observed !== 'allow-persistent'
    || item.decision !== 'allow-once' && item.decision !== 'deny-once'
  ) return invalid()
  const record = normalizePermissionPolicyRecordV2(item.record)
  if (record.key.profileId !== item.profileId || record.policy !== 'ask') return invalid()
  return {
    version: 1,
    kind: 'native-runtime-v2',
    rendererId: item.rendererId,
    profileId: item.profileId,
    ownerGeneration: item.ownerGeneration,
    moduleGeneration: item.moduleGeneration,
    requestId: item.requestId,
    decisionId: item.decisionId,
    planId: item.planId,
    issuedAt: Number(item.issuedAt),
    observed: item.observed,
    record,
    decision: item.decision,
  }
}

export function nativeRuntimeOnceProofBytes(value: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(normalizeNativeRuntimeOnceProof(value)))
}
