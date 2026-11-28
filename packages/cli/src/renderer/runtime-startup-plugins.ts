import { errorMessage, type PluginController } from './runtime-shared.js'

/** Only raised after the failed plugin's activation resources have been released. */
export class PluginActivationFailure extends Error {
  constructor(cause: unknown) {
    super(errorMessage(cause), { cause })
    this.name = 'PluginActivationFailure'
  }
}

export async function mountStartupPlugins(
  controllers: readonly PluginController[],
  mount: (controller: PluginController) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  for (const controller of controllers) {
    signal?.throwIfAborted()
    if (controller.status !== 'active') continue
    try {
      await mount(controller)
    } catch (error) {
      signal?.throwIfAborted()
      // Failed plugins remain visible in Manager. Host and cleanup failures stay fatal.
      if (!(error instanceof PluginActivationFailure)) throw error
    }
  }
}

/** A loaded graph remains identifiable when its plugin failed or is blocked. */
export function configuredStartupGraphGenerations(controllers: readonly PluginController[]) {
  return controllers.flatMap(controller => {
    const item = controller.item
    const accounted = controller.status === 'active' || controller.status === 'failed'
      || controller.status === 'blocked' || controller.status === 'permission-blocked'
    return accounted && item.enabled && item.module !== undefined && item.standaloneConfiguredGraph === true
        && item.package === undefined && typeof item.artifactGeneration === 'string'
      ? [{ pluginId: item.id, moduleGeneration: item.artifactGeneration }]
      : []
  })
}
