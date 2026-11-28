import type { PermissionAuthorizationPromptV2 } from './platform.js'
import type { StandaloneDomReview } from './standalone-dom-review.js'

/** Keep ordinary native prompts available while routing Manager review through the owner proof. */
export function nativePermissionPrompt(
  ordinary: PermissionAuthorizationPromptV2,
  review: StandaloneDomReview,
): PermissionAuthorizationPromptV2 {
  return {
    request: (plan, identity) => ordinary.request(plan, identity),
    requestV3: (plan, identity) =>
      review.isReviewing()
        ? review.requestV3(plan, identity)
        : ordinary.requestV3?.(plan, identity) ?? Promise.resolve(undefined),
    cancelV3: (planId, binding) => {
      review.cancelV3(planId, binding)
      ordinary.cancelV3?.(planId, binding)
    },
    requestV4: (plan, identity) => ordinary.requestV4?.(plan, identity) ?? Promise.resolve(undefined),
    cancelV4: (planId, binding) => ordinary.cancelV4?.(planId, binding),
    requestVisualV5: (plan, identity) => ordinary.requestVisualV5?.(plan, identity) ?? Promise.resolve(undefined),
    cancelVisualV5: (planId, binding) => ordinary.cancelVisualV5?.(planId, binding),
    requestUsageV6: (plan, identity) => ordinary.requestUsageV6?.(plan, identity) ?? Promise.resolve(undefined),
    cancelUsageV6: (planId, binding) => ordinary.cancelUsageV6?.(planId, binding),
    isDomLeaseVisible: (identity, pointId, generation) => review.isDomLeaseVisible(identity, pointId, generation),
    dispose: () => {
      review.dispose()
      ordinary.dispose?.()
    },
  }
}
