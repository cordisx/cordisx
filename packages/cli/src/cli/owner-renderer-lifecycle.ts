import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import type { PluginGenerationArtifactServer } from '../launcher/plugin-generation-artifact-server.js'
import type { AttachedRendererPeer } from '../launcher/renderer-lifecycle-peer.js'

/** Profile owner capability, supplied by the service or Desktop owner. */
export interface OwnerRendererLifecycle {
  snapshot(): Readonly<{ active: CordisXPluginActivationRecordV1; registryEpoch: number }>
  attach(peer: AttachedRendererPeer): Promise<void>
  artifactServer(): Promise<PluginGenerationArtifactServer>
  onActivationFinalized(listener: (active: CordisXPluginActivationRecordV1) => void): () => void
}
