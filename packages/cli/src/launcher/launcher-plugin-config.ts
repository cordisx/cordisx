import {
  createPluginConfigCandidateStore,
  type PluginConfigCandidateStore,
  type PluginConfigDocument,
} from '../config/plugin-config.js'
import { updateConfigDocumentAtomic } from '../config/home-config.js'
import { parseConfigDocument, type CordisXConfig } from './config.js'
import { createConfigBridgeHandler, type ConfigBridgeHandler } from './config-rpc.js'

/**
 * Persist renderer-owned plugin configuration inside a launcher composition.
 * The launcher envelope is validated with its own parser and retained verbatim;
 * only the selected plugin's profile ledger is replaced by the shared CAS core.
 */
export function createLauncherPluginConfigCandidateStore(
  configPath: string,
  profileId: string,
): PluginConfigCandidateStore {
  return createPluginConfigCandidateStore(async updater => {
    const updated = await updateConfigDocumentAtomic(
      configPath,
      'launcher config',
      value => { parseConfigDocument(value, configPath, { profileId }) },
      async current => {
        const ledger = await updater(current as unknown as PluginConfigDocument)
        return { ...current, plugins: ledger.plugins }
      },
    )
    return updated as unknown as PluginConfigDocument
  })
}

/** Production composition seam used by the Playground launcher envelope. */
export function createLauncherConfigBridgeHandler(input: {
  readonly token: string
  readonly profileId: string
  readonly generation: string
  readonly configPath: string
  readonly composition: CordisXConfig
}): ConfigBridgeHandler {
  return createConfigBridgeHandler({
    ...input,
    configuredPluginConfig: createLauncherPluginConfigCandidateStore(input.configPath, input.profileId),
  })
}
