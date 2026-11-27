import { randomUUID } from 'node:crypto'
import { createStartupLifetime } from './startup-lifetime.js'
import path from 'node:path'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
} from '../launcher/management-rpc.js'
import type { TerminalProviderResult } from '../launcher/terminal-provider.js'
import { requestSupervisorPing } from './supervisor-control.js'
import {
  clientSupervisorPaths,
  processIdentityStatus,
  readSupervisorState,
  supervisorPaths,
  type SupervisorState,
} from './supervisor-state.js'

/** Caller failure never changes a ready supervisor or acquires credentials. */
export async function waitForStartupCaller(input: {
  configPath: string
  appId: string
  profileId: string
  state: SupervisorState
  providerId?: string
  model?: string
  signal?: AbortSignal
}) {
  const paths = pluginManagementRpcPaths(path.dirname(input.configPath), input.appId, input.profileId)
  const endpoint = await readPluginManagementRpcEndpoint(paths)
  if (!endpoint) {
    if (input.providerId === undefined && !input.state.clientOfService) return // Legacy Hosts may not expose native composition.
    throw new Error('Startup target observation unavailable in this Host')
  }
  const home = path.dirname(input.configPath)
  const verifyOwner = async () => {
    if (path.resolve(endpoint.configPath) !== path.resolve(input.configPath)) {
      throw new Error('Startup target owner changed')
    }
    if (!input.state.clientOfService) {
      if (endpoint.pid !== input.state.pid || endpoint.processStartedAt !== input.state.processStartedAt) {
        throw new Error('Startup target owner changed')
      }
      return
    }
    const ownerPaths = supervisorPaths(home, input.appId, input.profileId)
    const clientPaths = clientSupervisorPaths(home, input.appId, input.profileId)
    const [owner, client, currentEndpoint] = await Promise.all([
      readSupervisorState(ownerPaths),
      readSupervisorState(clientPaths),
      readPluginManagementRpcEndpoint(paths),
    ])
    if (
      !owner || owner.mode !== 'service' || owner.phase !== 'ready'
      || owner.appId !== input.appId || owner.profileId !== input.profileId
      || owner.pid !== endpoint.pid || owner.processStartedAt !== endpoint.processStartedAt
      || !client || !client.clientOfService || client.phase !== 'ready' || client.clientConnection !== 'connected'
      || client.appId !== input.appId || client.profileId !== input.profileId
      || client.pid !== input.state.pid || client.processStartedAt !== input.state.processStartedAt
      || client.instanceToken !== input.state.instanceToken
      || !currentEndpoint || currentEndpoint.pid !== endpoint.pid
      || currentEndpoint.appId !== input.appId || currentEndpoint.profileId !== input.profileId
      || currentEndpoint.processStartedAt !== endpoint.processStartedAt || currentEndpoint.token !== endpoint.token
      || currentEndpoint.generation !== endpoint.generation
      || await processIdentityStatus(owner.pid, owner.processStartedAt) !== 'alive'
      || await processIdentityStatus(client.pid, client.processStartedAt) !== 'alive'
      || !await requestSupervisorPing(ownerPaths.socket, owner.instanceToken)
      || !await requestSupervisorPing(clientPaths.socket, client.instanceToken)
    ) throw new Error('Startup target owner changed')
    const [finalOwner, finalClient] = await Promise.all([
      readSupervisorState(ownerPaths),
      readSupervisorState(clientPaths),
    ])
    if (
      !finalOwner || finalOwner.mode !== 'service' || finalOwner.phase !== 'ready'
      || finalOwner.pid !== owner.pid || finalOwner.processStartedAt !== owner.processStartedAt
      || finalOwner.instanceToken !== owner.instanceToken
      || !finalClient || finalClient.phase !== 'ready' || finalClient.clientConnection !== 'connected'
      || finalClient.pid !== client.pid || finalClient.processStartedAt !== client.processStartedAt
      || finalClient.instanceToken !== client.instanceToken
    ) throw new Error('Startup target owner changed')
  }
  await verifyOwner()
  const lifetime = createStartupLifetime(input.signal)
  const waiterId = randomUUID()
  const cancel = () => {
    void requestPluginManagementRpc(paths, endpoint, {
      kind: 'terminal-provider',
      request: { kind: 'cancel-wait', waiterId },
    }).catch(() => undefined)
  }
  lifetime.signal.addEventListener('abort', cancel, { once: true })
  try {
    lifetime.signal.throwIfAborted()
    const result = await requestPluginManagementRpc(paths, endpoint, {
      kind: 'terminal-provider',
      request: {
        kind: 'wait',
        waiterId,
        ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
        ...(input.model === undefined ? {} : { model: input.model }),
      },
    }) as TerminalProviderResult
    if (result.kind === 'unavailable') {
      throw new Error(
        `Startup target unavailable: ${
          result.startup.status === 'unavailable' ? result.startup.reason : result.startup.status
        }`,
      )
    }
    if (result.kind !== 'ready') throw new Error('Startup requirements returned an invalid result')
    lifetime.signal.throwIfAborted()
    if (input.state.clientOfService) await verifyOwner()
  } finally {
    lifetime.signal.removeEventListener('abort', cancel)
    lifetime.close()
  }
}
