import type { SupervisorState } from './supervisor-state.js'

/** A new service owner confirms cleanup in its own generation before exiting. */
export function assertServiceCleanupReceipt(owner: SupervisorState, latest: SupervisorState | undefined): void {
  if (owner.mode !== 'service') return
  if (
    latest !== undefined
    && (latest.mode !== 'service' || latest.instanceToken !== owner.instanceToken || latest.pid !== owner.pid
      || latest.processStartedAt !== owner.processStartedAt || latest.effectiveConfig !== owner.effectiveConfig)
  ) throw new Error('CordisX service cleanup could not be confirmed because the owner changed')
  if (owner.serviceCleanup === undefined) {
    // Older service owners have no cleanup receipt, but can publish a failure
    // while processing this stop request. Preserve that diagnosis.
    if (owner.phase !== 'failed' && latest?.phase === 'failed') {
      throw new Error('CordisX service cleanup failed; inspect the service logs')
    }
    return
  }
  if (latest?.serviceCleanup === 'failed') throw new Error('CordisX service cleanup failed; inspect the service logs')
  if (latest?.serviceCleanup !== 'completed' || latest.phase !== 'stopping') {
    throw new Error('CordisX service cleanup could not be confirmed')
  }
}
