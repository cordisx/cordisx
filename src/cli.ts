#!/usr/bin/env node
import path from 'node:path'
import { parseArgs } from 'node:util'
import { buildRendererBundle } from './launcher/bundle.js'
import { watchAndInject } from './launcher/cdp.js'
import { loadConfig } from './launcher/config.js'
import { launchCodex, resolveCodexExecutable } from './launcher/process.js'

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
    },
  })
  if (parsed.values.help) {
    console.log('Usage: cordisx [--config path] [--attach] [--executable path] [--debug-port port] [--dry-run] [-- Codex args]')
    return
  }

  const configPath = path.resolve(parsed.values.config)
  const config = await loadConfig(configPath)
  const debugPort = parsed.values['debug-port'] === undefined
    ? config.codex.debugPort
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
  try {
    if (parsed.values.attach) {
      await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true }))
    } else {
      const executable = await resolveCodexExecutable(parsed.values.executable ?? config.codex.executable)
      console.log(`[cordisx] launching ${executable}`)
      const child = launchCodex(executable, debugPort, parsed.positionals)
      await Promise.race([
        waitForExit(child),
        new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true })),
      ])
    }
  } finally {
    controller.abort()
    await watcher
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}

main().catch((error) => {
  console.error(`[cordisx] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
