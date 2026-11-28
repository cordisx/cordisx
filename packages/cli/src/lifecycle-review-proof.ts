import type { DeferredPermissionDecision } from './permission-deferral.js'

export interface LifecycleReviewProofPayload {
  readonly version: 1
  readonly rendererId: string
  readonly profileId: string
  readonly ownerGeneration: string
  readonly requestId: string
  readonly reviewToken: string
  readonly decisionId: string
  readonly issuedAt: number
  readonly decision: DeferredPermissionDecision
}

/** Domain-separated bytes shared by the browser signer and its service owner. */
export function lifecycleReviewProofBytes(value: LifecycleReviewProofPayload): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify([
    'cordisx-lifecycle-review-v1',
    value.version,
    value.rendererId,
    value.profileId,
    value.ownerGeneration,
    value.requestId,
    value.reviewToken,
    value.decisionId,
    value.issuedAt,
    value.decision,
  ]))
}

export function normalizeLifecycleReviewProofPayload(value: unknown): LifecycleReviewProofPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('lifecycle-review-proof-invalid')
  const item = value as Record<string, unknown>
  const keys = [
    'version',
    'rendererId',
    'profileId',
    'ownerGeneration',
    'requestId',
    'reviewToken',
    'decisionId',
    'issuedAt',
    'decision',
  ]
  if (
    Object.keys(item).length !== keys.length || Object.keys(item).some(key => !keys.includes(key))
    || item.version !== 1 || typeof item.rendererId !== 'string' || !/^[a-f0-9]{64}$/u.test(item.rendererId)
    || typeof item.profileId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(item.profileId)
    || typeof item.ownerGeneration !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(item.ownerGeneration)
    || typeof item.requestId !== 'string' || !/^[A-Za-z0-9-]{1,96}$/u.test(item.requestId)
    || typeof item.reviewToken !== 'string' || !/^renderer-review-[a-f0-9-]{36}$/u.test(item.reviewToken)
    || typeof item.decisionId !== 'string' || !/^[a-f0-9]{64}$/u.test(item.decisionId)
    || !Number.isSafeInteger(item.issuedAt) || !item.decision || typeof item.decision !== 'object'
    || Array.isArray(item.decision)
  ) throw new Error('lifecycle-review-proof-invalid')
  return item as unknown as LifecycleReviewProofPayload
}
