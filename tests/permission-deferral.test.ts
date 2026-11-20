import { describe, expect, it } from 'vitest'
import { CORDISX_PERMISSION_POLICY_SCHEMA_V2 } from '../packages/cli/src/permission-contracts.js'
import {
  assertDeferredPermissionDecision,
  buildDeferredPermissionPlan,
  deferValidatedV2PermissionPlan,
  noDeferredPermissionDecision,
} from '../packages/cli/src/permission-deferral.js'
import { bundleDeferredDecision } from '../packages/cli/src/launcher/plugin-bundle-deferred.js'
import {
  buildPermissionAuthorizationPlanV2,
  type PermissionAuthorizationPlanInputV4,
} from '../packages/cli/src/capability-risk-catalog.js'

const base: PermissionAuthorizationPlanInputV4 = {
  planId: 'install-1',
  operation: 'install',
  profileId: 'personal',
  identity: { source: 'file:///plugin', pluginId: 'example' },
  binding: { operationId: 'install-1', runtimeGeneration: 'runtime-1', moduleGeneration: 'module-1' },
  declarations: [{ name: 'models.read', required: false, scope: {} }],
  policiesV2: [],
  policiesV4: [],
}

describe('deferred optional permission plan candidate', () => {
  it('honors exact v2 denials but does not carry them across a different source or expanded scope', () => {
    const item = { name: 'models.read' as const, required: false, scope: { providers: ['codex'] } }
    const contextFor = () => ({
      operation: 'install' as const,
      providerKind: 'current-connection' as const,
      providerTrust: 'configured' as const,
      availability: 'supported' as const,
    })
    const input = {
      planId: base.planId,
      operation: 'install' as const,
      profileId: base.profileId,
      identity: base.identity,
      binding: base.binding,
      declarations: [item],
      policies: [],
      contextFor,
    }
    const baseline = buildPermissionAuthorizationPlanV2(input)
    const deny = {
      $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V2,
      schemaVersion: 2 as const,
      key: {
        profileId: base.profileId,
        identity: base.identity,
        capability: item.name,
        scope: item.scope,
        securityFingerprint: baseline.declarations[0]!.securityFingerprint,
      },
      policy: 'deny-persistent' as const,
    }
    expect(
      deferValidatedV2PermissionPlan(buildPermissionAuthorizationPlanV2({ ...input, policies: [deny] }))
        .declarations[0],
    ).toMatchObject({ policy: 'deny-persistent', authorizationMode: 'persistent-policy' })
    expect(
      deferValidatedV2PermissionPlan(buildPermissionAuthorizationPlanV2({
        ...input,
        identity: { ...input.identity, source: 'file:///another' },
        policies: [deny],
      })).declarations[0],
    ).toMatchObject({ policy: 'ask', authorizationMode: 'deferred' })
    expect(
      deferValidatedV2PermissionPlan(buildPermissionAuthorizationPlanV2({
        ...input,
        declarations: [{ ...item, scope: { providers: ['codex', 'other'] } }],
        policies: [deny],
      })).declarations[0],
    ).toMatchObject({ policy: 'ask', authorizationMode: 'deferred' })
  })
  it.each(['install', 'update', 'enable'] as const)(
    'defers optional ask in %s without creating a decision or grant',
    operation => {
      const plan = buildDeferredPermissionPlan({ ...base, operation })
      expect(plan.declarations).toMatchObject([{
        required: false,
        authorizationMode: 'deferred',
        decisionRequired: false,
      }])
      expect(noDeferredPermissionDecision(plan)).toMatchObject({ origin: 'host-no-decision', decisions: [] })
      expect(base.policiesV2).toEqual([])
    },
  )

  it('retains runtime prompting, validates optional scope, and preserves stored denial', () => {
    const runtime = buildDeferredPermissionPlan({ ...base, operation: 'runtime' })
    expect(runtime.declarations[0]).toMatchObject({ authorizationMode: 'explicit-user', decisionRequired: true })
    const fingerprint = runtime.declarations[0]!.securityFingerprint
    const policy = {
      $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V2,
      schemaVersion: 2 as const,
      key: {
        profileId: base.profileId,
        identity: base.identity,
        capability: 'models.read' as const,
        scope: {},
        securityFingerprint: fingerprint,
      },
      policy: 'deny-persistent' as const,
    }
    const stored = buildDeferredPermissionPlan({ ...base, policiesV2: [policy] })
    expect(stored.declarations[0]).toMatchObject({ authorizationMode: 'persistent-policy', policy: 'deny-persistent' })
    expect(noDeferredPermissionDecision(stored).decisions).toEqual([])
    expect(() => bundleDeferredDecision(stored, () => 'allow')).toThrow(/conflicts with an existing plugin policy/)
    const allowed = buildDeferredPermissionPlan({ ...base, policiesV2: [{ ...policy, policy: 'allow-persistent' }] })
    expect(allowed.declarations[0]).toMatchObject({
      authorizationMode: 'persistent-policy',
      policy: 'allow-persistent',
    })
    expect(() => bundleDeferredDecision(allowed, () => 'deny')).toThrow(/conflicts with an existing plugin policy/)
    const otherSource = buildDeferredPermissionPlan({
      ...base,
      identity: { ...base.identity, source: 'file:///other' },
      policiesV2: [policy],
    })
    expect(otherSource.declarations[0]).toMatchObject({ authorizationMode: 'deferred', policy: 'ask' })
    const requiredDeny = buildDeferredPermissionPlan({
      ...base,
      declarations: [{ name: 'models.read', required: true, scope: {} }],
      policiesV2: [policy],
    })
    expect(() => noDeferredPermissionDecision(requiredDeny)).toThrow()
    expect(() =>
      buildDeferredPermissionPlan({
        ...base,
        declarations: [{ name: 'models.read', required: false, scope: { rootIds: ['bad'] } }],
      })
    ).toThrow()
  })

  it('keeps the Channel 0.1.7 simulator scopes intact while deferring its four optional declarations', () => {
    const tenant = { adapterId: 'simulator', accountId: 'local', tenantId: 'test' }
    const conversation = { ...tenant, conversationId: 'direct-alice', kind: 'direct' as const }
    const declarations: PermissionAuthorizationPlanInputV4['declarations'] = [
      { name: 'channel.events.receive', required: false, scope: { channelTenants: [tenant] } },
      { name: 'channel.events.subscribe', required: false, scope: { channelTenants: [tenant] } },
      { name: 'channel.messages.send', required: false, scope: { channelConversations: [conversation] } },
      { name: 'channel.attachments.read', required: false, scope: { channelConversations: [conversation] } },
    ]
    const plan = buildDeferredPermissionPlan({ ...base, declarations })
    expect(plan.declarations.map(item => item.scope)).toEqual(declarations.map(item => item.scope))
    expect(plan.declarations.every(item => item.authorizationMode === 'deferred')).toBe(true)
    expect(noDeferredPermissionDecision(plan).decisions).toEqual([])
    expect(
      buildDeferredPermissionPlan({ ...base, declarations, operation: 'runtime' }).declarations.every(item =>
        item.authorizationMode === 'explicit-user' && item.decisionRequired
      ),
    ).toBe(true)
  })

  it('requires the exact user choice for a required capability and rejects forged optional choices', () => {
    const plan = buildDeferredPermissionPlan({
      ...base,
      declarations: [...base.declarations, { name: 'tasks.catalog.read', required: true, scope: {} }],
    })
    expect(() => noDeferredPermissionDecision(plan)).toThrow()
    const required = plan.declarations.find(item => item.required)!
    const decision = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-decision.v7.schema.json' as const,
      schemaVersion: 7 as const,
      origin: 'explicit-user' as const,
      planId: plan.planId,
      operation: plan.operation,
      profileId: plan.profileId,
      identity: plan.identity,
      binding: plan.binding,
      decisions: [{
        capability: required.capability,
        scope: required.scope,
        securityFingerprint: required.securityFingerprint,
        decision: 'allow-once' as const,
      }],
    }
    expect(() => assertDeferredPermissionDecision(plan, decision)).not.toThrow()
    expect(() =>
      assertDeferredPermissionDecision(plan, {
        ...decision,
        decisions: [{ ...decision.decisions[0]!, decision: 'deny-once' }],
      })
    ).toThrow()
    const optional = plan.declarations[0]!
    expect(() =>
      assertDeferredPermissionDecision(plan, {
        ...decision,
        decisions: [{
          capability: optional.capability,
          scope: optional.scope,
          securityFingerprint: optional.securityFingerprint,
          decision: 'allow-persistent',
        }],
      })
    ).toThrow()
    expect(() =>
      assertDeferredPermissionDecision(plan, { ...decision, identity: { ...plan.identity, source: 'file:///other' } })
    ).toThrow()
  })
})
