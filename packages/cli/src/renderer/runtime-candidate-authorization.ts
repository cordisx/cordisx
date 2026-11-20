import type { RuntimeClosureScope } from './runtime-closure-scope.js'
import type { PluginController, RendererPluginMutation } from './runtime-shared.js'

/** Commit only the Host-reviewed candidate's authorization before it can publish. */
export async function authorizeCandidateMutation(
  scope: RuntimeClosureScope,
  controller: PluginController,
  mutation: RendererPluginMutation,
): Promise<void> {
  const authorization = mutation.authorizationDecision
  if (
    controller.item.id !== mutation.targetId || authorization === undefined
    || (mutation.operation !== 'install' && mutation.operation !== 'update' && mutation.operation !== 'enable')
  ) return
  const operation = mutation.operation
  if (authorization.schemaVersion === 4 || authorization.schemaVersion === 7) {
    const version = controller.manifest.schemaVersion
    if (
      !(authorization.schemaVersion === 7 && (version === 1 || version === 4))
      && ![5, 6, 7, 8, 9, 10, 11, 12, 13, 16].includes(version)
    ) throw new Error('permission decision is incompatible with this manifest')
    if (authorization.schemaVersion === 7) {
      await scope.broker()!.authorizeActivationV7(
        controller.identity,
        authorization,
        operation,
        controller.generationView,
        mutation.bundlePolicySelections,
      )
    } else {
      await scope.broker()!.authorizeActivationV4(
        controller.identity,
        authorization,
        operation,
        controller.generationView,
      )
    }
  } else if (authorization.schemaVersion === 2) {
    if (controller.manifest.schemaVersion !== 4) throw new Error('permission v2 decision requires manifest-v4')
    await scope.broker()!.authorizeActivationV2(
      controller.identity,
      authorization,
      operation,
      controller.generationView,
    )
  } else {
    await scope.broker()!.authorizeActivation(controller.identity, authorization, operation, controller.generationView)
  }
}
