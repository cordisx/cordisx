import {
  assertBundlePolicyDecision,
  type DeferredPermissionDecision,
  type DeferredPermissionPlan,
  withBundlePolicyIntent,
} from '../permission-deferral.js'
import type { CordisXPluginBundlePolicy } from '../plugin-bundle-contracts.js'

/** Bind only explicit, exact bundle choices; an unresolved optional policy stays deferred. */
export function bundleDeferredDecision(
  plan: DeferredPermissionPlan,
  policyFor: (capability: string, scope: unknown) => CordisXPluginBundlePolicy,
): { readonly decision: DeferredPermissionDecision; readonly selections: Readonly<Record<string, 'allow' | 'deny'>> } {
  const selections: Record<string, 'allow' | 'deny'> = Object.create(null)
  for (const item of plan.declarations) {
    const policy = policyFor(item.capability, item.scope)
    if (policy === 'allow' || policy === 'deny') selections[item.capability] = policy
  }
  const reviewed = withBundlePolicyIntent(plan, new Set(Object.keys(selections)))
  const decisions = reviewed.declarations.filter(item => item.decisionRequired).map(item => {
    const choice = selections[item.capability]
    if (choice === undefined) throw new Error('bundle required permission has no explicit choice')
    const preferred = choice === 'allow'
      ? ['allow-persistent', 'allow-once'] as const
      : ['deny-persistent', 'deny-once'] as const
    const decision = preferred.find(candidate => item.allowedDecisions.includes(candidate))
    if (decision === undefined) throw new Error('bundle permission choice is unavailable')
    return { capability: item.capability, scope: item.scope, securityFingerprint: item.securityFingerprint, decision }
  })
  const decision: DeferredPermissionDecision = {
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-decision.v7.schema.json',
    schemaVersion: 7,
    origin: decisions.length === 0 ? 'host-no-decision' : 'bundle-policy',
    planId: plan.planId,
    operation: plan.operation,
    profileId: plan.profileId,
    identity: plan.identity,
    binding: plan.binding,
    decisions,
  }
  assertBundlePolicyDecision(reviewed, decision, selections)
  return { decision, selections: Object.freeze(selections) }
}
