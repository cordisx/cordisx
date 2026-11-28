import type { CordisXConfig } from '../launcher/config.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import type { OwnerAdapterDocumentContext } from './owner-adapter-sessions.js'
import type { OwnerRendererLifecycle } from './owner-renderer-lifecycle.js'
import { serviceRendererPermissionInputsCurrent } from './service-renderer-permission-inputs.js'
import { loadServiceConfiguredArchive } from './service-renderer-projection.js'

/** Read history for the exact owner-configured archive without granting a policy write. */
export async function ownerAdapterConfiguredHistoryIdentity(input: {
  readonly homeDir: string
  readonly profileId: string
  readonly generation: string
  readonly pluginId: string
  readonly context: OwnerAdapterDocumentContext
  readonly lifecycle: OwnerRendererLifecycle
  readonly config: CordisXConfig
  readonly signal: AbortSignal
}) {
  const invalid = (): never => {
    throw new Error('adapter-permission-history-unavailable')
  }
  if (!input.context.current(false) || input.signal.aborted) return invalid()
  const snapshot = structuredClone(input.lifecycle.snapshot())
  const selected = input.config.plugins.filter(plugin => plugin.id === input.pluginId)
  const plugin = selected[0]
  if (
    snapshot.active.recordKind !== 'active' || snapshot.active.profileId !== input.profileId
    || snapshot.active.runtimeGeneration !== input.generation
    || snapshot.active.plugins.some(item => item.id === input.pluginId)
    || selected.length !== 1 || !plugin?.source
  ) return invalid()
  const captured = structuredClone(plugin)
  const staged = await loadServiceConfiguredArchive(input.homeDir, captured)
  const identity = Object.freeze({ id: captured.id, source: staged.identitySource })
  const current = () => {
    try {
      const matches = input.config.plugins.filter(item => item.id === input.pluginId)
      return !input.signal.aborted && input.context.current(false)
        && attachmentEqual(snapshot, input.lifecycle.snapshot())
        && matches.length === 1 && attachmentEqual(matches[0], captured)
    } catch {
      return false
    }
  }
  const verifyCurrent = async () =>
    await serviceRendererPermissionInputsCurrent({
      entry: { config: input.config },
      profileId: input.profileId,
      pluginId: input.pluginId,
      signal: input.signal,
      isCurrent: current,
    })
  if (!current() || !await verifyCurrent()) return invalid()
  return Object.freeze({ identity, isCurrent: current, verifyCurrent })
}
