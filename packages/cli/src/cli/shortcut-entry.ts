import { access, lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseCordisXCli } from './parse.js'
import { runSupervisorCommand } from './supervisor-command.js'
import { hasMatchingProcessIdentity } from './supervisor-state.js'
import { readPrivateJson } from '../shortcuts/store.js'
import { type ShortcutRuntime, validRecord } from '../shortcuts/model.js'
import { nativeOperation } from '../shortcuts/native.js'

export async function openShortcut(recordPath: string): Promise<{
  ok: true
  hostPid: number
  hostStartedAt: string
  warning?: string
}> {
  const record = await readPrivateJson(recordPath)
  if (!validRecord(record)) throw new Error('Invalid shortcut record')
  const invocation = parseCordisXCli(record.argv)
  if (
    invocation.action !== 'start' || invocation.createShortcut || invocation.options.attach || invocation.options.system
    || invocation.hostArgs.length || invocation.app !== record.appId || invocation.profile !== record.profileId
    || (record.dataMode !== undefined && invocation.dataMode !== record.dataMode)
  ) throw new Error('Invalid shortcut launch intent')
  await access(record.cwd).catch(() => {
    throw new Error('Saved working directory no longer exists')
  })
  const configPath = path.join(record.cordisxHome, 'config.json')
  const stat = await lstat(configPath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid CordisX configuration')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  if (!Object.hasOwn(config.apps?.[record.appId]?.profiles ?? {}, record.profileId)) {
    throw new Error('This launch profile was deleted; recreate it explicitly before using this entry')
  }
  const runtime = await readPrivateJson(record.runtimePath) as ShortcutRuntime
  if (
    runtime.schemaVersion !== 1 || await realpath(runtime.node) !== await realpath(process.execPath)
    || runtime.entryScript !== fileURLToPath(import.meta.url)
  ) throw new Error('Shortcut runtime changed; regenerate the entry from the selected installation')
  const ready = await runSupervisorCommand(invocation, {
    cwd: record.cwd,
    env: {
      ...process.env,
      CORDISX_HOME: record.cordisxHome,
      ...(record.codexHome ? { CODEX_HOME: record.codexHome } : {}),
    },
    stdout: () => {},
    internalShortcutDockRecordPath: recordPath,
    internalShortcutSpawnCwd: os.homedir(),
  })
  if (!ready) throw new Error('No ready Host instance returned')
  const state = ready.state
  if (
    !state.hostPid || !state.hostProcessStartedAt
    || !await hasMatchingProcessIdentity(state.hostPid, state.hostProcessStartedAt)
  ) {
    return {
      ok: true,
      hostPid: state.hostPid ?? 0,
      hostStartedAt: state.hostProcessStartedAt ?? '',
      warning: '应用已运行，未能确认对应窗口，未切到前台。',
    }
  }
  const activated = await nativeOperation<{ activated: boolean }>({
    operation: 'activate',
    pid: state.hostPid,
    startedAt: state.hostProcessStartedAt,
  }).catch(() => ({ activated: false }))
  return activated.activated
    ? { ok: true, hostPid: state.hostPid, hostStartedAt: state.hostProcessStartedAt }
    : {
      ok: true,
      hostPid: state.hostPid,
      hostStartedAt: state.hostProcessStartedAt,
      warning: '应用已运行，未能切到前台。',
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await openShortcut(process.argv[2] ?? '').catch(error => ({
    ok: false,
    error: error instanceof Error ? error.message : 'Unable to launch shortcut',
  }))
  process.stdout.write(JSON.stringify(result) + '\n')
  if (!result.ok) process.exitCode = 1
}
