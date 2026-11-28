import type { CordisXManagedInvocation } from './parse.js'
import type { PreparedRunCommand } from './run-command-dispatch.js'
import type { CordisXCliRuntime } from './run-support.js'

/** Start or reuse the profile service before admitting the native client. */
export async function ensureClientService(prepared: PreparedRunCommand, runtime: CordisXCliRuntime): Promise<void> {
  await ensureClientServiceScope(prepared, runtime)
}

/** Used by both a new client and an explicit start of a disconnected client. */
export async function ensureClientServiceScope(
  prepared: Pick<PreparedRunCommand, 'appId' | 'configPath' | 'selection'>,
  runtime: CordisXCliRuntime,
): Promise<void> {
  const service: CordisXManagedInvocation = {
    action: 'start',
    mode: 'service',
    app: prepared.appId,
    profile: prepared.selection.profileId,
    dataMode: prepared.selection.dataMode,
    options: { attach: false, system: false, isolated: false, onlineDevtools: false, dryRun: false, json: true },
    hostArgs: [],
  }
  const { runSupervisorCommand } = await import('./supervisor-command.js')
  const ready = await runSupervisorCommand(service, { ...runtime, stdout: () => {} })
  if (
    !ready || ready.state.mode !== 'service' || ready.state.phase !== 'ready'
    || ready.target.configPath !== prepared.configPath || ready.target.appId !== prepared.appId
    || ready.target.selection.profileId !== prepared.selection.profileId
    || ready.target.selection.dataMode !== prepared.selection.dataMode
  ) throw new Error('CordisX service owner did not become ready for this client')
}
