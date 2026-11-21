import { timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { pluginManagementRpcPaths } from '../launcher/management-rpc.js'
import { requestSupervisorPing } from './supervisor-control.js'
import {
  effectiveConfigFingerprint,
  processIdentityStatus,
  readSupervisorStateResult,
  type SupervisorPaths,
  type SupervisorState,
} from './supervisor-state.js'

/** Only a manager sidecar sends this over the existing private owner RPC. */
export interface ManagerRendererGatewayProof {
  readonly pid: number
  readonly processStartedAt: string
  readonly instanceToken: string
}

/** Must remain identical to the paths used by the manager supervisor. */
export function managerRendererGatewayPaths(homeDir: string, profileId: string): SupervisorPaths {
  const rpc = pluginManagementRpcPaths(homeDir, 'manager', profileId)
  const directory = path.join(homeDir, 'independent-manager', 'profiles', profileId)
  return {
    directory,
    state: path.join(directory, 'state.json'),
    lock: path.join(directory, 'start.lock'),
    mutex: path.join(directory, 'startup.mutex'),
    socket: path.join(rpc.socketDirectory, path.basename(rpc.socket).replace('management-', 'manager-')),
    log: path.join(directory, 'manager.log'),
    bootstrapToken: path.join(directory, 'bootstrap.token'),
  }
}

function validProof(proof: ManagerRendererGatewayProof): boolean {
  return proof !== null && typeof proof === 'object'
    && Object.keys(proof).length === 3
    && Number.isSafeInteger(proof.pid) && proof.pid > 0
    && typeof proof.processStartedAt === 'string' && proof.processStartedAt.length > 0
    && proof.processStartedAt.length <= 256
    && typeof proof.instanceToken === 'string' && /^[a-f0-9]{64}$/u.test(proof.instanceToken)
}

function tokenMatches(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

/**
 * Authenticates against the existing private manager record and control seat.
 * This inherits their same-user trust boundary: Node's socket API does not
 * attest the caller's PID, so it is not protection from malicious processes
 * running as the same OS user. The proof must never come from a browser.
 */
export function createManagerRendererGatewayAuthenticator(input: {
  readonly homeDir: string
  readonly profileId: string
  readonly ownerAppId: string
  readonly ownerGeneration: string
  readonly readState?: typeof readSupervisorStateResult
  readonly identify?: typeof processIdentityStatus
  readonly ping?: typeof requestSupervisorPing
}): (proof: ManagerRendererGatewayProof) => Promise<boolean> {
  const paths = managerRendererGatewayPaths(input.homeDir, input.profileId)
  const expectedConfig = effectiveConfigFingerprint({ appId: input.ownerAppId, generation: input.ownerGeneration })
  const read = input.readState ?? readSupervisorStateResult
  const identify = input.identify ?? processIdentityStatus
  const ping = input.ping ?? requestSupervisorPing
  const matches = (state: SupervisorState, proof: ManagerRendererGatewayProof): boolean =>
    state.appId === 'manager' && state.profileId === input.profileId && state.phase === 'ready'
    && state.effectiveConfig === expectedConfig && state.pid === proof.pid
    && state.processStartedAt === proof.processStartedAt && tokenMatches(state.instanceToken, proof.instanceToken)

  return async proof => {
    try {
      if (!validProof(proof)) return false
      const initial = await read(paths)
      if (initial.status !== 'valid' || !matches(initial.state, proof)) return false
      if (await identify(proof.pid, proof.processStartedAt) !== 'alive') return false
      if (!await ping(paths.socket, proof.instanceToken)) return false
      const current = await read(paths)
      if (current.status !== 'valid' || !matches(current.state, proof)) return false
      return await identify(proof.pid, proof.processStartedAt) === 'alive'
    } catch {
      return false
    }
  }
}
