import { randomUUID } from 'node:crypto'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4,
  type CordisXPermissionAuthorizationDecisionV2,
  type CordisXPermissionAuthorizationDecisionV4,
} from '../permission-contracts.js'
import type { PluginLifecycleCoordinator } from './plugin-lifecycle.js'
import { LifecycleFailure } from './plugin-lifecycle-model.js'
import { PermissionReviewBusyError } from './permission-review-gate.js'

/** Host-private envelope; the reviewer must explicitly submit every required decision. */
export interface PermissionReviewOperation {
  readonly kind: 'permission-review-apply'
  readonly expectedRevision: number
  readonly userConfirmed: true
  readonly decision: CordisXPermissionAuthorizationDecisionV2 | CordisXPermissionAuthorizationDecisionV4
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid permission review')
  return value as Record<string, unknown>
}

export function parsePermissionReviewOperation(value: unknown, profileId: string): PermissionReviewOperation {
  const operation = record(value)
  if (
    Object.keys(operation).some(key => !['kind', 'expectedRevision', 'userConfirmed', 'decision'].includes(key))
    || operation.kind !== 'permission-review-apply' || operation.userConfirmed !== true
    || !Number.isSafeInteger(operation.expectedRevision) || (operation.expectedRevision as number) < 0
  ) {
    throw new Error('invalid permission review')
  }
  const decision = record(operation.decision)
  const allowed = ['$schema', 'schemaVersion', 'planId', 'operation', 'profileId', 'identity', 'binding', 'decisions']
  if (decision.schemaVersion === 4) allowed.push('origin')
  if (
    Object.keys(decision).some(key => !allowed.includes(key))
    || decision.profileId !== profileId
    || !['install', 'update', 'enable'].includes(String(decision.operation))
    || typeof decision.planId !== 'string' || decision.planId.length === 0 || decision.planId.length > 128
    || !Array.isArray(decision.decisions) || decision.decisions.length > 128
    || (decision.schemaVersion === 2 && decision.$schema !== CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2)
    || (decision.schemaVersion === 4 && (decision.$schema !== CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4
      || decision.origin !== 'explicit-user'))
    || (decision.schemaVersion !== 2 && decision.schemaVersion !== 4)
  ) {
    throw new Error('invalid permission review')
  }
  record(decision.identity)
  record(decision.binding)
  for (const item of decision.decisions) record(item)
  return operation as unknown as PermissionReviewOperation
}

/** The existing authority revalidates the exact plan, scopes, required choices and persisted revision. */
export async function applyManagementPermissionReview(input: {
  readonly coordinator: PluginLifecycleCoordinator
  readonly profileId: string
  readonly generation: string
  readonly operation: PermissionReviewOperation
}) {
  const { decision, expectedRevision } = input.operation
  if (decision.profileId !== input.profileId || decision.binding.runtimeGeneration !== input.generation) {
    return { status: 'rejected' as const, reason: 'stale-generation' }
  }
  const current = await input.coordinator.store.loadActive()
  if (current.revision !== expectedRevision) return { status: 'rejected' as const, reason: 'stale-revision' }
  const request = {
    requestId: `management-review-${randomUUID()}`,
    profileId: input.profileId,
    runtimeGeneration: input.generation,
    expectedRevision,
  }
  try {
    const result = decision.schemaVersion === 4
      ? await input.coordinator.applyPermissionReviewV4({ ...request, decision })
      : await input.coordinator.applyPermissionReviewV2({ ...request, decision })
    return { status: 'ok' as const, result }
  } catch (error) {
    if (error instanceof PermissionReviewBusyError) return { status: 'rejected' as const, reason: 'review-busy' }
    // These explicit lifecycle rejections are raised before activation, or after aborting it.
    if (
      error instanceof LifecycleFailure && (error.code === 'permission-denied'
        || error.code === 'stale-revision' || error.code === 'stale-generation')
      && (error.outcome === 'rejected' || error.outcome === 'conflict')
    ) {
      return { status: 'rejected' as const, reason: error.code }
    }
    // The underlying transaction may have reached persistence before a transport or cleanup error.
    return { status: 'unknown' as const, reason: 'review-not-confirmed' }
  }
}
