import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V3,
  CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V2,
  CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V3,
  CORDISX_PERMISSION_POLICY_SCHEMA_V2,
  CORDISX_PERMISSION_POLICY_SCHEMA_V3,
  type CordisXPermissionAuthorizationDecisionV2,
  type CordisXPermissionAuthorizationDecisionV3,
  type CordisXPermissionAuthorizationPlanV2,
  type CordisXPermissionAuthorizationPlanV3,
  type CordisXPermissionPolicyRecordV2,
  type CordisXPermissionPolicyRecordV3,
  type CordisXPermissionPolicyV2,
} from '../permission-contracts.js'
import { CORDISX_CAPABILITY_CATALOG_VERSION } from '../capability-risk-catalog.js'
import { domPermissionAuthorizationKeyV3, normalizePermissionPolicyRecordV3 } from '../permission-model-v3.js'
import { isNativeManagerDomTarget, isStandaloneManagerDomTarget } from '../standalone-permission-contract.js'
import { standaloneOncePermissionProofBytes, standalonePermissionProofBytes } from '../standalone-permission-proof.js'
import { assertPermissionAuthorizationDecisionV2, normalizePermissionPolicyRecordV2 } from '../permission-model-v2.js'
import { nativeRuntimeOnceProofBytes } from '../native-runtime-once-proof.js'
import { isPermissionPolicyRecordV2 } from '../permission-persistence.js'
import { runtimePolicyProofBytes } from '../runtime-policy-proof.js'
import { webRuntimeOnceProofBytes } from '../web-runtime-once-proof.js'
import {
  assertDeferredPermissionDecision,
  type DeferredPermissionDecision,
  type DeferredPermissionPlan,
} from '../permission-deferral.js'
import { lifecycleReviewProofBytes } from '../lifecycle-review-proof.js'

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
type RuntimeReview = Omit<Review, 'pointId'>
type RuntimeApproval = {
  readonly review: RuntimeReview
  readonly record: CordisXPermissionPolicyRecordV2
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
  options: { readonly crypto?: Crypto; readonly now?: () => number; readonly target?: 'standalone' | 'native' } = {},
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
  const runtimeApprovals = new Map<string, RuntimeApproval>()
  const target = options.target ?? 'standalone'
  const validTarget = target === 'native' ? isNativeManagerDomTarget : isStandaloneManagerDomTarget
  let closed = false
  const now = () => (options.now ?? Date.now)()
  const remember = (
    review: Review,
    planId: string,
    record: CordisXPermissionPolicyRecordV3,
    observed: CordisXPermissionPolicyV2,
  ): (() => void) | undefined => {
    const current = now()
    if (!Number.isSafeInteger(current) || approvals.size + runtimeApprovals.size >= 4) return undefined
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
  const confirmed = (
    review: Review,
    plan: CordisXPermissionAuthorizationPlanV3,
    decision: CordisXPermissionAuthorizationDecisionV3,
    once: boolean,
  ) => {
    const declaration = plan.declarations[0]
    const selected = decision.decisions[0]
    if (
      closed || !validTarget(review.identity, review.pointId)
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
      || decision.origin !== 'explicit-user' || decision.planId !== plan.planId || decision.operation !== plan.operation
      || decision.profileId !== plan.profileId || JSON.stringify(decision.identity) !== JSON.stringify(plan.identity)
      || JSON.stringify(decision.binding) !== JSON.stringify(plan.binding) || decision.decisions.length !== 1
      || !selected || selected.capability !== declaration.capability
      || JSON.stringify(selected.scope) !== JSON.stringify(declaration.scope)
      || selected.securityFingerprint !== declaration.securityFingerprint
      || !(once ? ['allow-once', 'deny-once'] : ['allow-persistent', 'deny-persistent']).includes(selected.decision)
      || !declaration.allowedDecisions.includes(selected.decision)
    ) throw new Error('standalone-permission-decision-unavailable')
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
      policy: once ? 'ask' : selected.decision,
    })
    return { record, selected: selected.decision }
  }
  const runtimeDecision = (
    plan: CordisXPermissionAuthorizationPlanV2,
    decision: CordisXPermissionAuthorizationDecisionV2,
  ) => {
    if (
      closed || plan.$schema !== CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V2
      || plan.schemaVersion !== 2 || plan.operation !== 'runtime' || plan.profileId !== scope.profileId
      || plan.binding.runtimeGeneration !== scope.generation || !plan.binding.moduleGeneration
      || plan.catalogVersion !== CORDISX_CAPABILITY_CATALOG_VERSION || plan.declarations.length !== 1
    ) throw new Error('native-runtime-once-decision-unavailable')
    assertPermissionAuthorizationDecisionV2(plan, decision)
    const declaration = plan.declarations[0]!
    const selected = decision.decisions[0]!
    if (
      (declaration.policy !== 'ask' && declaration.policy !== 'allow-persistent')
      || selected.decision !== 'allow-once' && selected.decision !== 'deny-once'
    ) throw new Error('native-runtime-once-decision-unavailable')
    const record = normalizePermissionPolicyRecordV2({
      $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V2,
      schemaVersion: 2,
      key: {
        profileId: plan.profileId,
        identity: plan.identity,
        capability: declaration.capability,
        scope: declaration.scope,
        securityFingerprint: declaration.securityFingerprint,
      },
      policy: 'ask',
    })
    return {
      record,
      selected: selected.decision,
      observed: declaration.policy,
      moduleGeneration: plan.binding.moduleGeneration!,
    }
  }
  return {
    publicKey,
    /** Called only after the Host lifecycle dialog accepts a trusted user event. */
    async signLifecycle(
      requestId: string,
      reviewToken: string,
      plan: DeferredPermissionPlan,
      decision: DeferredPermissionDecision,
    ): Promise<unknown> {
      if (
        closed || target !== 'standalone' || !/^[A-Za-z0-9-]{1,96}$/u.test(requestId)
        || !/^renderer-review-[a-f0-9-]{36}$/u.test(reviewToken) || plan.binding.requestId !== reviewToken
        || plan.profileId !== scope.profileId || plan.binding.runtimeGeneration !== scope.generation
        || !['install', 'update', 'enable'].includes(plan.operation) || decision.origin !== 'explicit-user'
        || decision.decisions.some(item => item.decision !== 'allow-once' && item.decision !== 'deny-once')
      ) throw new Error('lifecycle-review-decision-unavailable')
      assertDeferredPermissionDecision(plan, decision)
      const random = provider.getRandomValues(new Uint8Array(32))
      const payload = {
        version: 1 as const,
        rendererId: scope.rendererId,
        profileId: scope.profileId,
        ownerGeneration: scope.generation,
        requestId,
        reviewToken,
        decisionId: [...random].map(byte => byte.toString(16).padStart(2, '0')).join(''),
        issuedAt: now(),
        decision: structuredClone(decision),
      }
      if (!Number.isSafeInteger(payload.issuedAt)) throw new Error('lifecycle-review-decision-unavailable')
      const signature = await provider.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        lifecycleReviewProofBytes(payload),
      )
      if (closed) throw new Error('lifecycle-review-decision-unavailable')
      return { payload, signature: base64url(new Uint8Array(signature)) }
    },
    /** Called only after the native Host dialog accepted a trusted runtime decision. */
    async signRuntimeOnce(
      requestId: string,
      plan: CordisXPermissionAuthorizationPlanV2,
      decision: CordisXPermissionAuthorizationDecisionV2,
    ): Promise<{
      readonly record: CordisXPermissionPolicyRecordV2
      readonly decision: 'allow-once' | 'deny-once'
      readonly proof: unknown
    }> {
      if (target !== 'native') throw new Error('native-runtime-once-decision-unavailable')
      const { record, selected, observed, moduleGeneration } = runtimeDecision(plan, decision)
      const random = provider.getRandomValues(new Uint8Array(32))
      const payload = {
        version: 1 as const,
        kind: 'native-runtime-v2' as const,
        rendererId: scope.rendererId,
        profileId: scope.profileId,
        ownerGeneration: scope.generation,
        moduleGeneration,
        requestId,
        decisionId: [...random].map(byte => byte.toString(16).padStart(2, '0')).join(''),
        planId: plan.planId,
        issuedAt: now(),
        observed,
        record,
        decision: selected,
      }
      const signature = await provider.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        nativeRuntimeOnceProofBytes(payload),
      )
      if (closed) throw new Error('native-runtime-once-decision-unavailable')
      return {
        record,
        decision: selected,
        proof: { payload, signature: base64url(new Uint8Array(signature)) },
      }
    },
    /** Called only after a trusted Web runtime prompt for this verified artifact. */
    async signWebRuntimeOnce(
      requestId: string,
      artifact: { readonly version: string; readonly integrity: `sha256:${string}` },
      plan: CordisXPermissionAuthorizationPlanV2,
      decision: CordisXPermissionAuthorizationDecisionV2,
    ): Promise<{
      readonly record: CordisXPermissionPolicyRecordV2
      readonly decision: 'allow-once' | 'deny-once'
      readonly proof: unknown
    }> {
      if (target !== 'standalone' || plan.binding.requestId !== requestId) {
        throw new Error('web-runtime-once-decision-unavailable')
      }
      const { record, selected, observed, moduleGeneration } = runtimeDecision(plan, decision)
      const random = provider.getRandomValues(new Uint8Array(32))
      const payload = {
        version: 1 as const,
        kind: 'web-runtime-v2' as const,
        rendererId: scope.rendererId,
        profileId: scope.profileId,
        ownerGeneration: scope.generation,
        moduleGeneration,
        requestId,
        decisionId: [...random].map(byte => byte.toString(16).padStart(2, '0')).join(''),
        planId: plan.planId,
        issuedAt: now(),
        observed,
        record,
        decision: selected,
        artifact: { ...artifact },
      }
      const signature = await provider.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        webRuntimeOnceProofBytes(payload),
      )
      if (closed) throw new Error('web-runtime-once-decision-unavailable')
      return { record, decision: selected, proof: { payload, signature: base64url(new Uint8Array(signature)) } }
    },
    /** Call only after the Host dialog has accepted a trusted user event. */
    noteConfirmed(
      review: Review,
      plan: CordisXPermissionAuthorizationPlanV3,
      decision: CordisXPermissionAuthorizationDecisionV3,
    ): boolean {
      try {
        const { record } = confirmed(review, plan, decision, false)
        return remember(review, plan.planId, record, 'ask') !== undefined
      } catch {
        return false
      }
    },
    /** Called only after the Host has received the real one-time decision. */
    async signOnce(
      requestId: string,
      review: Review,
      plan: CordisXPermissionAuthorizationPlanV3,
      decision: CordisXPermissionAuthorizationDecisionV3,
    ): Promise<
      {
        readonly record: CordisXPermissionPolicyRecordV3
        readonly decision: 'allow-once' | 'deny-once'
        readonly proof: unknown
      }
    > {
      const { record, selected } = confirmed(review, plan, decision, true)
      if (selected !== 'allow-once' && selected !== 'deny-once') {
        throw new Error('standalone-permission-decision-unavailable')
      }
      const issuedAt = now()
      const random = provider.getRandomValues(new Uint8Array(32))
      const decisionId = [...random].map(byte => byte.toString(16).padStart(2, '0')).join('')
      const payload = {
        version: 1 as const,
        rendererId: scope.rendererId,
        profileId: scope.profileId,
        ownerGeneration: scope.generation,
        moduleGeneration: review.moduleGeneration,
        artifact: review.artifact,
        requestId,
        decisionId,
        planId: plan.planId,
        issuedAt,
        observed: 'ask' as const,
        record,
        decision: selected,
      }
      const bytes = standaloneOncePermissionProofBytes(payload, target)
      const signature = await provider.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, bytes)
      if (closed) throw new Error('standalone-permission-decision-unavailable')
      return { record, decision: selected, proof: { payload, signature: base64url(new Uint8Array(signature)) } }
    },
    /** The Host invokes this only for its trusted reset control. */
    noteReset(
      review: Review,
      observed: 'allow-persistent' | 'deny-persistent',
    ): (() => void) | undefined {
      try {
        if (
          closed || !validTarget(review.identity, review.pointId)
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
    /** Host-owned settings controls call this only after consuming a trusted click. */
    noteRuntimePolicy(
      review: RuntimeReview,
      raw: CordisXPermissionPolicyRecordV2,
      observed: CordisXPermissionPolicyV2,
    ): (() => void) | undefined {
      try {
        const record = normalizePermissionPolicyRecordV2(raw)
        const current = now()
        if (
          closed || !validTarget(review.identity, 'manager.content') || review.profileId !== scope.profileId
          || review.runtimeGeneration !== scope.generation || record.key.profileId !== scope.profileId
          || record.key.identity.pluginId !== review.identity.id
          || record.key.identity.source !== review.identity.source
          || record.policy === observed || !['ask', 'allow-persistent', 'deny-persistent'].includes(observed)
          || !Number.isSafeInteger(current) || approvals.size + runtimeApprovals.size >= 4
        ) return undefined
        const key = JSON.stringify(record)
        const approval: RuntimeApproval = {
          review: {
            identity: { ...review.identity },
            profileId: review.profileId,
            runtimeGeneration: review.runtimeGeneration,
            moduleGeneration: review.moduleGeneration,
            artifact: { ...review.artifact },
          },
          record,
          observed,
          expires: current + 60_000,
        }
        runtimeApprovals.set(key, approval)
        return () => {
          if (runtimeApprovals.get(key) === approval) runtimeApprovals.delete(key)
        }
      } catch {
        return undefined
      }
    },
    async sign(requestId: string, records: readonly unknown[]): Promise<unknown> {
      if (closed || records.length !== 1) throw new Error('standalone-permission-decision-unavailable')
      if (isPermissionPolicyRecordV2(records[0])) {
        const record = normalizePermissionPolicyRecordV2(records[0])
        const key = JSON.stringify(record)
        const approval = runtimeApprovals.get(key)
        runtimeApprovals.delete(key)
        const issuedAt = now()
        if (!approval || !Number.isSafeInteger(issuedAt) || issuedAt > approval.expires) {
          throw new Error('runtime-permission-decision-unavailable')
        }
        const random = provider.getRandomValues(new Uint8Array(32))
        const payload = {
          version: 1 as const,
          kind: 'runtime-policy-v2' as const,
          target,
          rendererId: scope.rendererId,
          profileId: scope.profileId,
          ownerGeneration: scope.generation,
          moduleGeneration: approval.review.moduleGeneration,
          artifact: approval.review.artifact,
          requestId,
          decisionId: [...random].map(byte => byte.toString(16).padStart(2, '0')).join(''),
          issuedAt,
          observed: approval.observed,
          record: approval.record,
        }
        const signature = await provider.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          pair.privateKey,
          runtimePolicyProofBytes(payload, target),
        )
        if (closed) throw new Error('runtime-permission-decision-unavailable')
        return { payload, signature: base64url(new Uint8Array(signature)) }
      }
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
      const bytes = standalonePermissionProofBytes(payload, target)
      const signature = await provider.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, bytes)
      if (closed) throw new Error('standalone-permission-decision-unavailable')
      return { payload, signature: base64url(new Uint8Array(signature)) }
    },
    close(): void {
      closed = true
      approvals.clear()
      runtimeApprovals.clear()
    },
  }
}

export type StandalonePermissionSigner = Awaited<ReturnType<typeof createStandalonePermissionSigner>>
