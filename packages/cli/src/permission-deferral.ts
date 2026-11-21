import {
  buildPermissionAuthorizationPlanV2,
  buildPermissionAuthorizationPlanV4,
  CapabilityRiskCatalog,
  type PermissionAuthorizationPlanInputV4,
} from './capability-risk-catalog.js'
import type {
  CordisXPermissionAuthorizationBindingV2,
  CordisXPermissionAuthorizationDecisionItemV4,
  CordisXPermissionAuthorizationItemV4,
  CordisXPermissionAuthorizationPlanV2,
  CordisXPermissionAuthorizationPlanV4,
} from './permission-contracts.js'
import type { CordisXPermissionAuthorizationPlanV1 } from './platform-contracts.js'
import type { CordisXLocalizedText } from './contracts-extension-navigation.js'

const PLAN_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-plan.v7.schema.json'
const DECISION_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-decision.v7.schema.json'

export type DeferredPermissionItem = Omit<CordisXPermissionAuthorizationItemV4, 'authorizationMode'> & {
  readonly authorizationMode: CordisXPermissionAuthorizationItemV4['authorizationMode'] | 'deferred'
  readonly legacyReason?: CordisXLocalizedText
  readonly reviewIntent?: 'bundle-policy'
}

/** Retain exact v1 policy semantics while using a generation-bound v7 review envelope. */
export function deferValidatedV1PermissionPlan(
  plan: CordisXPermissionAuthorizationPlanV1,
  binding: CordisXPermissionAuthorizationBindingV2,
): DeferredPermissionPlan {
  const catalog = new CapabilityRiskCatalog()
  const modern = buildPermissionAuthorizationPlanV2({
    planId: plan.planId,
    operation: plan.operation,
    profileId: plan.profileId,
    identity: plan.identity,
    binding,
    declarations: plan.declarations.map(item => ({
      name: item.capability,
      required: item.required,
      scope: item.scope,
    })),
    policies: [],
    contextFor: declaration => ({
      operation: plan.operation,
      providerKind: catalog.get(declaration.name).providerFamily === 'platform' ? 'current-connection' : 'host-local',
      providerTrust: 'configured',
      availability: 'supported',
    }),
  }, catalog)
  const projected = deferValidatedV2PermissionPlan(modern)
  return Object.freeze({
    ...projected,
    declarations: Object.freeze(projected.declarations.map(item => {
      const legacy = plan.declarations.find(candidate => candidate.capability === item.capability)!
      const policy = legacy.policy === 'allow'
        ? 'allow-persistent' as const
        : legacy.policy === 'deny'
        ? 'deny-persistent' as const
        : 'ask' as const
      const deferred = !item.required && policy === 'ask'
      return Object.freeze({
        ...item,
        policy,
        decisionRequired: policy === 'ask' && !deferred,
        authorizationMode: deferred
          ? 'deferred' as const
          : policy === 'ask'
          ? 'explicit-user' as const
          : 'persistent-policy' as const,
        legacyReason: legacy.reason,
      })
    })),
  })
}

/** Preserve the v2 Broker's reconciled policy and security fingerprint when upgrading the review envelope. */
export function deferValidatedV2PermissionPlan(plan: CordisXPermissionAuthorizationPlanV2): DeferredPermissionPlan {
  const catalog = new CapabilityRiskCatalog()
  const declarations: DeferredPermissionItem[] = plan.declarations.map(item => {
    const metadata = catalog.get(item.capability)
    const mode = item.policy === 'ask' ? 'explicit-user' as const : 'persistent-policy' as const
    const deferred = plan.operation !== 'runtime' && !item.required && item.policy === 'ask'
    return Object.freeze({
      ...item,
      authorizationMode: deferred ? 'deferred' as const : mode,
      decisionRequired: deferred ? false : item.decisionRequired,
      resourceClass: metadata.resourceClass,
      certifiedImplicitApproval: metadata.certifiedImplicitApproval,
    })
  })
  return Object.freeze({ ...plan, $schema: PLAN_SCHEMA, schemaVersion: 7, declarations: Object.freeze(declarations) })
}

export interface DeferredPermissionPlan
  extends Omit<CordisXPermissionAuthorizationPlanV4, '$schema' | 'schemaVersion' | 'declarations'>
{
  readonly $schema: typeof PLAN_SCHEMA
  readonly schemaVersion: 7
  readonly declarations: readonly DeferredPermissionItem[]
}

export interface DeferredPermissionDecision
  extends Pick<DeferredPermissionPlan, 'planId' | 'operation' | 'profileId' | 'identity' | 'binding'>
{
  readonly $schema: typeof DECISION_SCHEMA
  readonly schemaVersion: 7
  readonly origin: 'explicit-user' | 'host-no-decision' | 'bundle-policy'
  readonly decisions: readonly CordisXPermissionAuthorizationDecisionItemV4[]
}

/** Build from the complete validated v4 projection; runtime plans remain unchanged. */
export function buildDeferredPermissionPlan(input: PermissionAuthorizationPlanInputV4): DeferredPermissionPlan {
  return deferValidatedPermissionPlan(buildPermissionAuthorizationPlanV4(input))
}

/** The caller must use a freshly built, complete and Host-validated plan. */
export function deferValidatedPermissionPlan(plan: CordisXPermissionAuthorizationPlanV4): DeferredPermissionPlan {
  const declarations = plan.declarations.map((item): DeferredPermissionItem => {
    if (plan.operation === 'runtime' || item.required || item.policy !== 'ask') return item
    const { certification: _certification, ...withoutCertification } = item
    return Object.freeze({ ...withoutCertification, authorizationMode: 'deferred', decisionRequired: false })
  })
  return Object.freeze({ ...plan, $schema: PLAN_SCHEMA, schemaVersion: 7, declarations: Object.freeze(declarations) })
}

/** Host bundle authority alone may supply choices derived from an exact reviewed bundle policy. */
export function withBundlePolicyIntent(
  plan: DeferredPermissionPlan,
  capabilities: ReadonlySet<string>,
): DeferredPermissionPlan {
  if (plan.operation === 'runtime') throw new Error('bundle policy review cannot authorize a runtime plan')
  const available = new Set<string>(plan.declarations.map(item => item.capability))
  if ([...capabilities].some(capability => !available.has(capability))) {
    throw new Error('bundle policy intent includes an undeclared capability')
  }
  return Object.freeze({
    ...plan,
    declarations: Object.freeze(
      plan.declarations.map(item =>
        capabilities.has(item.capability) && item.authorizationMode === 'deferred'
          ? Object.freeze({
            ...item,
            authorizationMode: 'explicit-user' as const,
            decisionRequired: true,
            reviewIntent: 'bundle-policy' as const,
          })
          : item
      ),
    ),
  })
}

/** A bundle decision must match its exact reviewed or persisted effective choices. */
export function assertBundlePolicyDecision(
  plan: DeferredPermissionPlan,
  decision: DeferredPermissionDecision,
  selections: Readonly<Record<string, 'allow' | 'deny'>>,
): void {
  if (decision.origin !== 'bundle-policy' && decision.origin !== 'host-no-decision') {
    throw new Error('bundle permission decision has an invalid origin')
  }
  assertDeferredPermissionDecision(plan, decision, true)
  if (
    plan.declarations.some(item =>
      (selections[item.capability] === 'deny' && item.policy === 'allow-persistent')
      || (selections[item.capability] === 'allow' && item.policy === 'deny-persistent')
    )
  ) {
    throw new Error('bundle choice conflicts with an existing plugin policy and requires policy reconciliation')
  }
  for (const item of decision.decisions) {
    const policy = selections[item.capability]
    if (policy === undefined || !item.decision.startsWith(policy)) {
      throw new Error('bundle permission decision differs from the reviewed bundle policy')
    }
  }
}

/** Apply only choices actually made against this exact plan; denial of required authority blocks activation. */
export function assertDeferredPermissionDecision(
  plan: DeferredPermissionPlan,
  decision: DeferredPermissionDecision,
  trustedBundlePolicy = false,
): void {
  if (
    decision === null || typeof decision !== 'object' || decision.$schema !== DECISION_SCHEMA
    || Object.keys(decision).some(key =>
      !['$schema', 'schemaVersion', 'origin', 'planId', 'operation', 'profileId', 'identity', 'binding', 'decisions']
        .includes(key)
    )
    || decision.schemaVersion !== 7 || decision.planId !== plan.planId || decision.operation !== plan.operation
    || decision.profileId !== plan.profileId || JSON.stringify(decision.identity) !== JSON.stringify(plan.identity)
    || JSON.stringify(decision.binding) !== JSON.stringify(plan.binding) || !Array.isArray(decision.decisions)
    || (decision.origin !== 'explicit-user' && decision.origin !== 'host-no-decision'
      && decision.origin !== 'bundle-policy')
    || (decision.origin === 'host-no-decision' && decision.decisions.length !== 0)
    || (decision.origin !== 'host-no-decision' && decision.decisions.length === 0)
    || (decision.origin === 'bundle-policy' && !trustedBundlePolicy)
    || (plan.declarations.some(item => item.reviewIntent === 'bundle-policy') && !trustedBundlePolicy)
  ) throw new Error('permission v7 decision does not match the exact plan')
  const expected = new Map(plan.declarations.filter(item => item.decisionRequired).map(item => [item.capability, item]))
  const seen = new Set<string>()
  for (const selected of decision.decisions) {
    if (
      selected === null || typeof selected !== 'object'
      || Object.keys(selected).some(key => !['capability', 'scope', 'securityFingerprint', 'decision'].includes(key))
    ) throw new Error('permission v7 decision contains an invalid entry')
    const item = expected.get(selected.capability)
    if (
      item === undefined || seen.has(selected.capability)
      || JSON.stringify(selected.scope) !== JSON.stringify(item.scope)
      || selected.securityFingerprint !== item.securityFingerprint || !item.allowedDecisions.includes(selected.decision)
      || (item.required && selected.decision.startsWith('deny'))
    ) throw new Error('permission v7 decision exceeds or denies the exact plan')
    seen.add(selected.capability)
  }
  if (
    seen.size !== expected.size
    || plan.declarations.some(item =>
      item.required && item.authorizationMode === 'persistent-policy' && item.policy === 'deny-persistent'
    )
  ) throw new Error('permission v7 decision is incomplete or denies required authority')
}

export function noDeferredPermissionDecision(plan: DeferredPermissionPlan): DeferredPermissionDecision {
  const decision: DeferredPermissionDecision = {
    $schema: DECISION_SCHEMA,
    schemaVersion: 7,
    origin: 'host-no-decision',
    planId: plan.planId,
    operation: plan.operation,
    profileId: plan.profileId,
    identity: plan.identity,
    binding: plan.binding,
    decisions: [],
  }
  assertDeferredPermissionDecision(plan, decision)
  return Object.freeze(decision)
}
