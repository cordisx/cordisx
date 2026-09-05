import type { CordisXPluginBundleManagerSnapshotV1 } from '../plugin-bundle-contracts.js'
import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'

export interface PluginLifecycleProjectionSettlement {
  loadActive(): Promise<CordisXPluginActivationRecordV1>
  refreshBrowserGraphBootstrap(active: CordisXPluginActivationRecordV1): Promise<void>
  loadBundleSnapshot?: () => Promise<CordisXPluginBundleManagerSnapshotV1>
  synchronizePluginBundles?: (snapshot: CordisXPluginBundleManagerSnapshotV1) => Promise<void>
  terminal(error: unknown): void
}

/** Reconcile live and future projections even when a mutation restored last-good and rejected its caller. */
export async function runPluginLifecycleRequestWithProjection<Value>(
  request: () => Promise<Value>,
  reconcile: boolean,
  settlement: PluginLifecycleProjectionSettlement,
): Promise<Value> {
  const outcome = await request().then(
    value => ({ status: 'fulfilled' as const, value }),
    reason => ({ status: 'rejected' as const, reason: reason as unknown }),
  )
  if (reconcile) {
    const failures: unknown[] = []
    const active = await settlement.loadActive().catch(error => {
      failures.push(error)
      return undefined
    })
    if (active !== undefined) {
      await settlement.refreshBrowserGraphBootstrap(active).catch(error => failures.push(error))
    }
    if (settlement.loadBundleSnapshot !== undefined && settlement.synchronizePluginBundles !== undefined) {
      await settlement.loadBundleSnapshot()
        .then(async snapshot => await settlement.synchronizePluginBundles!(snapshot))
        .catch(error => failures.push(error))
    }
    if (failures.length > 0) {
      const error = failures.length === 1
        ? failures[0]
        : new AggregateError(failures, 'plugin lifecycle projection reconciliation failed')
      settlement.terminal(error)
      if (outcome.status === 'rejected') {
        throw new AggregateError(
          [outcome.reason, error],
          'plugin lifecycle request failed and projection reconciliation failed',
        )
      }
      throw error
    }
  }
  if (outcome.status === 'rejected') throw outcome.reason
  return outcome.value
}
