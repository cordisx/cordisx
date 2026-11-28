import {
  processIdentityStatus,
  readSupervisorStateResult,
  type SupervisorPaths,
  type SupervisorState,
} from './supervisor-state.js'

/** Wait only for the exact client which was already open when start was requested. */
export async function waitForClientReconnection(
  paths: SupervisorPaths,
  expected: SupervisorState,
  timeoutMs: number,
): Promise<SupervisorState> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const result = await readSupervisorStateResult(paths)
    if (result.status !== 'valid') throw new Error('CordisX client state is unavailable')
    const state = result.state
    if (
      state.instanceToken !== expected.instanceToken || state.pid !== expected.pid
      || state.processStartedAt !== expected.processStartedAt || !state.clientOfService
    ) throw new Error('CordisX client generation changed during reconnection')
    if (state.phase === 'failed' || state.phase === 'stopping') {
      throw new Error(state.failure ?? 'CordisX client stopped during reconnection')
    }
    const identity = await processIdentityStatus(state.pid, state.processStartedAt)
    if (identity !== 'alive') throw new Error('CordisX client process could not be verified')
    if (state.phase === 'ready' && state.clientConnection === 'connected') return state
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('timed out waiting for the CordisX client to reconnect')
}
