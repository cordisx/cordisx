import path from 'node:path'
import { hasMatchingProcessIdentity, readSupervisorState, supervisorPaths } from '../cli/supervisor-state.js'
import { modelProviderDisplays } from '../model-provider-display.js'
import { modelProviderDisplayExpression } from '../renderer/adapter/model-provider-display.js'
import { CdpSession, type CdpTarget } from './cdp-session.js'
import type { ExistingTerminalProviderSource } from './existing-terminal-provider-rpc.js'
import type { PluginManagementRpcEndpoint } from './management-rpc.js'
import { pluginManagementRpcPaths, readPluginManagementRpcEndpoint } from './management-rpc.js'

/** Compatibility read for older catalog producers; the already-running owner's UI remains authoritative. */
export async function existingModelProviderDisplays(
  source: ExistingTerminalProviderSource,
  endpoint: PluginManagementRpcEndpoint,
) {
  const state = await readSupervisorState(supervisorPaths(source.homeDir, 'codex', source.profileId))
  if (
    !state || state.pid !== endpoint.pid || state.processStartedAt !== endpoint.processStartedAt
    || state.appId !== endpoint.appId || state.profileId !== endpoint.profileId
    || state.hostPid === undefined || state.hostProcessStartedAt === undefined || state.cdpEndpoint === undefined
    || !await hasMatchingProcessIdentity(state.hostPid, state.hostProcessStartedAt)
  ) return []
  const address = new URL(state.cdpEndpoint)
  if (
    address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || !address.port
    || address.username || address.password || address.search || address.hash || address.pathname !== '/'
    || path.resolve(endpoint.configPath) !== path.resolve(source.homeDir, 'config.json')
  ) return []
  const targets = await (await fetch(new URL('/json/list', address), { signal: AbortSignal.timeout(2_000) }))
    .json() as readonly CdpTarget[]
  if (!Array.isArray(targets)) return []
  const pages = targets.filter(target => target.type === 'page' && target.url === 'app://-/index.html')
  if (pages.length !== 1 || pages[0]?.webSocketDebuggerUrl === undefined) return []
  const socket = new URL(pages[0].webSocketDebuggerUrl)
  if (socket.protocol !== 'ws:' || socket.host !== address.host || socket.username || socket.password) return []
  const session = await CdpSession.connect(socket.href)
  try {
    const result = await session.send('Runtime.evaluate', {
      expression: modelProviderDisplayExpression({
        profileId: endpoint.profileId,
        runtimeGeneration: endpoint.generation,
      }),
      returnByValue: true,
    }, 2_000)
    const after = await readSupervisorState(supervisorPaths(source.homeDir, 'codex', source.profileId))
    const current = await readPluginManagementRpcEndpoint(
      pluginManagementRpcPaths(source.homeDir, 'codex', source.profileId),
    )
    if (
      result.exceptionDetails || !after || after.pid !== state.pid || after.processStartedAt !== state.processStartedAt
      || after.hostPid !== state.hostPid || after.hostProcessStartedAt !== state.hostProcessStartedAt
      || after.cdpEndpoint !== state.cdpEndpoint
      || !await hasMatchingProcessIdentity(state.hostPid, state.hostProcessStartedAt)
      || !current || current.pid !== endpoint.pid || current.processStartedAt !== endpoint.processStartedAt
      || current.token !== endpoint.token || current.generation !== endpoint.generation
    ) return []
    return modelProviderDisplays((result.result as { value?: unknown } | undefined)?.value)
  } finally {
    session.close()
  }
}
