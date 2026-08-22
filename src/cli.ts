#!/usr/bin/env node
import path from 'node:path'
import { parseArgs } from 'node:util'
import { buildRendererBundle } from './launcher/bundle.js'
import { watchAndInject } from './launcher/cdp.js'
import { loadConfig } from './launcher/config.js'
import {
  findFreeLoopbackPort,
  launchCodex,
  prepareIsolatedCodexProfile,
  resolveCodexExecutable,
  terminateIsolatedCodex,
  type IsolatedCodexProfile,
} from './launcher/process.js'

function waitForExit(child: ReturnType<typeof launchCodex>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0 || signal !== null) resolve()
      else reject(new Error(`Codex exited with status ${String(code)}`))
    })
  })
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: true,
    options: {
      attach: { type: 'boolean', default: false },
      config: { type: 'string', short: 'c', default: 'cordisx.config.json' },
      'debug-port': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      executable: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      isolated: { type: 'boolean', default: false },
      'online-devtools': { type: 'boolean', default: false },
      'profile-dir': { type: 'string' },
      system: { type: 'boolean', default: false },
    },
  })
  if (parsed.values.help) {
    console.log('Usage: cordisx [--config path] [--system | --attach] [--profile-dir path] [--online-devtools] [--executable path] [--debug-port port] [--dry-run] [-- Codex args]')
    return
  }
  if (parsed.values.system && parsed.values.isolated) throw new Error('--system and --isolated cannot be used together')
  if (parsed.values.attach && (parsed.values.isolated || parsed.values['profile-dir'] !== undefined)) {
    throw new Error('--attach cannot be combined with --isolated or --profile-dir')
  }
  const isolated = !parsed.values.attach && !parsed.values.system

  const configPath = path.resolve(parsed.values.config)
  const config = await loadConfig(configPath)
  const debugPort = parsed.values['debug-port'] === undefined
    ? isolated ? await findFreeLoopbackPort() : config.codex.debugPort
    : Number(parsed.values['debug-port'])
  if (!Number.isInteger(debugPort) || debugPort < 1024 || debugPort > 65535) {
    throw new Error('--debug-port must be an integer between 1024 and 65535')
  }
  const source = await buildRendererBundle(config)
  const enabled = config.plugins.filter(plugin => plugin.enabled).map(plugin => plugin.id)
  console.log(`[cordisx] bundle ready: ${source.length} bytes, plugins: ${enabled.join(', ') || '(none)'}`)
  if (parsed.values['dry-run']) return

  const controller = new AbortController()
  const stop = (): void => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  const watcher = watchAndInject({
    port: debugPort,
    source,
    signal: controller.signal,
    onStatus: message => console.log(`[cordisx] ${message}`),
  })
  let isolatedProfile: IsolatedCodexProfile | undefined
  let launched: ReturnType<typeof launchCodex> | undefined
  try {
    if (parsed.values.attach) {
      await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true }))
    } else {
      const executable = await resolveCodexExecutable(parsed.values.executable ?? config.codex.executable)
      if (isolated) {
        isolatedProfile = await prepareIsolatedCodexProfile(config.rootDir, parsed.values['profile-dir'])
        console.log(`[cordisx] isolated Chromium profile: ${isolatedProfile.userDataDir}`)
        console.log('[cordisx] sharing the current HOME and CODEX_HOME with an independent Codex/app-server process')
      }
      console.log(`[cordisx] launching ${executable} with CDP 127.0.0.1:${debugPort}`)
      launched = launchCodex(
        executable,
        debugPort,
        parsed.positionals,
        isolatedProfile,
        parsed.values['online-devtools'],
      )
      await Promise.race([
        waitForExit(launched),
        new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true })),
      ])
    }
  } finally {
    controller.abort()
    await watcher
    if (isolatedProfile !== undefined && launched !== undefined) await terminateIsolatedCodex(launched)
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}

main().catch((error) => {
  console.error(`[cordisx] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
