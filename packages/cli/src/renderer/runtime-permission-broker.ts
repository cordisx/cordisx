import { BrowserPermissionAuthorizationPromptV2, BrowserPermissionPrompt, PermissionBroker } from './platform.js'
import type { RuntimeClosureScope } from './runtime-closure-scope.js'
import { bindStandaloneDomReview, createStandaloneDomReview } from './standalone-dom-review.js'
import { bindNativeRuntimePrompt, nativePermissionPrompt } from './native-permission-prompt.js'

/** Compose the Host broker with the scoped standalone review, when available. */
export const createRuntimeBroker = (runtimeScope: RuntimeClosureScope) => {
  const standalone = runtimeScope.metadata()!.hostKind === 'standalone'
  const native = runtimeScope.metadata()!.nativeOwnerPermissionReview === true
  const review = (standalone || native) && runtimeScope.metadata()!.standaloneReviewSession !== undefined
    ? createStandaloneDomReview(document, native)
    : undefined
  const ordinary = standalone ? undefined : new BrowserPermissionAuthorizationPromptV2(
    document,
    undefined,
    runtimeScope.metadata()!.ownerPermissionSnapshot === true
      ? { sessionOnly: true, requireTrustedEvents: true }
      : {},
  )
  const nativePrompt = review && ordinary ? nativePermissionPrompt(ordinary, review) : undefined
  const broker = new PermissionBroker(
    runtimeScope.permissionStore()!,
    standalone ? { request: async () => 'deny' as const } : new BrowserPermissionPrompt(
      document,
      {
        sessionOnly: runtimeScope.metadata()!.ownerPermissionSnapshot === true,
        requireTrustedEvents: runtimeScope.metadata()!.ownerPermissionSnapshot === true,
      },
    ),
    () => new Date(),
    30000,
    runtimeScope.metadata()!.profileId,
    runtimeScope.generation()!,
    runtimeScope.generationVisibility()!,
    runtimeScope.pluginConsole()!,
    standalone ? review : nativePrompt ?? ordinary,
    runtimeScope.metadata()!.serviceCapabilityOwners ?? [],
  )
  if (review !== undefined) bindStandaloneDomReview(broker, review)
  if (nativePrompt !== undefined) bindNativeRuntimePrompt(broker, nativePrompt)
  return broker
}
