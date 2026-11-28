import type { ServiceRendererBootstrapEntry } from './service-renderer-bootstrap-state.js'
import type { ManagementProjectionEntry } from './service-renderer-management-projection.js'

/** Build a view of one owner-held entry without granting a new capability. */
export function serviceRendererManagementEntry(
  entry: ServiceRendererBootstrapEntry | undefined,
  input: {
    available?: () => boolean
    current(entry: ServiceRendererBootstrapEntry): boolean
    unchanged(entry: ServiceRendererBootstrapEntry): Promise<boolean>
  },
): ManagementProjectionEntry | undefined {
  if (!entry) return undefined
  let restricted: ManagementProjectionEntry['restricted']
  try {
    if (entry.managementPlans?.available && entry.restrictedLifecycleIds && input.available?.()) {
      restricted = {
        plans: entry.managementPlans,
        writableIds: entry.restrictedLifecycleIds,
        configuredIds: new Set(entry.desktopLifecycleConfigPlugins),
      }
    }
  } catch { /* A missing owner authority never opens the lifecycle path. */ }
  return {
    confirmed: entry.bootstrapConfirmed,
    current: () => input.current(entry) && !entry.lifecycleTransition,
    unchanged: async () => await input.unchanged(entry),
    identity: entry.identity,
    aliases: entry.identityAliases,
    snapshot: entry.snapshot,
    scopedLifecycle: input.available !== undefined,
    restricted,
  }
}
