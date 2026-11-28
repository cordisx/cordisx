import type { StandaloneDomPolicyAdoption } from '../standalone-permission-contract.js'
import type { CordisXRuntimeMetadata } from './runtime-shared.js'
import { standaloneDomReview } from './standalone-dom-review.js'
import { BrowserPermissionOnceBinding } from './permission-once-binding.js'
import { nativeRuntimePrompt } from './native-permission-prompt.js'
import { standaloneRuntimePrompt } from './standalone-runtime-prompt.js'
import { isPermissionPolicyRecordV2 } from '../permission-persistence.js'
import { bindStandaloneRuntimePolicyReviewer } from './standalone-runtime-policy-review.js'
import { bindStandaloneLifecycleReview } from './standalone-lifecycle-review.js'

type PolicyBroker = {
  adoptStandaloneDomPolicies(
    input: StandaloneDomPolicyAdoption & { readonly signal?: AbortSignal; readonly onUnknown?: () => void },
  ): Promise<boolean>
  adoptOwnerRuntimePolicies(
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
  let unbindLifecycle: (() => void) | undefined
  return {
    metadata: safeMetadata,
    sign: standalonePermissionSigner?.sign,
    dispose: () => {
      unbindLifecycle?.()
      once?.dispose()
      standalonePermissionSigner?.close()
    },
    register(broker: PolicyBroker, signal?: AbortSignal, onUnknown?: () => void): void {
      if (standalonePermissionSigner) {
        if (metadata.hostKind === 'standalone' && metadata.standaloneReviewSession) {
          unbindLifecycle = bindStandaloneLifecycleReview(
            document,
            standalonePermissionSigner,
            metadata.standaloneReviewSession,
            signal,
          )
        }
        bindStandaloneRuntimePolicyReviewer(
          broker,
          (context, record, observed) => standalonePermissionSigner.noteRuntimePolicy(context, record, observed),
        )
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
        if (
          metadata.nativeOwnerPermissionReview === true
          && !nativeRuntimePrompt(broker)?.bindRuntimeDecision(async (plan, decision) =>
            once ? await once.authorizeRuntime(standalonePermissionSigner, plan, decision) : false
          )
        ) throw new Error('Native runtime permission review is unavailable')
        if (
          metadata.hostKind === 'standalone'
          && !standaloneRuntimePrompt(broker)?.bindRuntimeDecision(async (plan, decision, artifact) =>
            once ? await once.authorizeWebRuntime(standalonePermissionSigner, artifact, plan, decision) : false
          )
        ) throw new Error('Standalone runtime permission review is unavailable')
      }
      standalonePolicyAdopter?.(async input => {
        if (signal?.aborted) return false
        const transition = {
          ...input,
          ...(signal === undefined ? {} : { signal }),
          ...(onUnknown === undefined ? {} : { onUnknown }),
        }
        const adopted = input.updates.length > 0 && input.updates.every(isPermissionPolicyRecordV2)
          ? await broker.adoptOwnerRuntimePolicies(transition)
          : await broker.adoptStandaloneDomPolicies(transition)
        return adopted && !signal?.aborted
      })
    },
  }
}
