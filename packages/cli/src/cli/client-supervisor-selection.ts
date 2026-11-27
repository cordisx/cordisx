import {
  processIdentityStatus,
  readSupervisorStateResult,
  type supervisorPaths,
  type SupervisorState,
} from './supervisor-state.js'

export type ExpectedService = Pick<SupervisorState, 'pid' | 'processStartedAt' | 'instanceToken'>

/** Resolve a native client without mistaking a starting or replaced service for an App owner. */
export async function selectServiceClient(input: {
  readonly enabled: boolean
  readonly action: string
  readonly ownerPaths: ReturnType<typeof supervisorPaths>
  readonly clientPaths: ReturnType<typeof supervisorPaths>
  readonly expectedService?: ExpectedService
  readonly waitForOwner: (instanceToken: string) => Promise<SupervisorState | undefined>
}): Promise<{ readonly client: boolean; readonly waited: boolean }> {
  if (!input.enabled) return { client: false, waited: false }
  const [owner, client] = await Promise.all([
    readSupervisorStateResult(input.ownerPaths),
    readSupervisorStateResult(input.clientPaths),
  ])
  if (
    input.expectedService && (
      owner.status !== 'valid' || owner.state.mode !== 'service' || owner.state.phase === 'failed'
      || owner.state.pid !== input.expectedService.pid
      || owner.state.processStartedAt !== input.expectedService.processStartedAt
      || owner.state.instanceToken !== input.expectedService.instanceToken
    )
  ) throw new Error('CordisX service owner changed while the client was waiting')
  if (client.status === 'invalid' || client.status === 'unreadable') {
    throw new Error('CordisX native client state is unavailable')
  }
  if (client.status === 'valid') {
    if (!client.state.clientOfService) throw new Error('CordisX native client state is invalid')
    return { client: true, waited: false }
  }
  if (owner.status !== 'valid' || owner.state.mode !== 'service' || owner.state.phase === 'failed') {
    return { client: false, waited: false }
  }
  const identity = await processIdentityStatus(owner.state.pid, owner.state.processStartedAt)
  if (identity === 'unknown') throw new Error('unable to verify the CordisX service owner identity')
  if (identity !== 'alive') return { client: false, waited: false }
  if (owner.state.phase !== 'starting' || input.action !== 'start' && input.action !== 'restart') {
    return { client: true, waited: false }
  }
  const ready = await input.waitForOwner(owner.state.instanceToken)
  if (
    !ready || ready.mode !== 'service' || ready.pid !== owner.state.pid
    || ready.processStartedAt !== owner.state.processStartedAt
  ) throw new Error('CordisX service owner changed while the client was waiting')
  return { client: true, waited: true }
}
