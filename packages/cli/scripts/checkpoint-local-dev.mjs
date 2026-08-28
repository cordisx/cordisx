#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import {
  REPORT_SCHEMA, ensurePrivateDirectory, findNamed, freeLoopbackPort, invariantProjection,
  mode, parseCheckpointArgs, pathExists, rendererGenerationProjection, repositoryStatus,
  sha256, snapshotRuntimePaths,
} from './checkpoint-local-dev-lib.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const defaultRepoRoot = path.resolve(scriptDir, '../../..')
const usage = `Usage: npm run checkpoint:local-dev:app -- --executable <absolute Codex executable> [options]\n\nOptions:\n  --artifacts <absolute directory>  New runner-owned checkpoint/evidence root\n  --repo-root <absolute directory>  Owning Host repository (default: current package root)\n  --cli <absolute dist cli.js>      Run this built JavaScript entry with Node\n  --cli-bin <absolute executable>   Run this packed/installed cordisx binary\n  --timeout-ms <5000..120000>       Per-generation timeout (default: 30000)\n`

let options
try {
  options = parseCheckpointArgs(process.argv.slice(2), { 'repo-root': defaultRepoRoot })
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  console.error(usage)
  process.exit(2)
}
if (options.help) {
  console.log(usage)
  process.exit(0)
}

const repoRoot = options['repo-root']
const executable = options.executable
const timeoutMs = options.timeoutMs
if (options.artifacts !== undefined && await pathExists(options.artifacts)) {
  throw new Error(`--artifacts must name a new runner-owned directory: ${options.artifacts}`)
}
const checkpointRoot = options.artifacts === undefined
  ? await mkdtemp(path.join(os.tmpdir(), 'cordisx-local-dev-checkpoint-'))
  : path.resolve(options.artifacts)
const artifacts = path.join(checkpointRoot, 'artifacts')
const sourceRoot = path.join(checkpointRoot, 'plugin')
const entry = path.join(sourceRoot, 'index.ts')
const cordisxHome = path.join(checkpointRoot, 'cordisx-home')
const reportPath = path.join(artifacts, 'checkpoint-report.json')
const logPath = path.join(artifacts, 'launcher.log')
const initialScreenshotPath = path.join(artifacts, 'dev1-manager-runtime.png')
const failedScreenshotPath = path.join(artifacts, 'failed-manager-runtime.png')
const finalScreenshotPath = path.join(artifacts, 'final-manager-runtime.png')
const port = await freeLoopbackPort()

await Promise.all([
  ensurePrivateDirectory(checkpointRoot), ensurePrivateDirectory(artifacts),
  ensurePrivateDirectory(sourceRoot), ensurePrivateDirectory(cordisxHome),
])
await chmod(checkpointRoot, 0o700)

const fixture = label => `export const name = ${JSON.stringify(`Checkpoint ${label}`)}\nexport const inject = []\nexport function apply() { globalThis.__cordisxLocalDevCheckpoint = ${JSON.stringify(label)} }\n`
await writeFile(path.join(sourceRoot, 'package.json'), '{"name":"cordisx-local-dev-checkpoint","version":"1.0.0","type":"module"}\n', { mode: 0o600 })
await writeFile(entry, fixture('DEV-1'), { mode: 0o600 })

const repoStateBefore = repositoryStatus(repoRoot)
const protectedRepoPaths = ['.cordisx', 'state', 'projects'].map(name => path.join(repoRoot, name))
const protectedRepoBefore = await Promise.all(protectedRepoPaths.map(async target => ({ target, exists: await pathExists(target) })))
const cwdStatePath = path.join(checkpointRoot, 'state')
const repoRuntimeTargets = [
  '.cordisx', 'state', 'projects', 'artifacts', 'cordisx.config.json',
  'config/ui-demos/apps', 'config/ui-demos/cache', 'config/ui-demos/state',
]
const cwdRuntimeTargets = ['.cordisx', 'state', 'projects', 'cordisx.config.json']
const runtimeFilesBefore = {
  repo: await snapshotRuntimePaths(repoRoot, repoRuntimeTargets),
  cwd: await snapshotRuntimePaths(checkpointRoot, cwdRuntimeTargets),
}
const cliEntry = options.cli ?? path.join(repoRoot, 'packages/cli/dist/src/cli.js')
const invocation = options['cli-bin'] === undefined
  ? { command: process.execPath, args: [cliEntry] }
  : { command: options['cli-bin'], args: [] }
if (!await pathExists(invocation.command)) throw new Error(`CLI command does not exist: ${invocation.command}`)
if (options['cli-bin'] === undefined && !await pathExists(cliEntry)) {
  throw new Error(`built CLI does not exist: ${cliEntry}; run npm run build --workspace=cordisx`)
}
if (!await pathExists(executable)) throw new Error(`Codex executable does not exist: ${executable}`)

const logFd = openSync(logPath, 'a', 0o600)
const launcher = spawn(invocation.command, [
  ...invocation.args, 'dev', entry, '--debug-port', String(port), '--executable', executable,
], {
  cwd: checkpointRoot,
  detached: process.platform !== 'win32',
  env: { ...process.env, CORDISX_HOME: cordisxHome },
  stdio: ['ignore', logFd, logFd],
})
const startedAt = new Date().toISOString()
const report = {
  $schema: REPORT_SCHEMA,
  schemaVersion: 1,
  result: 'failed',
  startedAt,
  inputs: {
    repoRoot, repoHead: execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    executable, cliMode: options['cli-bin'] === undefined ? 'workspace-build' : 'packed-binary',
    cli: options['cli-bin'] ?? cliEntry, checkpointRoot, sourceRoot, entry, cordisxHome, port,
  },
  processes: { runner: { pid: process.pid }, launcher: { pid: launcher.pid ?? null }, port },
  stages: {},
  artifacts: {
    report: reportPath, launcherLog: logPath,
    initialScreenshot: initialScreenshotPath, failedScreenshot: failedScreenshotPath,
    finalScreenshot: finalScreenshotPath,
  },
}

let launcherExit
launcher.once('exit', (code, signal) => { launcherExit = { code, signal } })
const interrupted = () => { void stopLauncher() }
process.once('SIGINT', interrupted)
process.once('SIGTERM', interrupted)

function signalLauncher(signal) {
  if (launcherExit !== undefined) return
  if (process.platform !== 'win32' && launcher.pid !== undefined) {
    try { process.kill(-launcher.pid, signal); return } catch (error) { if (error?.code !== 'ESRCH') throw error }
  }
  launcher.kill(signal)
}

async function waitForExit(milliseconds) {
  if (launcherExit !== undefined) return true
  return await new Promise(resolve => {
    const timer = setTimeout(() => { launcher.off('exit', onExit); resolve(false) }, milliseconds)
    const onExit = () => { clearTimeout(timer); resolve(true) }
    launcher.once('exit', onExit)
  })
}

async function stopLauncher() {
  if (launcherExit !== undefined) return
  signalLauncher('SIGINT')
  if (await waitForExit(5_000)) return
  signalLauncher('SIGTERM')
  if (await waitForExit(5_000)) return
  signalLauncher('SIGKILL')
  await waitForExit(2_000)
}

class CdpClient {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map() }
  async open() {
    this.socket = new WebSocket(this.url)
    await new Promise((resolve, reject) => { this.socket.once('open', resolve); this.socket.once('error', reject) })
    this.socket.on('message', data => {
      const message = JSON.parse(data.toString())
      if (message.id === undefined) return
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result ?? {})
    })
    return this
  }
  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }), error => {
        if (error == null) return
        this.pending.delete(id); reject(error)
      })
    })
  }
  async value(expression, awaitPromise = false) {
    const response = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
    if (response.exceptionDetails !== undefined) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'CDP evaluation failed')
    return response.result?.value
  }
  close() { this.socket?.close() }
}

async function targetList() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(750) })
  if (!response.ok) throw new Error(`CDP target list returned HTTP ${response.status}`)
  return await response.json()
}

async function waitForTarget(id) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (launcherExit !== undefined) throw new Error(`launcher exited early: ${JSON.stringify(launcherExit)}`)
    try {
      const target = (await targetList()).find(item => item.type === 'page' && item.url === 'app://-/index.html' && (id === undefined || item.id === id))
      if (target?.webSocketDebuggerUrl !== undefined) {
        const client = await new CdpClient(target.webSocketDebuggerUrl).open()
        const ready = await client.value("document.documentElement.dataset.cordisxReady === 'true' && globalThis.__cordisxRuntime !== undefined")
        if (ready === true) return { target, client }
        client.close()
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`app:// renderer did not become ready${id === undefined ? '' : `: ${id}`}`)
}

async function waitFor(client, expression, predicate, label) {
  const deadline = Date.now() + timeoutMs
  let value
  while (Date.now() < deadline) {
    value = await client.value(expression, true)
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(`${label} did not settle: ${JSON.stringify(value)}`)
}

const stateExpression = `(() => {
  const runtime = globalThis.__cordisxRuntime
  const snapshot = runtime?.snapshot?.()
  const plugin = snapshot?.plugins?.find(item => item.id === 'index')
  const activation = runtime?.activePluginGeneration?.()
  const raw = JSON.stringify(snapshot)
  const development = document.querySelector('[data-plugin-development]')
  const detail = document.querySelector('[data-plugin-detail="index"]')
  const privatePath = development?.querySelector('code')?.textContent ?? null
  const privateState = development?.getAttribute('data-plugin-development') ?? null
  return {
    ready: document.documentElement.dataset.cordisxReady === 'true',
    plugin: plugin === undefined ? null : { id: plugin.id, name: plugin.name, status: plugin.status, package: plugin.package ?? null },
    activation: activation?.plugins?.find(item => item.id === 'index') ?? null,
    runtimeGeneration: activation?.runtimeGeneration ?? null,
    lifecycleRevision: activation?.revision ?? null,
    activationLastGoodRevision: activation?.lastGoodRevision ?? null,
    configRevision: plugin?.configuration?.revision ?? null,
    configLastGoodRevision: plugin?.configuration?.lastGoodRevision ?? null,
    publicPrivacy: { sourcePathAbsent: !raw.includes(${JSON.stringify(entry)}), localDevelopmentAbsent: !raw.includes('localDevelopment'), developmentOwnProperty: plugin === undefined ? null : Object.hasOwn(plugin, 'development') },
    manager: { detailOpen: detail !== null, sourcePath: privatePath, state: privateState, pathVisible: privatePath === ${JSON.stringify(entry)} && development?.getClientRects().length > 0 },
    dialogs: { permission: document.querySelectorAll('[data-permission-authorization]').length, lifecycle: document.querySelectorAll('.cxm-lifecycle-overlay').length },
  }
})()`

async function openManagerRuntime(client) {
  await client.value(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
    const trigger = document.querySelector('[data-cordisx-manager-trigger]')
    if (!(trigger instanceof HTMLElement)) throw new Error('Manager trigger unavailable')
    if (document.querySelector('[data-cordisx-manager-modal]') === null) trigger.click()
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const plugin = document.querySelector('[data-plugin-id="index"]')
      if (plugin instanceof HTMLElement) { plugin.click(); break }
      await wait(50)
    }
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const runtime = document.querySelector('[data-plugin-detail-tab="runtime"]')
      if (runtime instanceof HTMLElement) { runtime.click(); break }
      await wait(50)
    }
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (document.querySelector('[data-plugin-development]') !== null) return true
      await wait(50)
    }
    return false
  })()`, true)
  return await waitFor(client, stateExpression, value => value.manager.pathVisible && value.manager.state !== null, 'Manager private local-dev projection')
}

async function capture(client, targetPath) {
  const response = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true })
  if (typeof response.data !== 'string') throw new Error('CDP returned no screenshot')
  await writeFile(targetPath, Buffer.from(response.data, 'base64'), { mode: 0o600 })
}

function assertStateSafety(state, label) {
  if (!state.publicPrivacy.sourcePathAbsent || !state.publicPrivacy.localDevelopmentAbsent || state.publicPrivacy.developmentOwnProperty !== false) {
    throw new Error(`${label} public snapshot leaked local development data: ${JSON.stringify(state.publicPrivacy)}`)
  }
  if (state.dialogs.permission !== 0 || state.dialogs.lifecycle !== 0) {
    throw new Error(`${label} left an interactive dialog open: ${JSON.stringify(state.dialogs)}`)
  }
}

async function applicationPids() {
  if (process.platform === 'win32') return []
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
    .map(line => line.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean)
    .filter(match => match[2].includes(`--remote-debugging-port=${port}`))
    .map(match => ({ pid: Number(match[1]), command: match[2] }))
}

function processTable() {
  if (process.platform === 'win32') return []
  return execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' }).split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
    return match === null ? [] : [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] }]
  })
}

function processInventory(profilePath) {
  const table = processTable()
  const launcherPid = launcher.pid
  const descendants = []
  const included = new Set(launcherPid === undefined ? [] : [launcherPid])
  let changed = true
  while (changed) {
    changed = false
    for (const processRecord of table) {
      if (!included.has(processRecord.ppid) || included.has(processRecord.pid)) continue
      included.add(processRecord.pid)
      descendants.push(processRecord)
      changed = true
    }
  }
  const launcherRecord = table.find(item => item.pid === launcherPid)
  const profileProcesses = profilePath === undefined ? [] : table.filter(item => item.command.includes(profilePath))
  const appProcesses = profileProcesses.filter(item => item.command.includes(`--remote-debugging-port=${port}`))
  return {
    launcher: launcherRecord ?? (launcherPid === undefined ? null : { pid: launcherPid, ppid: null, pgid: null, command: null }),
    descendants,
    appProcesses,
    profileProcesses,
    processGroupIds: [...new Set([launcherRecord?.pgid, ...appProcesses.map(item => item.pgid)].filter(Number.isInteger))].sort((left, right) => left - right),
  }
}

let main
let browser
let secondary
let secondaryId
let primaryError
try {
  main = await waitForTarget()
  await main.client.send('Page.enable')
  const initial = await waitFor(main.client, stateExpression, value => value.plugin?.name === 'Checkpoint DEV-1' && value.plugin.status === 'active', 'DEV-1 generation')
  const initialManager = await openManagerRuntime(main.client)
  assertStateSafety(initialManager, 'DEV-1')
  report.stages.dev1 = { state: initialManager, sha256: sha256(initialManager) }
  await capture(main.client, initialScreenshotPath)

  await writeFile(entry, "export const name = 'Checkpoint BROKEN\n", { mode: 0o600 })
  const failed = await waitFor(main.client, stateExpression, value => value.manager.state === 'failed', 'syntax failure')
  assertStateSafety(failed, 'failed generation')
  const invariantsPassed = JSON.stringify(invariantProjection(failed)) === JSON.stringify(invariantProjection(initialManager))
  if (!invariantsPassed) throw new Error('syntax failure changed the last-good projection')
  report.stages.failed = { state: failed, lastGoodRetained: true, sha256: sha256(failed) }
  await capture(main.client, failedScreenshotPath)

  await writeFile(entry, fixture('DEV-2'), { mode: 0o600 })
  const dev2 = await waitFor(main.client, stateExpression, value => value.plugin?.name === 'Checkpoint DEV-2' && value.manager.state === 'ready', 'DEV-2 recovery')
  assertStateSafety(dev2, 'DEV-2')
  if (dev2.activation?.digest === initial.activation?.digest) throw new Error('DEV-2 did not publish a new digest')
  report.stages.dev2 = { state: dev2, recoveredAutomatically: true, sha256: sha256(dev2) }

  const version = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) }).then(response => response.json())
  browser = await new CdpClient(version.webSocketDebuggerUrl).open()
  const created = await browser.send('Target.createTarget', { url: 'app://-/index.html' })
  secondaryId = created.targetId
  secondary = await waitForTarget(secondaryId)
  const secondaryState = await waitFor(secondary.client, stateExpression, value => value.plugin?.name === 'Checkpoint DEV-2' && value.plugin.status === 'active' && value.publicPrivacy.sourcePathAbsent, 'second renderer generation')
  assertStateSafety(secondaryState, 'second renderer')
  const primaryDev2Generation = rendererGenerationProjection(dev2)
  const secondaryDev2Generation = rendererGenerationProjection(secondaryState)
  if (JSON.stringify(primaryDev2Generation) !== JSON.stringify(secondaryDev2Generation)) {
    throw new Error(`second renderer generation differs from primary DEV-2: ${JSON.stringify({ primaryDev2Generation, secondaryDev2Generation })}`)
  }
  await browser.send('Target.closeTarget', { targetId: secondaryId })
  secondary.client.close(); secondary = undefined
  const secondaryGoneDeadline = Date.now() + 5_000
  while (Date.now() < secondaryGoneDeadline && (await targetList()).some(item => item.id === secondaryId)) await new Promise(resolve => setTimeout(resolve, 100))
  if ((await targetList()).some(item => item.id === secondaryId)) throw new Error(`secondary renderer remained open: ${secondaryId}`)

  await writeFile(entry, fixture('DEV-3'), { mode: 0o600 })
  const dev3 = await waitFor(main.client, stateExpression, value => value.plugin?.name === 'Checkpoint DEV-3' && value.manager.state === 'ready', 'post-secondary DEV-3 generation')
  assertStateSafety(dev3, 'post-secondary DEV-3')
  report.stages.multiRenderer = {
    targetId: secondaryId, joined: secondaryState, closed: true,
    exactDev2GenerationMatch: true, primaryDev2Generation, secondaryDev2Generation,
    postCloseGeneration: dev3, sha256: sha256({ secondaryState, dev3 }),
  }
  await capture(main.client, finalScreenshotPath)

  const grants = await findNamed(cordisxHome, 'direct-device-bound.v1.json')
  const profiles = await findNamed(cordisxHome, 'codex-app-profile')
  if (grants.length !== 1) throw new Error(`expected one publisher grant under CORDISX_HOME, found ${grants.length}`)
  if (profiles.length !== 1) throw new Error(`expected one default profile under CORDISX_HOME, found ${profiles.length}`)
  const grantMode = await mode(grants[0])
  const profileMode = await mode(profiles[0])
  const homeMode = await mode(cordisxHome)
  const stateRoot = path.dirname(path.dirname(grants[0]))
  const stateMode = await mode(stateRoot)
  const root = path.resolve(cordisxHome)
  if (![grants[0], profiles[0], stateRoot].every(target => path.resolve(target).startsWith(`${root}${path.sep}`))) throw new Error('runtime state escaped CORDISX_HOME')
  if (homeMode !== 0o700 || stateMode !== 0o700 || profileMode !== 0o700 || grantMode !== 0o600) {
    throw new Error(`unexpected runtime modes: home=${homeMode.toString(8)} state=${stateMode.toString(8)} profile=${profileMode.toString(8)} grant=${grantMode.toString(8)}`)
  }
  if (await pathExists(cwdStatePath)) throw new Error(`direct-development state polluted CLI cwd: ${cwdStatePath}`)
  const repoStateAfter = repositoryStatus(repoRoot)
  const protectedRepoAfter = await Promise.all(protectedRepoPaths.map(async target => ({ target, exists: await pathExists(target) })))
  if (repoStateAfter !== repoStateBefore || JSON.stringify(protectedRepoAfter) !== JSON.stringify(protectedRepoBefore)) {
    throw new Error('real App checkpoint changed the Host owning repository')
  }
  report.filesystem = {
    home: { path: cordisxHome, mode: '0700' }, state: { path: stateRoot, mode: '0700' },
    publisherGrant: { path: grants[0], mode: '0600' }, profile: { path: profiles[0], mode: '0700' },
    cwdStateAbsent: true, repoStatusUnchanged: true, protectedRepoPathsUnchanged: true,
  }
  report.processes.inventory = processInventory(profiles[0])
  report.processes.launcher.pgid = report.processes.inventory.launcher?.pgid ?? null
  report.processes.profilePath = profiles[0]
  report.artifacts.initialScreenshotSha256 = sha256(await readFile(initialScreenshotPath))
  report.artifacts.failedScreenshotSha256 = sha256(await readFile(failedScreenshotPath))
  report.artifacts.finalScreenshotSha256 = sha256(await readFile(finalScreenshotPath))
  report.result = 'passed'
} catch (error) {
  primaryError = error
  report.error = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) }
} finally {
  secondary?.client.close(); main?.client.close()
  if (secondaryId !== undefined && browser !== undefined) await browser.send('Target.closeTarget', { targetId: secondaryId }).catch(() => undefined)
  browser?.close()
  await stopLauncher()
  closeSync(logFd)
  process.removeListener('SIGINT', interrupted)
  process.removeListener('SIGTERM', interrupted)
  let portClosed = false
  try { await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) }) } catch { portClosed = true }
  const remaining = await applicationPids().catch(() => [])
  const profilePath = report.processes.profilePath
  const beforeInventory = report.processes.inventory
  const afterTable = processTable()
  const processGroupsAfter = beforeInventory === undefined ? [] : afterTable.filter(item => beforeInventory.processGroupIds.includes(item.pgid))
  const profileProcessesAfter = profilePath === undefined ? [] : afterTable.filter(item => item.command.includes(profilePath))
  const finalRepoStatus = repositoryStatus(repoRoot)
  const finalProtectedRepoPaths = await Promise.all(protectedRepoPaths.map(async target => ({ target, exists: await pathExists(target) })))
  const finalCwdStateAbsent = !await pathExists(cwdStatePath)
  const finalRepoUnchanged = finalRepoStatus === repoStateBefore
    && JSON.stringify(finalProtectedRepoPaths) === JSON.stringify(protectedRepoBefore)
  const runtimeFilesAfter = {
    repo: await snapshotRuntimePaths(repoRoot, repoRuntimeTargets),
    cwd: await snapshotRuntimePaths(checkpointRoot, cwdRuntimeTargets),
  }
  const runtimeFilesUnchanged = runtimeFilesAfter.repo.sha256 === runtimeFilesBefore.repo.sha256
    && runtimeFilesAfter.cwd.sha256 === runtimeFilesBefore.cwd.sha256
  report.finishedAt = new Date().toISOString()
  report.cleanup = {
    launcherExited: launcherExit !== undefined, launcherExit: launcherExit ?? null,
    portClosed, remainingAppProcesses: remaining,
    processGroups: { expected: beforeInventory?.processGroupIds ?? [], remaining: processGroupsAfter },
    profile: { path: profilePath ?? null, remaining: profileProcessesAfter },
    retainedEvidenceRoot: checkpointRoot,
    manualCleanup: `After inspecting evidence, remove only this managed root: ${checkpointRoot}`,
  }
  report.cleanup.cwdStateAbsent = finalCwdStateAbsent
  report.cleanup.repoStatusUnchanged = finalRepoUnchanged
  report.cleanup.runtimeFiles = {
    unchanged: runtimeFilesUnchanged,
    before: runtimeFilesBefore,
    after: runtimeFilesAfter,
  }
  const logText = await readFile(logPath, 'utf8')
  const projectionFailures = logText.split('\n').filter(line => line.includes('local-dev status projection failed'))
  report.diagnostics = {
    statusProjectionFailures: projectionFailures.length,
    closedStatusProjectionFailures: projectionFailures.filter(line => line.includes('(CLOSED)')).length,
    nonBlocking: true,
  }
  report.artifacts.launcherLogSha256 = sha256(logText)
  if (!portClosed || remaining.length > 0 || processGroupsAfter.length > 0 || profileProcessesAfter.length > 0
    || !finalCwdStateAbsent || !finalRepoUnchanged || !runtimeFilesUnchanged) {
    report.result = 'failed'
    report.error ??= { message: 'checkpoint cleanup left a process group, profile process, CDP port, cwd state, or owning-repository file change' }
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  console.log(`checkpoint-report=${reportPath}`)
  console.log(JSON.stringify({ result: report.result, report: reportPath, screenshot: finalScreenshotPath, port, cleanup: report.cleanup }, null, 2))
}

if (primaryError !== undefined) throw primaryError
if (report.result !== 'passed') throw new Error(report.error?.message ?? 'local development checkpoint failed')
