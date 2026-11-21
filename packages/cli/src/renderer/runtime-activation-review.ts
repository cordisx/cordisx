import type { CordisXPermissionAuthorizationDecisionV4 } from '../permission-contracts.js'
import type { RuntimeClosureScope } from './runtime-closure-scope.js'

/** Current-generation Host activation review remains distinct from runtime plugin mutations. */
export const createRuntimeAuthorizePluginV4 = (
  runtimeScope: RuntimeClosureScope,
  id: string,
  decision: CordisXPermissionAuthorizationDecisionV4,
): Promise<void> =>
  runtimeScope.authorizePluginWith()!(id, async (controller) => {
    if (
      controller.manifest.schemaVersion !== 5 && controller.manifest.schemaVersion !== 6
      && controller.manifest.schemaVersion !== 7 && controller.manifest.schemaVersion !== 8
      && controller.manifest.schemaVersion !== 9
      && (controller.manifest.schemaVersion !== 10 && controller.manifest.schemaVersion !== 11
        && controller.manifest.schemaVersion !== 12 && controller.manifest.schemaVersion !== 13
        && controller.manifest.schemaVersion !== 16)
    ) {
      throw new Error(`plugin ${id} does not use permission v4`)
    }
    await runtimeScope.broker()!.authorizeReviewedActivationV4(
      controller.identity,
      decision,
      controller.generationView,
    )
  })
