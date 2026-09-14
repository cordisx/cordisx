import {
  CORDISX_PLUGIN_LIFECYCLE_RESULT_SCHEMA_V1,
  type CordisXPluginLifecycleOperationV1,
  type CordisXPluginLifecycleResultV1,
} from '../plugin-lifecycle-contracts.js'
import type { RuntimeClosureScope } from './runtime-closure-scope.js'

export function developmentReloadAvailable(scope: RuntimeClosureScope, pluginId: string): boolean {
  const controller = scope.activeController()!(pluginId)
  return scope.metadata()!.developmentReloadPlugin !== undefined
    && controller?.status === 'active'
    && controller.item.development?.origin === 'local-dev'
}

/** Route the existing Manager action to the Host-owned Vite callback, never a plugin Context. */
export async function requestRuntimePluginLifecycle(
  scope: RuntimeClosureScope,
  operation: CordisXPluginLifecycleOperationV1,
): Promise<CordisXPluginLifecycleResultV1> {
  if (operation.kind !== 'reload' || !developmentReloadAvailable(scope, operation.pluginId)) {
    const bridge = scope.lifecycleBridge()!
    if (bridge === undefined) throw new Error('plugin lifecycle operations are unavailable')
    return bridge.request(scope.currentActivation.revision, operation)
  }
  const requestId = crypto.randomUUID()
  const result = (): CordisXPluginLifecycleResultV1 => ({
    $schema: CORDISX_PLUGIN_LIFECYCLE_RESULT_SCHEMA_V1,
    schemaVersion: 1,
    requestId,
    profileId: scope.currentActivation.profileId,
    operation: 'reload',
    outcome: 'applied',
    revision: scope.currentActivation.revision,
    runtimeGeneration: scope.currentActivation.runtimeGeneration,
    scope: 'plugin-generation',
    affectedPluginIds: [operation.pluginId],
  })
  try {
    await scope.metadata()!.developmentReloadPlugin!(operation.pluginId)
    return result()
  } catch (error) {
    return {
      ...result(),
      outcome: 'rejected',
      error: { code: 'activation-failed', message: error instanceof Error ? error.message : String(error) },
    }
  }
}
