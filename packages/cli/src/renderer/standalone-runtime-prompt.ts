import type {
  CordisXPermissionAuthorizationDecisionV2,
  CordisXPermissionAuthorizationPlanV2,
} from '../permission-contracts.js'
import type { PermissionAuthorizationPromptV2 } from './platform.js'
import type { StandaloneDomReview } from './standalone-dom-review.js'

type Artifact = { readonly version: string; readonly integrity: `sha256:${string}` }
type RuntimeDecision = (
  plan: CordisXPermissionAuthorizationPlanV2,
  decision: CordisXPermissionAuthorizationDecisionV2,
  artifact: Artifact,
) => Promise<boolean>
type StandalonePrompt = PermissionAuthorizationPromptV2 & { bindRuntimeDecision(decision: RuntimeDecision): boolean }
const prompts = new WeakMap<object, StandalonePrompt>()

export function bindStandaloneRuntimePrompt(broker: object, prompt: StandalonePrompt): void {
  if (prompts.has(broker)) throw new Error('standalone-runtime-prompt-already-bound')
  prompts.set(broker, prompt)
}

export function standaloneRuntimePrompt(broker: object): StandalonePrompt | undefined {
  return prompts.get(broker)
}

/** A Web runtime choice is usable only after the service confirms its current artifact and graph. */
export function standalonePermissionPrompt(
  ordinary: PermissionAuthorizationPromptV2,
  review: StandaloneDomReview,
): StandalonePrompt {
  let runtimeDecision: RuntimeDecision | undefined
  let closed = false
  return {
    bindRuntimeDecision: decision => {
      if (closed || runtimeDecision) return false
      runtimeDecision = decision
      return true
    },
    request: async (plan, identity, context) => {
      if (
        closed || !runtimeDecision || context?.ownerReviewEligible !== true || !context.ownerReviewArtifact
        || plan.operation !== 'runtime' || plan.identity.pluginId !== identity.id
        || plan.identity.source !== identity.source
      ) return undefined
      const decision = await ordinary.request(plan, identity)
      if (closed || !decision || !await runtimeDecision(plan, decision, context.ownerReviewArtifact)) return undefined
      return closed ? undefined : decision
    },
    requestV3: (plan, identity) => review.isReviewing() ? review.requestV3(plan, identity) : Promise.resolve(undefined),
    cancelV3: (planId, binding) => review.cancelV3(planId, binding),
    isDomLeaseVisible: (identity, pointId, generation) => review.isDomLeaseVisible(identity, pointId, generation),
    dispose: () => {
      closed = true
      runtimeDecision = undefined
      review.dispose()
      ordinary.dispose?.()
    },
  }
}
