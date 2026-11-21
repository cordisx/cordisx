import { BrowserPermissionAuthorizationPromptV2, BrowserPermissionPrompt, PermissionBroker } from './platform.js'
import type { RuntimeClosureScope } from './runtime-closure-scope.js'
import { bindStandaloneDomReview, createStandaloneDomReview } from './standalone-dom-review.js'

/** Compose the Host broker with the scoped standalone review, when available. */
export const createRuntimeBroker = (runtimeScope: RuntimeClosureScope) => {
  const standalone = runtimeScope.metadata()!.hostKind === 'standalone'
  const review = standalone && runtimeScope.metadata()!.standaloneReviewSession !== undefined
    ? createStandaloneDomReview(document)
    : undefined
  const broker = new PermissionBroker(
    runtimeScope.permissionStore()!,
    standalone ? { request: async () => 'deny' as const } : new BrowserPermissionPrompt(),
    () => new Date(),
    30000,
    runtimeScope.metadata()!.profileId,
    runtimeScope.generation()!,
    runtimeScope.generationVisibility()!,
    runtimeScope.pluginConsole()!,
    standalone ? review : new BrowserPermissionAuthorizationPromptV2(document),
    runtimeScope.metadata()!.serviceCapabilityOwners ?? [],
  )
  if (review !== undefined) bindStandaloneDomReview(broker, review)
  return broker
}
