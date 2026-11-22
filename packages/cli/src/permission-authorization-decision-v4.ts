import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4,
  type CordisXPermissionAuthorizationDecisionV4,
  type CordisXPermissionAuthorizationPlanV4,
} from './permission-contracts.js'

/** Validates an explicit-user decision against exactly the items that still require review. */
export function assertPermissionAuthorizationDecisionV4(
  plan: CordisXPermissionAuthorizationPlanV4,
  decision: CordisXPermissionAuthorizationDecisionV4,
): void {
  if (
    decision === null || typeof decision !== 'object'
    || decision.$schema !== CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4
    || decision.schemaVersion !== 4
    || decision.origin !== 'explicit-user'
    || decision.planId !== plan.planId
    || decision.operation !== plan.operation
    || decision.profileId !== plan.profileId
    || JSON.stringify(decision.identity) !== JSON.stringify(plan.identity)
    || JSON.stringify(decision.binding) !== JSON.stringify(plan.binding)
    || !Array.isArray(decision.decisions)
  ) {
    throw new Error('permission v4 decision does not match the exact plan')
  }
  const expected = new Map(
    plan.declarations
      .filter(item => item.decisionRequired)
      .map(item => [item.capability, item]),
  )
  const seen = new Set<string>()
  for (const selected of decision.decisions) {
    const item = expected.get(selected.capability)
    if (
      item === undefined || seen.has(selected.capability)
      || JSON.stringify(selected.scope) !== JSON.stringify(item.scope)
      || selected.securityFingerprint !== item.securityFingerprint
      || !item.allowedDecisions.includes(selected.decision)
    ) {
      throw new Error('permission v4 decision exceeds or does not match the exact plan')
    }
    seen.add(selected.capability)
  }
  if (seen.size !== expected.size) throw new Error('permission v4 decision is incomplete')
}
