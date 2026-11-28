import { webcrypto } from 'node:crypto'
import { expect, it } from 'vitest'
import { buildDomPermissionAuthorizationPlanV3 } from '../packages/cli/src/capability-risk-catalog.js'
import { ManagerPermissionProofAuthority } from '../packages/cli/src/cli/manager-permission-proof-authority.js'
import { createStandalonePermissionSigner } from '../packages/cli/src/independent-manager/standalone-permission-signer.js'
import { PermissionAuthorizationViewModel } from '../packages/cli/src/permission-authorization-view-model.js'
import { CORDISX_PERMISSION_POLICY_SCHEMA_V3 } from '../packages/cli/src/permission-contracts.js'
import { normalizePermissionPolicyRecordV3 } from '../packages/cli/src/permission-model-v3.js'
import { normalizeStandalonePermissionProofPayload } from '../packages/cli/src/standalone-permission-proof.js'
import {
  buildDeferredPermissionPlan,
  type DeferredPermissionDecision,
} from '../packages/cli/src/permission-deferral.js'

const scope = { rendererId: 'a'.repeat(64), profileId: 'default', generation: 'owner-1' }
const identity = { id: 'channel', source: `https://renderer.cordisx.invalid/plugin/${'b'.repeat(64)}` }
const review = {
  identity,
  pointId: 'manager.content',
  profileId: scope.profileId,
  runtimeGeneration: scope.generation,
  moduleGeneration: 'configured-1',
  artifact: { version: '1.2.3', integrity: `sha256:${'c'.repeat(64)}` as const },
}
const plan = buildDomPermissionAuthorizationPlanV3({
  planId: 'review-1',
  profileId: scope.profileId,
  identity: { source: identity.source, pluginId: identity.id },
  binding: { operationId: 'review-1', runtimeGeneration: scope.generation, moduleGeneration: review.moduleGeneration },
  declaration: { name: 'ui.extension-points.render', required: false, scope: { extensionPoints: [review.pointId] } },
  policies: [],
})
const declaration = plan.declarations[0]!
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
  policy: 'allow-persistent',
})

function decision() {
  const view = new PermissionAuthorizationViewModel(plan)
  view.select('ui.extension-points.render', 'allow-persistent')
  const result = view.confirm()
  if (result.status !== 'confirmed' || result.decision.schemaVersion !== 3) throw new Error('fixture decision failed')
  return result.decision
}

it('binds a confirmed decision to one renderer, artifact, request and owner snapshot', async () => {
  let clock = 1_700_000_000_000
  const signer = await createStandalonePermissionSigner(scope, {
    crypto: webcrypto as unknown as Crypto,
    now: () => clock,
  })
  const controller = new AbortController()
  const context = {
    profileId: scope.profileId,
    rendererId: scope.rendererId,
    ownerGeneration: scope.generation,
    signal: controller.signal,
  }
  const authority = new ManagerPermissionProofAuthority({
    profileId: scope.profileId,
    generation: scope.generation,
    isCurrent: () => true,
    now: () => clock,
  })
  try {
    authority.register(context, signer.publicKey)
    expect(() => authority.register(context, signer.publicKey)).toThrow('permission-proof-unavailable')
    const liveReview = { ...review, isCurrent: () => true, verifyCurrent: async () => true, invalidate: () => {} }
    expect(signer.noteConfirmed(liveReview, plan, decision())).toBe(true)
    const proof = await signer.sign('request-1', [record])
    expect(() =>
      normalizeStandalonePermissionProofPayload({
        ...(proof as { payload: Record<string, unknown> }).payload,
        planId: 'invalid' + String.fromCharCode(0),
      })
    ).toThrow('standalone-permission-proof-invalid')
    const input = {
      context: { ...context, admitted: true },
      requestId: 'request-1',
      records: [record],
      expected: [],
      moduleGeneration: review.moduleGeneration,
      artifact: review.artifact,
      proof,
    }
    expect(authority.authorize({ ...input, requestId: 'request-2' })).toBe(false)
    expect(authority.authorize({ ...input, moduleGeneration: 'other' })).toBe(false)
    expect(authority.authorize({ ...input, artifact: { ...review.artifact, version: 'other' } })).toBe(false)
    expect(authority.authorize({ ...input, expected: [{ ...record, policy: 'deny-persistent' }] })).toBe(false)
    expect(authority.authorize(input)).toBe(true)
    expect(authority.authorize(input)).toBe(false)
    await expect(signer.sign('request-1', [record])).rejects.toThrow('decision-unavailable')
    expect(signer.noteConfirmed(review, plan, decision())).toBe(true)
    clock += 60_001
    await expect(signer.sign('request-3', [record])).rejects.toThrow('decision-unavailable')
    controller.abort()
    expect(authority.authorize(input)).toBe(false)
  } finally {
    signer.close()
    authority.close()
  }
})

it('does not sign an unconfirmed or mismatched decision', async () => {
  const signer = await createStandalonePermissionSigner(scope, { crypto: webcrypto as unknown as Crypto })
  try {
    expect(signer.noteConfirmed({ ...review, moduleGeneration: 'other' }, plan, decision())).toBe(false)
    expect(signer.noteConfirmed(review, plan, { ...decision(), origin: 'certified-implicit' } as never)).toBe(false)
    await expect(signer.sign('request-1', [record])).rejects.toThrow('decision-unavailable')
  } finally {
    signer.close()
  }
})

it('confirms a one-time decision against the current owner snapshot and rejects replay', async () => {
  const signer = await createStandalonePermissionSigner(scope, { crypto: webcrypto as unknown as Crypto })
  const controller = new AbortController()
  const context = {
    profileId: scope.profileId,
    rendererId: scope.rendererId,
    ownerGeneration: scope.generation,
    signal: controller.signal,
  }
  const authority = new ManagerPermissionProofAuthority({
    profileId: scope.profileId,
    generation: scope.generation,
    isCurrent: () => true,
  })
  try {
    authority.register(context, signer.publicKey)
    const view = new PermissionAuthorizationViewModel(plan)
    view.select('ui.extension-points.render', 'allow-once')
    const selected = view.confirm()
    if (selected.status !== 'confirmed' || selected.decision.schemaVersion !== 3) throw new Error('fixture failed')
    const signed = await signer.signOnce('once-1', review, plan, selected.decision)
    const input = {
      context: { ...context, admitted: true },
      requestId: 'once-1',
      record: signed.record,
      decision: signed.decision,
      expected: [],
      moduleGeneration: review.moduleGeneration,
      artifact: review.artifact,
      proof: signed.proof,
    }
    expect(authority.authorizeOnce({ ...input, decision: 'deny-once' })).toBe(false)
    expect(authority.authorizeOnce({ ...input, expected: [record] })).toBe(false)
    expect(authority.authorizeOnce(input)).toBe(true)
    expect(authority.authorizeOnce(input)).toBe(false)
  } finally {
    signer.close()
    authority.close()
  }
})

it('binds a Web install review to its document, exact decision and single-use owner token', async () => {
  const token = 'renderer-review-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
  const install = buildDeferredPermissionPlan({
    planId: 'install-example',
    operation: 'install',
    profileId: scope.profileId,
    identity: { pluginId: 'example', source: `https://renderer.cordisx.invalid/plugin/${'d'.repeat(64)}` },
    binding: { operationId: 'install-example', runtimeGeneration: scope.generation, requestId: token },
    declarations: [{ name: 'models.read', required: true, scope: {} }],
    policiesV2: [],
    policiesV4: [],
  })
  const item = install.declarations[0]!
  const choice: DeferredPermissionDecision = {
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-decision.v7.schema.json',
    schemaVersion: 7,
    origin: 'explicit-user',
    planId: install.planId,
    operation: install.operation,
    profileId: install.profileId,
    identity: install.identity,
    binding: install.binding,
    decisions: [{
      capability: item.capability,
      scope: item.scope,
      securityFingerprint: item.securityFingerprint,
      decision: 'allow-once',
    }],
  }
  const signer = await createStandalonePermissionSigner(scope, { crypto: webcrypto as unknown as Crypto })
  const controller = new AbortController()
  const context = {
    profileId: scope.profileId,
    rendererId: scope.rendererId,
    ownerGeneration: scope.generation,
    signal: controller.signal,
  }
  const authority = new ManagerPermissionProofAuthority({
    profileId: scope.profileId,
    generation: scope.generation,
    isCurrent: () => true,
  })
  try {
    authority.register(context, signer.publicKey)
    const proof = await signer.signLifecycle('install-1', token, install, choice)
    const request = {
      context: { ...context, admitted: true },
      requestId: 'install-1',
      reviewToken: token,
      decision: choice,
      proof,
    }
    expect(
      authority.authorizeLifecycle({ ...request, reviewToken: 'renderer-review-bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb' }),
    ).toBe(false)
    expect(authority.authorizeLifecycle({ ...request, decision: { ...choice, planId: 'other' } })).toBe(false)
    expect(authority.authorizeLifecycle(request)).toBe(true)
    expect(authority.authorizeLifecycle(request)).toBe(false)
    await expect(signer.signLifecycle('install-2', token, install, {
      ...choice,
      decisions: [{ ...choice.decisions[0]!, decision: 'allow-persistent' }],
    })).rejects.toThrow('lifecycle-review-decision-unavailable')
  } finally {
    signer.close()
    authority.close()
  }
})

it('binds an installed plugin decision to its renderer alias and exact artifact', async () => {
  const plugin = { id: 'fixture-service', source: `https://renderer.cordisx.invalid/plugin/${'d'.repeat(64)}` }
  const installed = { ...review, identity: plugin, moduleGeneration: 'installed-1' }
  const installedPlan = buildDomPermissionAuthorizationPlanV3({
    planId: 'installed-review',
    profileId: scope.profileId,
    identity: { source: plugin.source, pluginId: plugin.id },
    binding: { operationId: 'installed-review', runtimeGeneration: scope.generation, moduleGeneration: 'installed-1' },
    declaration: { name: 'ui.extension-points.render', required: false, scope: { extensionPoints: [review.pointId] } },
    policies: [],
  })
  const view = new PermissionAuthorizationViewModel(installedPlan)
  view.select('ui.extension-points.render', 'allow-persistent')
  const result = view.confirm()
  if (result.status !== 'confirmed' || result.decision.schemaVersion !== 3) throw new Error('fixture decision failed')
  const declaration = installedPlan.declarations[0]!
  const installedRecord = normalizePermissionPolicyRecordV3({
    $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V3,
    schemaVersion: 3,
    key: {
      profileId: scope.profileId,
      identity: installedPlan.identity,
      capability: declaration.capability,
      scope: declaration.scope,
      securityFingerprint: declaration.securityFingerprint,
    },
    policy: 'allow-persistent',
  })
  const signer = await createStandalonePermissionSigner(scope, { crypto: webcrypto as unknown as Crypto })
  const controller = new AbortController()
  const context = {
    profileId: scope.profileId,
    rendererId: scope.rendererId,
    ownerGeneration: scope.generation,
    signal: controller.signal,
  }
  const authority = new ManagerPermissionProofAuthority({
    profileId: scope.profileId,
    generation: scope.generation,
    isCurrent: () => true,
  })
  try {
    authority.register(context, signer.publicKey)
    expect(
      signer.noteConfirmed(
        { ...installed, identity: { ...plugin, source: 'https://example.test/wrong' } },
        installedPlan,
        result.decision,
      ),
    ).toBe(false)
    expect(signer.noteConfirmed(installed, installedPlan, result.decision)).toBe(true)
    const proof = await signer.sign('installed-request', [installedRecord])
    const input = {
      context: { ...context, admitted: true },
      requestId: 'installed-request',
      records: [installedRecord],
      expected: [],
      moduleGeneration: installed.moduleGeneration,
      artifact: installed.artifact,
      proof,
    }
    expect(authority.authorize({ ...input, artifact: { ...installed.artifact, version: 'other' } })).toBe(false)
    expect(authority.authorize(input)).toBe(true)
    expect(authority.authorize(input)).toBe(false)
  } finally {
    signer.close()
    authority.close()
  }
})

it('binds a reset to the exact previously persisted policy and consumes the decision once', async () => {
  const signer = await createStandalonePermissionSigner(scope, { crypto: webcrypto as unknown as Crypto })
  const controller = new AbortController()
  const context = {
    profileId: scope.profileId,
    rendererId: scope.rendererId,
    ownerGeneration: scope.generation,
    signal: controller.signal,
  }
  const authority = new ManagerPermissionProofAuthority({
    profileId: scope.profileId,
    generation: scope.generation,
    isCurrent: () => true,
  })
  const reset = normalizePermissionPolicyRecordV3({ ...record, policy: 'ask' })
  try {
    authority.register(context, signer.publicKey)
    const cancel = signer.noteReset(review, 'allow-persistent')
    expect(cancel).toBeTypeOf('function')
    const proof = await signer.sign('reset-request', [reset])
    cancel?.()
    const payload = (proof as { payload: Record<string, unknown> }).payload
    expect(payload.observed).toBe('allow-persistent')
    expect(() => normalizeStandalonePermissionProofPayload({ ...payload, observed: 'ask' }))
      .toThrow('standalone-permission-proof-invalid')
    const input = {
      context: { ...context, admitted: true },
      requestId: 'reset-request',
      records: [reset],
      expected: [record],
      moduleGeneration: review.moduleGeneration,
      artifact: review.artifact,
      proof,
    }
    expect(authority.authorize({ ...input, expected: [] })).toBe(false)
    expect(authority.authorize({ ...input, expected: [{ ...record, policy: 'deny-persistent' }] })).toBe(false)
    expect(authority.authorize(input)).toBe(true)
    expect(authority.authorize(input)).toBe(false)
    await expect(signer.sign('reset-request', [reset])).rejects.toThrow('decision-unavailable')

    const denied = normalizePermissionPolicyRecordV3({ ...record, policy: 'deny-persistent' })
    const cancelDenied = signer.noteReset(review, 'deny-persistent')
    expect(cancelDenied).toBeTypeOf('function')
    const deniedProof = await signer.sign('reset-denied', [reset])
    cancelDenied?.()
    expect(authority.authorize({
      ...input,
      requestId: 'reset-denied',
      expected: [denied],
      proof: deniedProof,
    })).toBe(true)

    const cancelled = signer.noteReset(review, 'allow-persistent')
    expect(cancelled).toBeTypeOf('function')
    cancelled?.()
    await expect(signer.sign('cancelled-reset', [reset])).rejects.toThrow('decision-unavailable')
  } finally {
    signer.close()
    authority.close()
  }
})
