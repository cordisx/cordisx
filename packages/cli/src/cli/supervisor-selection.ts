import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { ensureHomeConfig, type HomeConfigPathOptions, resolveHomeConfigPath } from '../config/home-config.js'
import { journalDirectory } from '../diagnostics/journal.js'
import { launchFingerprint } from './launch-fingerprint.js'
import type { CordisXManagedInvocation } from './parse.js'
import { resolveProfileSelection } from './profiles.js'
import type { CordisXCliRuntime } from './run-support.js'

/** Resolve a launch and its owner under the same profile and configuration. */
export async function selectionFor(invocation: CordisXManagedInvocation, runtime: CordisXCliRuntime) {
  const environment = runtime.env ?? process.env
  const requestedCwd = runtime.cwd ?? process.cwd()
  const cwd = await realpath(requestedCwd).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return path.resolve(requestedCwd)
  })
  const options: HomeConfigPathOptions = {
    env: environment,
    ...(runtime.homedir === undefined ? {} : { homedir: runtime.homedir }),
  }
  const configPath = resolveHomeConfigPath(options)
  const config = await ensureHomeConfig(options)
  const appId = invocation.app ?? config.defaultApp
  if (
    invocation.mode === 'service' && ['start', 'restart'].includes(invocation.action) && appId !== config.defaultApp
  ) {
    throw new Error(
      'Service mode uses the default App namespace for plugin management; omit the App or use ' + config.defaultApp,
    )
  }
  const selection = await resolveProfileSelection({
    config,
    configPath,
    appId,
    ...(invocation.profile === undefined ? {} : { profileId: invocation.profile }),
    ...(invocation.dataMode === undefined ? {} : { dataMode: invocation.dataMode }),
  })
  const source = await readFile(configPath, 'utf8')
  return {
    environment,
    cwd,
    configPath,
    appId,
    selection,
    journalDirectory: journalDirectory(
      path.dirname(configPath),
      invocation.mode === 'service' ? 'service:' + appId : appId,
      selection.profileId,
    ),
    fingerprint: invocation.mode === 'service' ? 'service' : launchFingerprint({
      source,
      options: invocation.options,
      hostArgs: invocation.hostArgs,
      dataMode: selection.dataMode,
      cwd,
      ...(environment.CODEX_HOME ? { codexHome: path.resolve(cwd, environment.CODEX_HOME) } : {}),
    }),
  }
}
