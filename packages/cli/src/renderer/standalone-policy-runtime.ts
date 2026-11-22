import type { StandaloneDomPolicyAdoption } from '../standalone-permission-contract.js'
import type { CordisXRuntimeMetadata } from './runtime-shared.js'
import { standaloneDomReview } from './standalone-dom-review.js'

type PolicyBroker = {
  adoptStandaloneDomPolicies(
    input: StandaloneDomPolicyAdoption & { readonly signal?: AbortSignal; readonly onUnknown?: () => void },
  ): Promise<boolean>
}

/** Keep the owner-issued adopter out of metadata retained by the runtime. */
export function prepareStandalonePolicyRuntime(metadata: CordisXRuntimeMetadata) {
  const { standalonePolicyAdopter, standalonePermissionSigner, ...safeMetadata } = metadata
  if (
    (standalonePolicyAdopter !== undefined || standalonePermissionSigner !== undefined)
    && metadata.hostKind !== 'standalone'
  ) {
    throw new Error('Standalone policy adoption is unavailable')
  }
  return {
    metadata: safeMetadata,
    sign: standalonePermissionSigner?.sign,
    register(broker: PolicyBroker, signal?: AbortSignal, onUnknown?: () => void): void {
      if (standalonePermissionSigner) {
        const review = standaloneDomReview(broker)
        if (
          !review?.bindPersistentDecision(
            (context, plan, decision) => standalonePermissionSigner.noteConfirmed(context, plan, decision),
          )
          || !review.bindPersistentReset(
            (context, observed) => standalonePermissionSigner.noteReset(context, observed),
          )
        ) throw new Error('Standalone permission review is unavailable')
      }
      standalonePolicyAdopter?.(async input => {
        if (signal?.aborted) return false
        const adopted = await broker.adoptStandaloneDomPolicies({
          ...input,
          ...(signal === undefined ? {} : { signal }),
          ...(onUnknown === undefined ? {} : { onUnknown }),
        })
        return adopted && !signal?.aborted
      })
    },
  }
}
