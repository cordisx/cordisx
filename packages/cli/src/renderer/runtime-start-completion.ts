import type { CordisXRuntimeHandle, PluginController } from './runtime-shared.js'

export async function completeRuntimeStart(
  handle: CordisXRuntimeHandle,
  controllers: readonly PluginController[],
  signal?: AbortSignal,
): Promise<CordisXRuntimeHandle> {
  if (signal?.aborted) {
    await handle.dispose()
    signal.throwIfAborted()
  }
  globalThis.__cordisxRuntime = handle
  document.documentElement.dataset.cordisxReady = 'true'
  const activeIds = controllers.filter(controller => controller.status === 'active').map(controller =>
    controller.item.id
  )
  console.info(`[cordisx] mounted ${activeIds.length} plugin(s): ${activeIds.join(', ')}`)
  return handle
}
