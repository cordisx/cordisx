import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V3,
  CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V3,
  CORDISX_PERMISSION_POLICY_SCHEMA_V3,
  type CordisXPermissionAuthorizationDecisionV3,
  type CordisXPermissionAuthorizationPlanV3,
  type CordisXPermissionPolicyRecordV3,
  type CordisXPermissionPolicyV2,
} from '../permission-contracts.js'
import { CORDISX_CAPABILITY_CATALOG_VERSION } from '../capability-risk-catalog.js'
import { domPermissionAuthorizationKeyV3, normalizePermissionPolicyRecordV3 } from '../permission-model-v3.js'
import { isStandaloneManagerDomTarget } from '../standalone-permission-contract.js'
import { standalonePermissionProofBytes } from '../standalone-permission-proof.js'

type Review = {
  readonly identity: { readonly id: string; readonly source: string }
  readonly pointId: string
  readonly profileId: string
  readonly runtimeGeneration: string
  readonly moduleGeneration: string
  readonly artifact: { readonly version: string; readonly integrity: `sha256:${string}` }
}
type Approval = {
  readonly review: Review
  readonly planId: string
  readonly record: CordisXPermissionPolicyRecordV3
  readonly observed: CordisXPermissionPolicyV2
  readonly expires: number
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/** The private signing key stays in this closure and cannot be exported. */
export async function createStandalonePermissionSigner(
  scope: { readonly rendererId: string; readonly profileId: string; readonly generation: string },
  options: { readonly crypto?: Crypto; readonly now?: () => number } = {},
) {
  const provider = options.crypto ?? globalThis.crypto
  if (
    !provider?.subtle || !/^[a-f0-9]{64}$/u.test(scope.rendererId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(scope.profileId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(scope.generation)
  ) throw new Error('standalone-permission-signer-unavailable')
  const pair = await provider.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const exported = await provider.subtle.exportKey('jwk', pair.publicKey)
  if (typeof exported.x !== 'string' || typeof exported.y !== 'string') {
    throw new Error('standalone-permission-signer-unavailable')
  }
  const publicKey = Object.freeze({ kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y })
  const approvals = new Map<string, Approval>()
  let closed = false
  const now = () => (options.now ?? Date.now)()
  const remember = (
    review: Review,
    planId: string,
    record: CordisXPermissionPolicyRecordV3,
    observed: CordisXPermissionPolicyV2,
  ): (() => void) | undefined => {
    const current = now()
    if (!Number.isSafeInteger(current) || approvals.size >= 4) return undefined
    const key = JSON.stringify(record)
    const approval: Approval = {
      // Retain only immutable values, never the live review callbacks.
      review: {
        identity: { ...review.identity },
        pointId: review.pointId,
        profileId: review.profileId,
        runtimeGeneration: review.runtimeGeneration,
        moduleGeneration: review.moduleGeneration,
        artifact: { ...review.artifact },
      },
      planId,
      record,
      observed,
      expires: current + 60_000,
    }
    approvals.set(key, approval)
    return () => {
      if (approvals.get(key) === approval) approvals.delete(key)
    }
  }
  return {
    publicKey,
    /** Call only after the Host dialog has accepted a trusted user event. */
    noteConfirmed(
      review: Review,
      plan: CordisXPermissionAuthorizationPlanV3,
      decision: CordisXPermissionAuthorizationDecisionV3,
    ): boolean {
      try {
        const declaration = plan.declarations[0]
        const selected = decision.decisions[0]
        if (
          closed || !isStandaloneManagerDomTarget(review.identity, review.pointId)
          || review.profileId !== scope.profileId || review.runtimeGeneration !== scope.generation
          || plan.$schema !== CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V3 || plan.schemaVersion !== 3
          || plan.operation !== 'runtime' || plan.profileId !== review.profileId
          || plan.identity.pluginId !== review.identity.id || plan.identity.source !== review.identity.source
          || plan.binding.runtimeGeneration !== scope.generation
          || plan.binding.moduleGeneration !== review.moduleGeneration
          || plan.declarations.length !== 1 || !declaration || declaration.policy !== 'ask'
          || declaration.capability !== 'ui.extension-points.render' || declaration.scope.extensionPoints?.length !== 1
          || declaration.scope.extensionPoints[0] !== review.pointId
          || decision.$schema !== CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V3 || decision.schemaVersion !== 3
          || decision.origin !== 'explicit-user' || decision.planId !== plan.planId
          || decision.operation !== plan.operation
          || decision.profileId !== plan.profileId
          || JSON.stringify(decision.identity) !== JSON.stringify(plan.identity)
          || JSON.stringify(decision.binding) !== JSON.stringify(plan.binding) || decision.decisions.length !== 1
          || !selected || selected.capability !== declaration.capability
          || JSON.stringify(selected.scope) !== JSON.stringify(declaration.scope)
          || selected.securityFingerprint !== declaration.securityFingerprint
          || selected.decision !== 'allow-persistent' && selected.decision !== 'deny-persistent'
          || !declaration.allowedDecisions.includes(selected.decision)
        ) return false
        const record = normalizePermissionPolicyRecordV3({
          $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V3,
          schemaVersion: 3,
          key: {
            profileId: plan.profileId,
            identity: plan.identity,
            capability: declaration.capability,
            scope: declaration.scope,
            securityFingerprint: declaration.securityFingerprint,
          },
          policy: selected.decision,
        })
        return remember(review, plan.planId, record, 'ask') !== undefined
      } catch {
        return false
      }
    },
    /** The Host invokes this only for its trusted reset control. */
    noteReset(
      review: Review,
      observed: 'allow-persistent' | 'deny-persistent',
    ): (() => void) | undefined {
      try {
        if (
          closed || !isStandaloneManagerDomTarget(review.identity, review.pointId)
          || review.profileId !== scope.profileId || review.runtimeGeneration !== scope.generation
          || observed !== 'allow-persistent' && observed !== 'deny-persistent'
        ) return undefined
        const key = domPermissionAuthorizationKeyV3({
          profileId: review.profileId,
          identity: { source: review.identity.source, pluginId: review.identity.id },
          pointId: review.pointId,
          catalogVersion: CORDISX_CAPABILITY_CATALOG_VERSION,
        })
        const record = normalizePermissionPolicyRecordV3({
          $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V3,
          schemaVersion: 3,
          key,
          policy: 'ask',
        })
        const random = provider.getRandomValues(new Uint8Array(16))
        const planId = `reset-${[...random].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
        return remember(review, planId, record, observed)
      } catch {
        return undefined
      }
    },
    async sign(requestId: string, records: readonly unknown[]): Promise<unknown> {
      if (closed || records.length !== 1) throw new Error('standalone-permission-decision-unavailable')
      const record = normalizePermissionPolicyRecordV3(records[0])
      const key = JSON.stringify(record)
      const approval = approvals.get(key)
      approvals.delete(key)
      const issuedAt = now()
      if (!approval || !Number.isSafeInteger(issuedAt) || issuedAt > approval.expires) {
        throw new Error('standalone-permission-decision-unavailable')
      }
      const random = provider.getRandomValues(new Uint8Array(32))
      const decisionId = [...random].map(byte => byte.toString(16).padStart(2, '0')).join('')
      const payload = {
        version: 1 as const,
        rendererId: scope.rendererId,
        profileId: scope.profileId,
        ownerGeneration: scope.generation,
        moduleGeneration: approval.review.moduleGeneration,
        artifact: approval.review.artifact,
        requestId,
        decisionId,
        planId: approval.planId,
        issuedAt,
        observed: approval.observed,
        record: approval.record,
      }
      const bytes = standalonePermissionProofBytes(payload)
      const signature = await provider.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, bytes)
      if (closed) throw new Error('standalone-permission-decision-unavailable')
      return { payload, signature: base64url(new Uint8Array(signature)) }
    },
    close(): void {
      closed = true
      approvals.clear()
    },
  }
}

export type StandalonePermissionSigner = Awaited<ReturnType<typeof createStandalonePermissionSigner>>
