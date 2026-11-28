import type { StandaloneDomPolicyAdoption } from '../standalone-permission-contract.js'
import type { CordisXRuntimeMetadata } from './runtime-shared.js'
import { standaloneDomReview } from './standalone-dom-review.js'
import { BrowserPermissionOnceBinding } from './permission-once-binding.js'

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
    && metadata.hostKind !== 'standalone' && metadata.nativeOwnerPermissionReview !== true
  ) {
    throw new Error('Standalone policy adoption is unavailable')
  }
  const once = standalonePermissionSigner
    ? BrowserPermissionOnceBinding.connect(metadata.permissionBridgeToken)
    : undefined
  return {
    metadata: safeMetadata,
    sign: standalonePermissionSigner?.sign,
    dispose: () => {
      once?.dispose()
      standalonePermissionSigner?.close()
    },
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
          || !review.bindOnceDecision(async (context, plan, decision) =>
            once ? await once.authorize(standalonePermissionSigner, context, plan, decision) : false
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
