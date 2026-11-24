import { loadConfig } from '../launcher/config.js'

/** Renderer snapshots use the same owner-selected Channel identity as the service. */
export async function loadServiceRendererConfig(input: {
  readonly configPath: string
  readonly homeDir: string
  readonly profileId: string
  readonly serviceOwnerBundledChannel?: boolean
}) {
  return await loadConfig(input.configPath, {
    profileId: input.profileId,
    projectRoot: input.homeDir,
    serviceOwnerBundledChannel: input.serviceOwnerBundledChannel === true,
  })
}
