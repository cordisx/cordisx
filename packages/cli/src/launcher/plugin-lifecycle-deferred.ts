import type { CordisXPermissionPolicyRecordV1 } from '../platform-contracts.js'
import type {
  CordisXCertifiedPermissionProjectionV1,
  CordisXPermissionPolicyRecordV2,
  CordisXPermissionPolicyRecordV4,
} from '../permission-contracts.js'
import {
  type DeferredPermissionPlan,
  deferValidatedPermissionPlan,
  deferValidatedV1PermissionPlan,
  deferValidatedV2PermissionPlan,
} from '../permission-deferral.js'
import {
  authorizationPlan,
  authorizationPlanV2,
  authorizationPlanV4,
  type HostPermissionLifecycleReviewV4Request,
} from './plugin-lifecycle-model.js'
import type { PluginLifecycleCoordinator } from './plugin-lifecycle.js'
import type { StagedPluginPackage } from './plugin-package.js'

/** Project the complete, normalized lifecycle plan; callers must fence it to the candidate again on apply. */
export function lifecycleDeferredPermissionPlan(
  staged: StagedPluginPackage,
  operation: 'install' | 'update' | 'enable',
  profileId: string,
  generation: string,
  moduleGeneration: string,
  requestId: string,
  policiesV2: readonly CordisXPermissionPolicyRecordV2[],
  policiesV4: readonly CordisXPermissionPolicyRecordV4[],
  certification?: CordisXCertifiedPermissionProjectionV1,
  policiesV1: readonly CordisXPermissionPolicyRecordV1[] = [],
): DeferredPermissionPlan {
  if (staged.manifest.runtimeManifest.schemaVersion === 1) {
    const legacy = authorizationPlan(staged, operation, profileId, generation, policiesV1)
    return deferValidatedV1PermissionPlan(legacy, {
      operationId: legacy.planId,
      runtimeGeneration: generation,
      moduleGeneration,
      requestId,
    })
  }
  if (staged.manifest.runtimeManifest.schemaVersion === 4) {
    return deferValidatedV2PermissionPlan(authorizationPlanV2(
      staged,
      operation,
      profileId,
      generation,
      moduleGeneration,
      requestId,
      policiesV2,
    ))
  }
  return deferValidatedPermissionPlan(authorizationPlanV4(
    staged,
    operation,
    profileId,
    generation,
    moduleGeneration,
    requestId,
    policiesV2,
    policiesV4,
    certification,
  ))
}

/** Resolve a staged candidate through the existing lifecycle revision and generation fences. */
export async function deferredLifecycleReview(
  coordinator: Pick<PluginLifecycleCoordinator, 'permissionReviewPlanV7'>,
  request: HostPermissionLifecycleReviewV4Request,
): Promise<DeferredPermissionPlan | undefined> {
  return await coordinator.permissionReviewPlanV7(request)
}
