import { CORDISX_CAPABILITY_CATALOG_VERSION } from './capability-risk-catalog.js'
import type { CordisXPermissionPolicyRecordV3, CordisXPermissionPolicyV2 } from './permission-contracts.js'
import { domPermissionAuthorizationKeyV3, normalizePermissionPolicyRecordV3 } from './permission-model-v3.js'
import { isNativeManagerDomTarget, isStandaloneManagerDomTarget } from './standalone-permission-contract.js'

export interface StandalonePermissionProofPayload {
  readonly version: 1
  readonly rendererId: string
  readonly profileId: string
  readonly ownerGeneration: string
  readonly moduleGeneration: string
  readonly artifact: { readonly version: string; readonly integrity: `sha256:${string}` }
  readonly requestId: string
  readonly decisionId: string
  readonly planId: string
  readonly issuedAt: number
  readonly observed: CordisXPermissionPolicyV2
  readonly record: CordisXPermissionPolicyRecordV3
}

/** Normalize the exact, renderer-local decision signed by the standalone Host. */
export function normalizeStandalonePermissionProofPayload(
  value: unknown,
  target: 'standalone' | 'native' = 'standalone',
): StandalonePermissionProofPayload {
  const invalid = (): never => {
    throw new Error('standalone-permission-proof-invalid')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const item = value as Record<string, unknown>
  const keys = [
    'version',
    'rendererId',
    'profileId',
    'ownerGeneration',
    'moduleGeneration',
    'artifact',
    'requestId',
    'decisionId',
    'planId',
    'issuedAt',
    'observed',
    'record',
  ]
  if (
    Object.keys(item).length !== keys.length || Object.keys(item).some(key => !keys.includes(key))
    || item.version !== 1 || typeof item.rendererId !== 'string' || !/^[a-f0-9]{64}$/u.test(item.rendererId)
    || typeof item.profileId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(item.profileId)
    || typeof item.ownerGeneration !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(item.ownerGeneration)
    || typeof item.moduleGeneration !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(item.moduleGeneration)
    || typeof item.requestId !== 'string' || !/^[a-z0-9-]{1,96}$/iu.test(item.requestId)
    || typeof item.decisionId !== 'string' || !/^[a-f0-9]{64}$/u.test(item.decisionId)
    || typeof item.planId !== 'string' || item.planId.length === 0 || item.planId.length > 128
    || /[\u0000-\u001f\u007f]/u.test(item.planId) || !Number.isSafeInteger(item.issuedAt)
    || Number(item.issuedAt) < 0
    || item.observed !== 'ask' && item.observed !== 'allow-persistent' && item.observed !== 'deny-persistent'
  ) return invalid()
  if (!item.artifact || typeof item.artifact !== 'object' || Array.isArray(item.artifact)) return invalid()
  const artifact = item.artifact as Record<string, unknown>
  if (
    Object.keys(artifact).length !== 2 || Object.keys(artifact).some(key => !['version', 'integrity'].includes(key))
    || typeof artifact.version !== 'string' || artifact.version.length === 0 || artifact.version.length > 128
    || /[\u0000-\u001f\u007f]/u.test(artifact.version)
    || typeof artifact.integrity !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(artifact.integrity)
  ) return invalid()
  const record = normalizePermissionPolicyRecordV3(item.record)
  const pointId = record.key.scope.extensionPoints?.[0]
  const identity = { id: record.key.identity.pluginId, source: record.key.identity.source }
  if (
    record.key.profileId !== item.profileId || record.key.scope.extensionPoints?.length !== 1
    || pointId === undefined
    || !(target === 'native' ? isNativeManagerDomTarget : isStandaloneManagerDomTarget)(identity, pointId)
    || (item.observed === 'ask'
      ? record.policy !== 'allow-persistent' && record.policy !== 'deny-persistent'
      : record.policy !== 'ask')
  ) return invalid()
  const canonical = domPermissionAuthorizationKeyV3({
    profileId: item.profileId,
    identity: record.key.identity,
    pointId,
    catalogVersion: CORDISX_CAPABILITY_CATALOG_VERSION,
  })
  if (record.key.securityFingerprint !== canonical.securityFingerprint) return invalid()
  return {
    version: 1,
    rendererId: item.rendererId,
    profileId: item.profileId,
    ownerGeneration: item.ownerGeneration,
    moduleGeneration: item.moduleGeneration,
    artifact: { version: artifact.version, integrity: artifact.integrity as `sha256:${string}` },
    requestId: item.requestId,
    decisionId: item.decisionId,
    planId: item.planId,
    issuedAt: Number(item.issuedAt),
    observed: item.observed,
    record,
  }
}

/** Shared canonical bytes; the signature never contains a private key or owner source. */
export function standalonePermissionProofBytes(
  payload: unknown,
  target: 'standalone' | 'native' = 'standalone',
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(normalizeStandalonePermissionProofPayload(payload, target)))
}

export type StandaloneOncePermissionProofPayload = StandalonePermissionProofPayload & {
  readonly decision: 'allow-once' | 'deny-once'
}

/** A one-time decision signs the same exact target but never changes the durable policy. */
export function normalizeStandaloneOncePermissionProofPayload(
  value: unknown,
  target: 'standalone' | 'native' = 'standalone',
): StandaloneOncePermissionProofPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('standalone-permission-proof-invalid')
  }
  const { decision, ...rest } = value as Record<string, unknown>
  if (decision !== 'allow-once' && decision !== 'deny-once') throw new Error('standalone-permission-proof-invalid')
  const record = normalizePermissionPolicyRecordV3(rest.record)
  if (record.policy !== 'ask' || rest.observed !== 'ask') throw new Error('standalone-permission-proof-invalid')
  const checked = normalizeStandalonePermissionProofPayload({
    ...rest,
    record: { ...record, policy: 'allow-persistent' },
  }, target)
  return { ...checked, record, decision }
}

export function standaloneOncePermissionProofBytes(
  payload: unknown,
  target: 'standalone' | 'native' = 'standalone',
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(normalizeStandaloneOncePermissionProofPayload(payload, target)))
}
