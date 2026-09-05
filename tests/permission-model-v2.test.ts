import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildPermissionAuthorizationPlanResultV2,
  buildPermissionAuthorizationPlanV2,
  CapabilityRiskCatalog,
  HOST_CAPABILITY_RISK_ENTRIES,
  partitionPermissionReviewPlan,
  PermissionDecisionEngine,
} from '../packages/cli/src/capability-risk-catalog.js'
import {
  CORDISX_PERMISSION_CAPABILITIES_V2,
  CORDISX_PERMISSION_CAPABILITIES_V4,
  CORDISX_PERMISSION_POLICY_SCHEMA_V2,
  type CordisXCapabilityDeclarationV2,
  type CordisXPermissionAuthorizationKeyV2,
  type CordisXPermissionPolicyRecordV2,
} from '../packages/cli/src/permission-contracts.js'
import {
  comparePermissionScopeV2,
  migratePermissionPolicyV1,
  normalizeCapabilityDeclarationV2,
  normalizePermissionPolicyRecordV2,
  normalizePermissionRationaleV2,
  PermissionOnceGrantLedger,
  permissionSecurityFingerprint,
  sha256Hex,
} from '../packages/cli/src/permission-model-v2.js'

const identity = { source: 'file:///plugins/demo.js', pluginId: 'demo' } as const
const binding = {
  operationId: 'install:demo:1',
  runtimeGeneration: 'runtime-1',
  moduleGeneration: 'demo-1',
  requestId: 'request-1',
} as const

function declaration(
  name: CordisXCapabilityDeclarationV2['name'],
  required: boolean,
  scope: CordisXCapabilityDeclarationV2['scope'],
): CordisXCapabilityDeclarationV2 {
  return {
    name,
    required,
    rationale: {
      title: { key: 'permission-title', fallback: 'Use task context' },
      description: { key: 'permission-description', fallback: 'The plugin reads this data for its task view.' },
      feature: { key: 'permission-feature', fallback: 'Task timeline' },
      deniedBehavior: { key: 'permission-denied', fallback: 'The timeline stays hidden.' },
    },
    security: { dataUse: 'ephemeral', retention: 'runtime', externalTransfer: false },
    scope,
  }
}

function policy(
  item: CordisXCapabilityDeclarationV2,
  value: CordisXPermissionPolicyRecordV2['policy'],
  source = identity.source,
): CordisXPermissionPolicyRecordV2 {
  return normalizePermissionPolicyRecordV2({
    $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V2,
    schemaVersion: 2,
    key: {
      profileId: 'work',
      identity: { ...identity, source },
      capability: item.name,
      scope: item.scope,
      securityFingerprint: permissionSecurityFingerprint('2026-08-24', item),
    },
    policy: value,
  })
}

describe('permission capability risk catalog', () => {
  it('is exhaustive and fails closed when any accepted capability lacks metadata', () => {
    const catalog = new CapabilityRiskCatalog()
    expect(catalog.snapshot().map(item => item.capability)).toEqual(CORDISX_PERMISSION_CAPABILITIES_V4)
    expect(catalog.snapshot().filter(item => item.resourceClass === 'non-dom')).toHaveLength(
      CORDISX_PERMISSION_CAPABILITIES_V2.length,
    )
    expect(catalog.get('ui.extension-points.render')).toMatchObject({
      resourceClass: 'dom-rendering',
      certifiedImplicitApproval: true,
    })
    expect(catalog.get('ui.host-dom.read')).toMatchObject({
      resourceClass: 'host-dom',
      sensitivity: 'sensitive',
      certifiedImplicitApproval: true,
    })
    expect(catalog.get('ui.host-dom.modify')).toMatchObject({
      resourceClass: 'host-dom',
      sensitivity: 'high-risk',
      certifiedImplicitApproval: true,
      persistentAllow: false,
    })
    expect(() => new CapabilityRiskCatalog(HOST_CAPABILITY_RISK_ENTRIES.slice(1))).toThrow(
      /metadata missing: models\.read/,
    )
    expect(() =>
      new CapabilityRiskCatalog([
        ...HOST_CAPABILITY_RISK_ENTRIES,
        { ...HOST_CAPABILITY_RISK_ENTRIES[0]!, capability: 'unknown.read' as 'models.read' },
      ])
    ).toThrow(/unsupported entry: unknown\.read/)
  })

  it('keeps required orthogonal to sensitivity and computes Host-owned defaults', () => {
    const engine = new PermissionDecisionEngine()
    const context = {
      operation: 'runtime' as const,
      providerKind: 'host-local' as const,
      providerTrust: 'native' as const,
      policy: 'ask' as const,
      availability: 'supported' as const,
    }
    expect(engine.recommend('models.read', { ...context, required: false, scope: {} }).defaultDecision)
      .toBe('allow-persistent')
    expect(
      engine.recommend('agent.events.read', {
        ...context,
        required: false,
        scope: { sessionIds: ['session-1'] },
      }).defaultDecision,
    ).toBe('allow-once')
    expect(
      engine.recommend('agent.events.read', {
        ...context,
        required: true,
        scope: { sessionIds: ['session-1'] },
      }).defaultDecision,
    ).toBe('allow-once')
    const highRisk = engine.recommend('tasks.control', {
      ...context,
      operation: 'install',
      providerKind: 'current-connection',
      providerTrust: 'unverified',
      required: true,
      scope: { sessions: [{ providerId: 'codex', remoteSessionId: 'thread-1' }] },
    })
    expect(highRisk.defaultDecision).toBe('deny-once')
    expect(highRisk.allowedDecisions).not.toContain('allow-persistent')
  })

  it('keeps runtime availability orthogonal to configurable policy', () => {
    const engine = new PermissionDecisionEngine()
    const common = {
      operation: 'runtime' as const,
      providerKind: 'host-local' as const,
      providerTrust: 'native' as const,
      policy: 'allow-persistent' as const,
      required: true,
      scope: {},
    }
    expect(engine.recommend('models.read', { ...common, availability: 'supported' }).defaultDecision)
      .toBe('allow-persistent')
    expect(engine.recommend('models.read', { ...common, availability: 'unavailable' }).defaultDecision)
      .toBe('allow-persistent')
  })
})

describe('permission declarations and fingerprints', () => {
  it('normalizes equivalent scope and matches the standard SHA-256 implementation', () => {
    expect(sha256Hex('abc')).toBe(createHash('sha256').update('abc').digest('hex'))
    const first = declaration('tasks.create', true, { providers: ['codex'], cwdRoots: ['/work/b', '/work/a'] })
    const reordered = { ...first, scope: { cwdRoots: ['/work/a', '/work/b'], providers: ['codex'] } }
    expect(permissionSecurityFingerprint('2026-08-24', first))
      .toBe(permissionSecurityFingerprint('2026-08-24', reordered))
    expect(permissionSecurityFingerprint('2026-08-24', first))
      .not.toBe(permissionSecurityFingerprint('2026-08-25', first))
    expect(permissionSecurityFingerprint('2026-08-24', first))
      .not.toBe(permissionSecurityFingerprint('2026-08-24', {
        ...first,
        rationale: { ...first.rationale!, feature: { key: 'changed', fallback: 'A changed feature' } },
      }))
  })

  it('rejects markup, links, script schemes, interpolated deception, and Host impersonation', () => {
    const rationale = declaration('models.read', false, {}).rationale!
    expect(() =>
      normalizePermissionRationaleV2({
        ...rationale,
        description: { key: 'bad', fallback: '<b>Trusted</b>' },
      })
    ).toThrow(/markup/)
    expect(() =>
      normalizePermissionRationaleV2({
        ...rationale,
        feature: { key: 'bad', fallback: 'See https:\/\/example.com' },
      })
    ).toThrow(/link\/script/)
    expect(() =>
      normalizePermissionRationaleV2({
        ...rationale,
        deniedBehavior: { key: 'bad', params: { claim: 'CordisX verified safe' } },
      })
    ).toThrow(/security claim/)
    expect(() =>
      normalizePermissionRationaleV2({
        ...rationale,
        title: { key: 'bad', fallback: '宿主已验证安全' },
      })
    ).toThrow(/security claim/)
  })

  it('rejects capability-family scope spoofing and classifies scope expansion', () => {
    expect(() =>
      normalizeCapabilityDeclarationV2({
        name: 'agent.events.read',
        required: true,
        scope: {
          sessions: [{ providerId: 'codex', remoteSessionId: 'thread-1' }],
        },
      })
    ).toThrow(/cannot use Platform sessions/)
    expect(comparePermissionScopeV2({ cwdRoots: ['/work'] }, { cwdRoots: ['/work/project'] })).toBe('narrowed')
    expect(comparePermissionScopeV2({ cwdRoots: ['/work/project'] }, { cwdRoots: ['/work'] })).toBe('expanded')
    expect(comparePermissionScopeV2({ providers: ['codex'] }, { providers: ['claude'] })).toBe('changed')
    expect(comparePermissionScopeV2({ providers: ['codex', 'claude'] }, { providers: ['claude', 'codex'] })).toBe(
      'equal',
    )
  })
})

describe('shared permission authorization planning', () => {
  it('separates batch-eligible and explicit review while preserving required/optional semantics', () => {
    const low = declaration('models.read', true, {})
    const sensitive = declaration('agent.events.read', false, { sessionIds: ['session-1'] })
    const plan = buildPermissionAuthorizationPlanV2({
      planId: 'permission-plan-1',
      operation: 'install',
      profileId: 'work',
      identity,
      binding,
      declarations: [low, sensitive],
      policies: [],
      contextFor: item => ({
        operation: 'install',
        providerKind: item.name.startsWith('agent.') ? 'host-local' : 'current-connection',
        providerTrust: 'native',
        availability: 'supported',
      }),
    })
    expect(plan.declarations.map(item => [item.capability, item.required, item.defaultDecision])).toEqual([
      ['models.read', true, 'allow-persistent'],
      ['agent.events.read', false, 'allow-once'],
    ])
    const groups = partitionPermissionReviewPlan(plan)
    expect(groups.batchEligible.map(item => item.capability)).toEqual(['models.read'])
    expect(groups.explicit.map(item => item.capability)).toEqual(['agent.events.read'])
  })

  it('binds persistent policy to profile, source, plugin, scope, and security fingerprint', () => {
    const item = declaration('models.read', true, { providers: ['codex'] })
    const input = {
      planId: 'permission-plan-1',
      operation: 'runtime' as const,
      profileId: 'work',
      identity,
      binding,
      declarations: [item],
      contextFor: () => ({
        operation: 'runtime' as const,
        providerKind: 'current-connection' as const,
        providerTrust: 'native' as const,
        availability: 'supported' as const,
      }),
    }
    expect(
      buildPermissionAuthorizationPlanV2({ ...input, policies: [policy(item, 'allow-persistent')] })
        .declarations[0]?.decisionRequired,
    ).toBe(false)
    expect(
      buildPermissionAuthorizationPlanV2({
        ...input,
        policies: [policy(item, 'allow-persistent', 'file:///plugins/other.js')],
      })
        .declarations[0],
    ).toMatchObject({ policy: 'ask', decisionRequired: true })
    expect(
      buildPermissionAuthorizationPlanV2({
        ...input,
        declarations: [{ ...item, scope: { providers: ['claude'] } }],
        policies: [policy(item, 'allow-persistent')],
      }).declarations[0],
    ).toMatchObject({ policy: 'ask', decisionRequired: true })
  })

  it('carries policy only across provable scope narrowing and returns one durable migration', () => {
    const broad = declaration('tasks.create', true, { providers: ['codex'], cwdRoots: ['/work'] })
    const narrow = { ...broad, scope: { providers: ['codex'], cwdRoots: ['/work/project'] } }
    const common = {
      planId: 'permission-plan-1',
      operation: 'update' as const,
      profileId: 'work',
      identity,
      binding,
      contextFor: () => ({
        operation: 'update' as const,
        providerKind: 'current-connection' as const,
        providerTrust: 'native' as const,
        availability: 'supported' as const,
      }),
    }
    const narrowed = buildPermissionAuthorizationPlanResultV2({
      ...common,
      declarations: [narrow],
      policies: [policy(broad, 'allow-persistent')],
    })
    expect(narrowed.plan.declarations[0]).toMatchObject({ policy: 'allow-persistent', decisionRequired: false })
    expect(narrowed.policyMigrations).toHaveLength(1)
    expect(narrowed.policyMigrations[0]).toMatchObject({
      policy: 'allow-persistent',
      key: { scope: { providers: ['codex'], cwdRoots: ['/work/project'] } },
    })

    const expanded = buildPermissionAuthorizationPlanResultV2({
      ...common,
      declarations: [broad],
      policies: [policy(narrow, 'allow-persistent')],
    })
    expect(expanded.plan.declarations[0]).toMatchObject({ policy: 'ask', decisionRequired: true })
    expect(expanded.policyMigrations).toEqual([])

    const changedRationale = buildPermissionAuthorizationPlanResultV2({
      ...common,
      declarations: [{
        ...narrow,
        rationale: { ...narrow.rationale!, feature: { key: 'changed-feature', fallback: 'Changed feature' } },
      }],
      policies: [policy(broad, 'allow-persistent')],
    })
    expect(changedRationale.plan.declarations[0]).toMatchObject({ policy: 'ask', decisionRequired: true })
  })
})

describe('permission lifetime', () => {
  const declarationKey = declaration('agent.events.read', true, { sessionIds: ['session-1'] })
  const key: CordisXPermissionAuthorizationKeyV2 = {
    profileId: 'work',
    identity,
    capability: declarationKey.name,
    scope: declarationKey.scope,
    securityFingerprint: permissionSecurityFingerprint('2026-08-24', declarationKey),
  }

  it('consumes allow-once exactly once and never crosses request or generation bindings', () => {
    const ledger = new PermissionOnceGrantLedger()
    ledger.issue(key, binding)
    expect(ledger.consume(key, { ...binding, requestId: 'request-2' })).toBe(false)
    expect(ledger.consume(key, binding)).toBe(true)
    expect(ledger.consume(key, binding)).toBe(false)
    ledger.issue(key, binding)
    ledger.clearGeneration('runtime-1', 'demo-1')
    expect(ledger.size).toBe(0)
    ledger.issue(key, binding)
    ledger.clearOperation('install:demo:1')
    expect(ledger.size).toBe(0)
    ledger.issue(key, binding)
    ledger.dispose()
    expect(ledger.size).toBe(0)
  })

  it('migrates v1 only to catalog-permitted persistent states', () => {
    expect(
      migratePermissionPolicyV1('allow', {
        key,
        persistentAllow: true,
        persistentDeny: true,
      }).policy,
    ).toBe('allow-persistent')
    expect(
      migratePermissionPolicyV1('allow', {
        key,
        persistentAllow: false,
        persistentDeny: true,
      }).policy,
    ).toBe('ask')
    expect(
      migratePermissionPolicyV1('deny', {
        key,
        persistentAllow: false,
        persistentDeny: true,
      }).policy,
    ).toBe('deny-persistent')
  })
})
