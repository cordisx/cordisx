import type { CordisXConfigPlugin } from '../launcher/config.js'
import type { DesktopConfigurationReservation } from '../launcher/desktop-configuration-reservation.js'
import type { DesktopManagerConfigProof } from '../launcher/renderer-config-management.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import type { ManagerRendererCommandPeer } from './manager-renderer-peer.js'
import type { ServiceRendererBootstrapEntry, ServiceRendererSnapshot } from './service-renderer-bootstrap-state.js'
import { emptyPluginConfig } from './desktop-manager-config-eligibility.js'
import { projectDesktopManagerConfig } from './desktop-manager-config-projection.js'

/** Reprove redacted configuration under the same Desktop seat after a generation change. */
export async function revalidateDesktopLifecycleConfig(input: {
  readonly snapshot: ServiceRendererSnapshot
  readonly entries: readonly ServiceRendererBootstrapEntry[]
  readonly current: () => boolean
  readonly reserve?: (peers: readonly ManagerRendererCommandPeer[]) => Promise<DesktopConfigurationReservation>
  readonly read: () => Promise<
    { readonly plugins: readonly CordisXConfigPlugin[]; readonly inputs: Map<string, string> }
  >
  readonly remember: (
    snapshot: ServiceRendererSnapshot,
    plugin: CordisXConfigPlugin,
    proof: DesktopManagerConfigProof,
  ) => boolean
  readonly canCoordinate: (snapshot: ServiceRendererSnapshot, plugin: CordisXConfigPlugin) => Promise<boolean>
}): Promise<boolean> {
  const ids = new Set(input.entries.flatMap(entry => [...entry.projectedConfigs?.keys() ?? []]))
  if (ids.size === 0) return true
  if (ids.size > 256 || !input.reserve) return false
  let lease: DesktopConfigurationReservation | undefined
  let released = false
  try {
    lease = await input.reserve(input.entries.map(entry => entry.peer))
    if (!input.current() || !lease.isCurrent()) return false
    const values = await input.read()
    const ineligible = new Set<string>()
    for (const id of ids) {
      const plugin = values.plugins.find(item => item.id === id)
      const proof = await lease.desktopConfiguration.proof(id)
      if (!input.current() || !lease.isCurrent() || !plugin || !proof || emptyPluginConfig(plugin.config)) return false
      const projected = projectDesktopManagerConfig(input.snapshot, plugin, proof)
      if (
        !values.inputs.has(id)
        || input.entries.some(entry =>
          !entry.projectedConfigs?.has(id) || !attachmentEqual(entry.projectedConfigs.get(id), projected)
          || !entry.packageInputs?.has(id) || entry.packageInputs.get(id) !== values.inputs.get(id)
        )
      ) return false
      if (!input.remember(input.snapshot, plugin, proof)) return false
      if (!await input.canCoordinate(input.snapshot, plugin)) ineligible.add(id)
      if (!input.current() || !lease.isCurrent()) return false
    }
    released = lease.release()
    if (!released || !input.current()) return false
    for (const entry of input.entries) {
      if (entry.desktopLifecycleConfigPlugins) {
        entry.desktopLifecycleConfigPlugins = entry.desktopLifecycleConfigPlugins.filter(id => !ineligible.has(id))
      }
    }
    return true
  } catch {
    return false
  } finally {
    if (lease && !released) lease.fence()
  }
}
