import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { appendRunnerCleanup, cleanupIsolatedSmokeHome, prepareIsolatedSmokeHome } from './isolated-smoke-home.mjs'
import { desktopAgentSessionRendererTimeoutMs } from './desktop-agent-session-harness-report.mjs'

function value(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`${name} is required`)
  return process.argv[index + 1]
}

function optionalValue(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  if (index + 1 >= process.argv.length) throw new Error(`${name} requires a value`)
  return process.argv[index + 1]
}

const separator = process.argv.indexOf('--')
if (separator < 0) throw new Error('separate live-smoke arguments with --')
const port = Number(value('--port'))
const profileDir = value('--profile-dir')
const devConfig = optionalValue('--dev-config')
const homeConfig = optionalValue('--home-config')
const connectorHarness = process.argv.includes('--connector-harness')
const desktopAgentSessionHarness = process.argv.includes('--desktop-agent-session-harness')
const pluginBundleHarness = process.argv.includes('--plugin-bundle-harness')
const connectorHarnessPolicy = optionalValue('--connector-harness-policy') ?? 'allow'
const connectorHarnessScenario = optionalValue('--connector-harness-scenario') ?? 'flow'
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port must be an unprivileged TCP port')
if (devConfig !== undefined && homeConfig !== undefined) throw new Error('--dev-config and --home-config are mutually exclusive')
if (homeConfig !== undefined && !path.isAbsolute(homeConfig)) throw new Error('--home-config must be an absolute config path')
if (connectorHarness && (devConfig !== undefined || homeConfig !== undefined)) throw new Error('--connector-harness owns its fixed temporary Home composition')
if (connectorHarness && pluginBundleHarness) throw new Error('--connector-harness and --plugin-bundle-harness are mutually exclusive')
if (pluginBundleHarness && homeConfig === undefined) throw new Error('--plugin-bundle-harness requires --home-config')
if (desktopAgentSessionHarness && (connectorHarness || pluginBundleHarness || devConfig === undefined || homeConfig !== undefined)) {
  throw new Error('--desktop-agent-session-harness requires --dev-config and cannot be combined with another harness or --home-config')
}
if (!['allow', 'deny', 'default'].includes(connectorHarnessPolicy)) throw new Error('--connector-harness-policy must be allow, deny, or default')
if (!['flow', 'unsubscribe', 'owner-replay', 'owner-live'].includes(connectorHarnessScenario)) throw new Error('--connector-harness-scenario is invalid')
const smokeArgs = process.argv.slice(separator + 1)
const reportIndex = smokeArgs.indexOf('--report')
const reportPath = reportIndex >= 0 ? smokeArgs[reportIndex + 1] : undefined

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

async function waitForExit(child, milliseconds) {
  if (exited(child)) return true
  return await new Promise(resolve => {
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(false) }, milliseconds)
    const onExit = () => { clearTimeout(timer); resolve(true) }
    child.once('exit', onExit)
  })
}

async function stop(child) {
  if (exited(child)) return
  signal(child, 'SIGINT')
  if (await waitForExit(child, 5_000)) return
  signal(child, 'SIGTERM')
  if (await waitForExit(child, 5_000)) return
  signal(child, 'SIGKILL')
  await waitForExit(child, 2_000)
}

function signal(child, name) {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, name)
      return
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  }
  child.kill(name)
}

function profileProcesses() {
  if (process.platform === 'win32') return []
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map(line => line.trim().match(/^(\d+)\s+(.*)$/))
    .filter(match => match !== null && match[2].includes(`--user-data-dir=${profileDir}`))
    .map(match => ({ pid: Number(match[1]), command: match[2] }))
}

async function crashpadCount() {
  const entries = await readdir(`${profileDir}/Crashpad/pending`).catch(error => {
    if (error?.code === 'ENOENT') return []
    throw error
  })
  return entries.filter(entry => entry.endsWith('.dmp')).length
}

async function cordisxReady(target) {
  if (typeof target.webSocketDebuggerUrl !== 'string') return false
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('renderer readiness evaluation timed out')), 500)
      socket.addEventListener('message', event => {
        const message = JSON.parse(String(event.data))
        if (message.id !== 1) return
        clearTimeout(timer)
        resolve(message.result?.result?.value === true)
      })
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
        expression: "document.documentElement.dataset.cordisxReady === 'true' && globalThis.__cordisxRuntime !== undefined",
        returnByValue: true,
      } }))
    })
    return result
  } finally {
    socket.close()
  }
}

async function waitForRenderer() {
  const startedAt = Date.now()
  const timeoutMs = pluginBundleHarness ? 300_000 : desktopAgentSessionRendererTimeoutMs(desktopAgentSessionHarness)
  let targetObserved = false
  while (Date.now() - startedAt < timeoutMs) {
    if (exited(launcher)) throw new Error(`isolated launcher exited before renderer readiness (status ${String(launcher.exitCode)})`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(Math.min(500, Math.max(1, timeoutMs - (Date.now() - startedAt)))),
      })
      if (response.ok) {
        const target = (await response.json()).find(item => item.url === 'app://-/index.html')
        if (target !== undefined && !targetObserved) {
          targetObserved = true
          harnessStage('injection-target-observed', startedAt)
        }
        if (target !== undefined && await cordisxReady(target)) {
          harnessStage('renderer-ready', startedAt)
          return
        }
      }
    } catch {}
    const remaining = timeoutMs - (Date.now() - startedAt)
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(250, remaining)))
  }
  throw new Error(`isolated app:// renderer did not become available within ${Math.round(timeoutMs / 1_000)} seconds`)
}

function harnessStage(stage, startedAt) {
  if (!desktopAgentSessionHarness) return
  console.log(`[cordisx-desktop-agent-session-stage] ${JSON.stringify({ stage, elapsedMs: Date.now() - startedAt })}`)
}

const crashpadBefore = await crashpadCount()
let connectorHarnessRoot
let effectiveHomeConfig = homeConfig
if (connectorHarness) {
  connectorHarnessRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-connector-harness-config-'))
  const fixtures = path.resolve('tests/fixtures')
  const fixtureEntries = [
    ['connector-harness-flow', 'connector-production-flow.ts'],
    ['connector-harness-unsubscribe', 'connector-production-unsubscribe.ts'],
    ['connector-harness-owner-replay', 'connector-production-owner-replay.ts'],
    ['connector-harness-owner-live', 'connector-production-owner-live.ts'],
  ]
  const plugins = fixtureEntries
    .filter(([id]) => id === `connector-harness-${connectorHarnessScenario}`)
    .map(([id, entry]) => ({ id, entry: path.join(fixtures, entry), enabled: true, config: {} }))
  const permissions = connectorHarnessPolicy === 'default' ? [] : plugins.flatMap(plugin => ['agent.events.read', 'agent.messages.append'].map(capability => ({
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-policy.v1.schema.json',
    schemaVersion: 1,
    key: {
      profileId: 'smoke',
      identity: { source: pathToFileURL(plugin.entry).href, pluginId: plugin.id },
      capability,
      scope: {},
    },
    policy: connectorHarnessPolicy,
  })))
  effectiveHomeConfig = path.join(connectorHarnessRoot, 'config.json')
  await writeFile(effectiveHomeConfig, `${JSON.stringify({
    version: 1,
    defaultApp: 'codex',
    providers: [], plugins, permissions, publisherGrantIssuers: [],
    apps: { codex: { defaultProfile: 'smoke', profiles: { smoke: { displayName: 'Connector smoke', dataMode: 'shared' } } } },
  }, null, 2)}\n`, { mode: 0o600 })
}
const homeRoot = connectorHarness
  ? await prepareIsolatedSmokeHome(effectiveHomeConfig)
  : homeConfig === undefined ? undefined : await prepareIsolatedSmokeHome(homeConfig)
const invocation = connectorHarness
  ? ['codex', 'smoke', '--data', 'shared']
  : pluginBundleHarness ? ['codex', 'smoke', '--data', 'shared']
  : devConfig === undefined
  ? ['codex', 'smoke', '--data', 'host-isolated']
  : ['dev', '--config', devConfig]
const cliEntry = connectorHarness ? 'tests/fixtures/connector-production-smoke-cli.ts' : 'packages/cli/src/cli.ts'
const smokeEntry = connectorHarness
  ? 'tests/fixtures/connector-production-smoke.mjs'
  : pluginBundleHarness
    ? 'tests/fixtures/plugin-bundle-production-smoke.mjs'
    : desktopAgentSessionHarness
      ? 'packages/cli/scripts/codex-desktop-agent-session-smoke.mjs'
      : 'packages/cli/scripts/live-smoke.mjs'
const launcherEnvironment = connectorHarness
  ? { ...process.env, CORDISX_HOME: path.join(homeRoot, '.cordisx') }
  : pluginBundleHarness
    ? { ...process.env, CORDISX_HOME: path.join(homeRoot, '.cordisx') }
  : homeRoot === undefined ? process.env : { ...process.env, HOME: homeRoot }
const launcher = spawn(process.execPath, [
  '--import', 'tsx', cliEntry, ...invocation,
  '--debug-port', String(port), '--profile-dir', profileDir, '--', '--start-minimized',
], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: launcherEnvironment,
  detached: process.platform !== 'win32',
})
harnessStage('launch-started', Date.now())
launcher.stdout.pipe(process.stdout)
launcher.stderr.pipe(process.stderr)
let smoke
const interrupt = () => {
  if (smoke !== undefined) signal(smoke, 'SIGINT')
  signal(launcher, 'SIGINT')
}
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)

let result = 1
try {
  await waitForRenderer()
  result = await new Promise((resolve, reject) => {
    smoke = spawn(process.execPath, [smokeEntry, '--port', String(port), ...(connectorHarness ? ['--connector-harness-policy', connectorHarnessPolicy, '--connector-harness-scenario', connectorHarnessScenario] : []), ...smokeArgs], {
      stdio: 'inherit',
      env: process.env,
    })
    smoke.once('error', reject)
    smoke.once('exit', code => resolve(code ?? 1))
  })
} finally {
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
  if (smoke !== undefined && !exited(smoke)) await stop(smoke)
  await stop(launcher)
  try {
    await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) })
    throw new Error(`CDP port ${port} still accepts connections after smoke cleanup`)
  } catch (error) {
    if (error instanceof Error && error.message.includes('still accepts')) throw error
  }
  if (process.platform !== 'win32') {
    let active = profileProcesses()
    for (let attempt = 0; attempt < 50 && active.length > 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
      active = profileProcesses()
    }
    if (active.length > 0) {
      for (const processRecord of active) {
        try { process.kill(processRecord.pid, 'SIGKILL') } catch (error) { if (error?.code !== 'ESRCH') throw error }
      }
      await new Promise(resolve => setTimeout(resolve, 100))
      active = profileProcesses()
    }
    if (active.length > 0) {
      throw new Error(`profile ${profileDir} still has active Electron processes after smoke cleanup: ${active.map(item => item.pid).join(',')}`)
    }
  }
  const crashpadAfter = await crashpadCount()
  if (crashpadAfter !== crashpadBefore) {
    throw new Error(`Crashpad pending dump count changed during smoke: ${crashpadBefore} -> ${crashpadAfter}`)
  }
  // Renderer descendants can keep writing into CODEX_HOME briefly after the
  // launcher exits. Prove that the profile process tree is gone before
  // removing its isolated HOME, then tolerate transient filesystem races.
  const homeCleanup = await cleanupIsolatedSmokeHome(homeRoot)
  if (connectorHarnessRoot !== undefined) await rm(connectorHarnessRoot, { recursive: true, force: true })
  const cleanup = {
    port,
    portClosed: true,
    profileDir,
    profileProcesses: 0,
    crashpadBefore,
    crashpadAfter,
    ...homeCleanup,
  }
  await appendRunnerCleanup(reportPath, cleanup)
  console.log(`[cordisx-smoke-cleanup] ${JSON.stringify(cleanup)}`)
}

process.exitCode = result
