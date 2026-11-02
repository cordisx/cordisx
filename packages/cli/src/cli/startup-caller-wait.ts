import { randomUUID } from 'node:crypto'
import { createStartupLifetime } from './startup-lifetime.js'
import path from 'node:path'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
} from '../launcher/management-rpc.js'
import type { TerminalProviderResult } from '../launcher/terminal-provider.js'
import type { SupervisorState } from './supervisor-state.js'

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
    if (input.providerId === undefined) return // Legacy Hosts may not expose native composition.
    throw new Error('Startup target observation unavailable in this Host')
  }
  if (
    endpoint.pid !== input.state.pid || endpoint.processStartedAt !== input.state.processStartedAt
    || path.resolve(endpoint.configPath) !== path.resolve(input.configPath)
  ) {
    throw new Error('Startup target owner changed')
  }
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
  } finally {
    lifetime.signal.removeEventListener('abort', cancel)
    lifetime.close()
  }
}
