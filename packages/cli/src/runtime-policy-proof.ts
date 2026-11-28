import type { CordisXPermissionPolicyRecordV2, CordisXPermissionPolicyV2 } from './permission-contracts.js'
import { normalizePermissionPolicyRecordV2 } from './permission-model-v2.js'
import { isNativeManagerDomTarget, isStandaloneManagerDomTarget } from './standalone-permission-contract.js'

export interface RuntimePolicyProof {
  readonly version: 1
  readonly kind: 'runtime-policy-v2'
  readonly target: 'standalone' | 'native'
  readonly rendererId: string
  readonly profileId: string
  readonly ownerGeneration: string
  readonly moduleGeneration: string
  readonly artifact: { readonly version: string; readonly integrity: `sha256:${string}` }
  readonly requestId: string
  readonly decisionId: string
  readonly issuedAt: number
  readonly observed: CordisXPermissionPolicyV2
  readonly record: CordisXPermissionPolicyRecordV2
}

/** A distinct signature domain for a single Host-reviewed persistent policy change. */
export function normalizeRuntimePolicyProof(value: unknown, target: 'standalone' | 'native'): RuntimePolicyProof {
  const invalid = (): never => {
    throw new Error('runtime-policy-proof-invalid')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const item = value as Record<string, unknown>
  const keys = [
    'version',
    'kind',
    'target',
    'rendererId',
    'profileId',
    'ownerGeneration',
    'moduleGeneration',
    'artifact',
    'requestId',
    'decisionId',
    'issuedAt',
    'observed',
    'record',
  ]
  if (
    Object.keys(item).length !== keys.length || Object.keys(item).some(key => !keys.includes(key))
    || item.version !== 1 || item.kind !== 'runtime-policy-v2' || item.target !== target
    || typeof item.rendererId !== 'string' || !/^[a-f0-9]{64}$/u.test(item.rendererId)
    || typeof item.profileId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(item.profileId)
    || typeof item.ownerGeneration !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(item.ownerGeneration)
    || typeof item.moduleGeneration !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(item.moduleGeneration)
    || typeof item.requestId !== 'string' || !/^[A-Za-z0-9-]{1,96}$/u.test(item.requestId)
    || typeof item.decisionId !== 'string' || !/^[a-f0-9]{64}$/u.test(item.decisionId)
    || !Number.isSafeInteger(item.issuedAt) || Number(item.issuedAt) < 0
    || item.observed !== 'ask' && item.observed !== 'allow-persistent' && item.observed !== 'deny-persistent'
    || !item.artifact || typeof item.artifact !== 'object' || Array.isArray(item.artifact)
  ) return invalid()
  const artifact = item.artifact as Record<string, unknown>
  if (
    Object.keys(artifact).length !== 2 || typeof artifact.version !== 'string' || artifact.version.length === 0
    || artifact.version.length > 128 || /[\u0000-\u001f\u007f]/u.test(artifact.version)
    || typeof artifact.integrity !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(artifact.integrity)
  ) return invalid()
  const record = normalizePermissionPolicyRecordV2(item.record)
  const identity = { id: record.key.identity.pluginId, source: record.key.identity.source }
  if (
    record.key.profileId !== item.profileId || record.policy === item.observed
    || !(target === 'native' ? isNativeManagerDomTarget : isStandaloneManagerDomTarget)(identity, 'manager.content')
  ) return invalid()
  return {
    version: 1,
    kind: 'runtime-policy-v2',
    target,
    rendererId: item.rendererId,
    profileId: item.profileId,
    ownerGeneration: item.ownerGeneration,
    moduleGeneration: item.moduleGeneration,
    artifact: { version: artifact.version, integrity: artifact.integrity as `sha256:${string}` },
    requestId: item.requestId,
    decisionId: item.decisionId,
    issuedAt: Number(item.issuedAt),
    observed: item.observed,
    record,
  }
}

export function runtimePolicyProofBytes(value: unknown, target: 'standalone' | 'native'): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(normalizeRuntimePolicyProof(value, target)))
}
