import type { CordisXConfig } from '../launcher/config.js'
import type { OwnerAdapterManagementContext } from './owner-adapter-sessions.js'
import type { OwnerRendererLifecycle } from './owner-renderer-lifecycle.js'
import { ownerAdapterConfiguredHistoryIdentity } from './owner-adapter-configured-history.js'
import { ownerAdapterManagerPolicyTarget } from './owner-adapter-manager-policy-target.js'

/** Resolve a configured native target only from the owner's verified archive. */
export async function ownerAdapterConfiguredPermissionTarget(input: {
  readonly homeDir: string
  readonly profileId: string
  readonly generation: string
  readonly pluginId: string
  readonly moduleGeneration: string
  readonly context: OwnerAdapterManagementContext
  readonly lifecycle: OwnerRendererLifecycle
  readonly config: CordisXConfig
  readonly signal: AbortSignal
}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(input.moduleGeneration)) {
    throw new Error('adapter-permission-target-unavailable')
  }
  const selected = await ownerAdapterConfiguredHistoryIdentity({
    ...input,
    context: { secret: input.context.secret, current: () => input.context.live() },
  })
  const plugin = input.config.plugins.find(item => item.id === input.pluginId)
  if (!plugin?.configuredArchiveDigest || !plugin.distributionArtifact || !selected.isCurrent()) {
    throw new Error('adapter-permission-target-unavailable')
  }
  return ownerAdapterManagerPolicyTarget({
    kind: input.pluginId === 'channel' ? 'configured-channel' : 'configured-plugin',
    profileId: input.profileId,
    identity: selected.identity,
    moduleGeneration: input.moduleGeneration,
    digest: plugin.configuredArchiveDigest,
    artifact: plugin.distributionArtifact,
    isCurrent: selected.isCurrent,
    verifyCurrent: selected.verifyCurrent,
  })
}
