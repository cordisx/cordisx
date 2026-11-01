import path from 'node:path'

/**
 * The files a CordisX launch records for the agent bridge. They live under
 * `<CORDISX_HOME>/run`, readable only by the user, and are kept after a launch
 * ends so the other app knows which profile to start again.
 *
 * They are separate from `agent-bridge.ts` so the read-only status report can
 * name them without importing the bridge that imports the report.
 */
export function codexLaunchRecordPath(cordisxHomeDir: string): string {
  return path.join(cordisxHomeDir, 'run', 'codex-launch.json')
}

export function agentBridgeBindingPath(cordisxHomeDir: string): string {
  return path.join(cordisxHomeDir, 'run', 'agent-bridge.json')
}
