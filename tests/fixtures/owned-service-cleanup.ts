import {
  processIdentityStatus,
  readSupervisorStateResult,
  supervisorPaths,
} from '../../packages/cli/src/cli/supervisor-state.js'

interface OwnedServiceIdentity {
  readonly pid: number
  readonly processStartedAt: string
}

export async function captureOwnedService(homeDir: string): Promise<OwnedServiceIdentity> {
  const result = await readSupervisorStateResult(supervisorPaths(homeDir, 'codex', 'default'))
  if (result.status !== 'valid' || result.state.mode !== 'service') throw new Error('test service identity unavailable')
  return { pid: result.state.pid, processStartedAt: result.state.processStartedAt }
}

/** Preserve a fixture whenever its service identity or exit cannot be confirmed. */
export async function assertOwnedServicesStopped(
  homeDir: string,
  owners: readonly OwnedServiceIdentity[],
  startupRequested: boolean,
): Promise<void> {
  const result = await readSupervisorStateResult(supervisorPaths(homeDir, 'codex', 'default'))
  if (result.status === 'invalid' || result.status === 'unreadable') {
    throw new Error(`test service state is unverifiable; retained ${homeDir}`)
  }
  const identities = result.status === 'valid' ? [...owners, result.state] : [...owners]
  if (startupRequested && identities.length === 0) {
    throw new Error(`test service identity is unavailable; retained ${homeDir}`)
  }
  for (const owner of identities) {
    if (await processIdentityStatus(owner.pid, owner.processStartedAt) !== 'dead') {
      throw new Error(`test service exit is unconfirmed; retained ${homeDir}`)
    }
  }
}
