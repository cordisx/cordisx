import type { PermissionAuthorizationPromptV2 } from './platform.js'
import type { StandaloneDomReview } from './standalone-dom-review.js'
import type {
  CordisXPermissionAuthorizationDecisionV2,
  CordisXPermissionAuthorizationPlanV2,
} from '../permission-contracts.js'

type RuntimeDecision = (
  plan: CordisXPermissionAuthorizationPlanV2,
  decision: CordisXPermissionAuthorizationDecisionV2,
) => Promise<boolean>
type NativePrompt = PermissionAuthorizationPromptV2 & { bindRuntimeDecision(decision: RuntimeDecision): boolean }
const prompts = new WeakMap<object, NativePrompt>()

export function bindNativeRuntimePrompt(broker: object, prompt: NativePrompt): void {
  if (prompts.has(broker)) throw new Error('native-runtime-prompt-already-bound')
  prompts.set(broker, prompt)
}

export function nativeRuntimePrompt(broker: object): NativePrompt | undefined {
  return prompts.get(broker)
}

/** Keep ordinary native prompts available while routing Manager review through the owner proof. */
export function nativePermissionPrompt(
  ordinary: PermissionAuthorizationPromptV2,
  review: StandaloneDomReview,
): NativePrompt {
  let runtimeDecision: RuntimeDecision | undefined
  return {
    bindRuntimeDecision: decision => {
      if (runtimeDecision) return false
      runtimeDecision = decision
      return true
    },
    request: async (plan, identity, context) => {
      if (plan.identity.pluginId !== identity.id || plan.identity.source !== identity.source) return undefined
      const decision = await ordinary.request(plan, identity)
      if (!decision || plan.operation !== 'runtime') return decision
      // Exact-request and unverified local graphs keep their existing session
      // behavior until the service can verify their distinct authorities.
      if (context?.ownerReviewEligible === false) return decision
      if (!runtimeDecision || !await runtimeDecision(plan, decision)) return undefined
      return decision
    },
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
      runtimeDecision = undefined
      review.dispose()
      ordinary.dispose?.()
    },
  }
}
