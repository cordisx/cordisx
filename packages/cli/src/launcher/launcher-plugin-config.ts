import {
  createPluginConfigCandidateStore,
  type PluginConfigCandidateStore,
  type PluginConfigDocument,
} from '../config/plugin-config.js'
import { updateConfigDocumentAtomic } from '../config/home-config.js'
import { type CordisXConfig, parseConfigDocument } from './config.js'
import { type ConfigBridgeHandler, createConfigBridgeHandler } from './config-rpc.js'

/**
 * Persist renderer-owned plugin configuration inside a launcher composition.
 * The launcher envelope is validated with its own parser and retained verbatim;
 * only the selected plugin's profile ledger is replaced by the shared CAS core.
 */
export function createLauncherPluginConfigCandidateStore(
  configPath: string,
  profileId: string,
  expectedComposition?: CordisXConfig,
): PluginConfigCandidateStore {
  const topology = (config: CordisXConfig) =>
    JSON.stringify(config.plugins.map(plugin => [
      plugin.id,
      plugin.entry,
      plugin.developmentIdentityEntry ?? null,
      plugin.enabled,
    ]))
  const expectedTopology = expectedComposition === undefined ? undefined : topology(expectedComposition)
  return createPluginConfigCandidateStore(async updater => {
    const updated = await updateConfigDocumentAtomic(
      configPath,
      'launcher config',
      value => {
        const parsed = parseConfigDocument(value, configPath, { profileId })
        if (expectedTopology !== undefined && topology(parsed) !== expectedTopology) {
          throw new Error('launcher plugin composition changed; restart development before saving configuration')
        }
      },
      async current => {
        const ledger = await updater(current as unknown as PluginConfigDocument)
        return { ...current, plugins: ledger.plugins }
      },
    )
    return updated as unknown as PluginConfigDocument
  })
}

/** Production composition seam for explicitly writable launcher envelopes. */
export function createLauncherConfigBridgeHandler(input: {
  readonly token: string
  readonly profileId: string
  readonly generation: string
  readonly configPath: string
  readonly composition: CordisXConfig
  /** Reject writes after externally changed development owner topology. */
  readonly preserveComposition?: boolean
}): ConfigBridgeHandler {
  return createConfigBridgeHandler({
    ...input,
    configuredPluginConfig: createLauncherPluginConfigCandidateStore(
      input.configPath,
      input.profileId,
      input.preserveComposition === true ? input.composition : undefined,
    ),
  })
}
