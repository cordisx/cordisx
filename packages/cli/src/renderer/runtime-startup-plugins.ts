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
