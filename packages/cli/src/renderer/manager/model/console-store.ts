import type { CordisXPluginConsolePageV1 } from '../../../contracts.js'
import type { ManagerModel } from '../../manager.js'

export interface PluginConsoleStore {
  getSnapshot(): CordisXPluginConsolePageV1
  subscribe(listener: () => void): () => void
}

export function createPluginConsoleStore(
  model: ManagerModel,
  pluginId: string,
  fallback: CordisXPluginConsolePageV1,
): PluginConsoleStore {
  let current = model.pluginConsole?.(pluginId) ?? fallback
  return {
    getSnapshot: () => current,
    subscribe: listener =>
      model.subscribePluginConsole?.(changedId => {
        if (changedId === pluginId) {
          current = model.pluginConsole?.(pluginId) ?? fallback
          listener()
        }
      }) ?? (() => {}),
  }
}
