#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'

const APP_PIN = Object.freeze({
  bundleId: 'com.openai.codex',
  appVersion: '26.818.61809',
  buildNumber: '7019',
})
const TEMP_PREFIX = 'cordisx-desktop-agent-session-smoke-'

const parsed = parseArgs({ options: {
  report: { type: 'string' },
  marker: { type: 'string' },
  executable: { type: 'string' },
} })
const reportPath = parsed.values.report
if (typeof reportPath !== 'string' || !path.isAbsolute(reportPath)) {
  throw new Error('usage: --report <absolute-json> [--marker <marker>] [--executable <Codex executable>]')
}
const marker = parsed.values.marker ?? `cordisx-live-${Date.now()}`
if (!/^[A-Za-z0-9._-]{1,96}$/u.test(marker)) throw new Error('--marker must be 1 to 96 safe characters')

function executableCandidates() {
  if (parsed.values.executable !== undefined) return [path.resolve(parsed.values.executable)]
  return [
    '/Applications/Codex.app/Contents/MacOS/Codex',
    '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
    path.join(os.homedir(), 'Applications/Codex.app/Contents/MacOS/Codex'),
    path.join(os.homedir(), 'Applications/ChatGPT.app/Contents/MacOS/ChatGPT'),
  ]
}

async function executable() {
  for (const candidate of executableCandidates()) {
    if (await access(candidate).then(() => true, () => false)) return candidate
  }
  throw new Error('installed Codex Desktop executable was not found')
}

function plistValue(appRoot, key) {
  return execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', path.join(appRoot, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim()
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('failed to allocate an ephemeral loopback port')
  await new Promise((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
  return address.port
}

function profileProcesses(profileDir) {
  if (process.platform === 'win32') return []
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .flatMap(line => {
      const match = /^\s*(\d+)\s+(.*)$/u.exec(line)
      return match !== null && match[2].includes(profileDir) ? [{ pid: Number(match[1]), command: match[2] }] : []
    })
}

function run(command, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: environment })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`isolated Desktop harness exited with ${signal ?? `status ${String(code)}`}`))
    })
  })
}

async function annotateReport(value) {
  const existing = JSON.parse(await readFile(reportPath, 'utf8'))
  existing.harness = value
  await writeFile(reportPath, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 })
}

if (process.platform !== 'darwin') throw new Error('the pinned Codex Desktop live harness currently supports macOS only')
const appExecutable = await executable()
const appRoot = path.resolve(appExecutable, '../../..')
const installed = {
  bundleId: plistValue(appRoot, 'CFBundleIdentifier'),
  appVersion: plistValue(appRoot, 'CFBundleShortVersionString'),
  buildNumber: plistValue(appRoot, 'CFBundleVersion'),
}
if (installed.bundleId !== APP_PIN.bundleId || installed.appVersion !== APP_PIN.appVersion
  || installed.buildNumber !== APP_PIN.buildNumber) {
  throw new Error(`installed Desktop build does not match the audited pin: ${JSON.stringify(installed)}`)
}

const root = await mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX))
const profileDir = path.join(root, 'chromium')
const cordisxHome = path.join(root, 'cordisx-home')
const configPath = path.join(root, 'cordisx.config.json')
const port = await freePort()
const sessionId = `cx-session.${crypto.randomUUID()}`
const runner = path.resolve('packages/cli/scripts/run-isolated-app-smoke.mjs')
const fixture = path.resolve('tests/fixtures/codex-desktop-agent-session-smoke.ts')
await mkdir(profileDir, { recursive: true, mode: 0o700 })
await mkdir(cordisxHome, { recursive: true, mode: 0o700 })
await writeFile(configPath, `${JSON.stringify({
  version: 1,
  codex: { debugPort: port, executable: appExecutable },
  providers: [],
  plugins: [{
    id: 'codex-desktop-agent-session-smoke', entry: fixture, enabled: true, config: { marker },
  }],
}, null, 2)}\n`, { mode: 0o600 })

const args = [
  runner,
  '--port', String(port),
  '--profile-dir', profileDir,
  '--dev-config', configPath,
  '--desktop-agent-session-harness',
  '--',
  '--report', reportPath,
  '--marker', marker,
  '--session-id', sessionId,
]
let error
try {
  await run(process.execPath, args, {
    ...process.env,
    // Isolate CordisX test state while deliberately retaining the user's
    // authenticated HOME/CODEX_HOME for the installed Desktop connection.
    CORDISX_HOME: cordisxHome,
  })
} catch (cause) {
  error = cause
} finally {
  const active = profileProcesses(profileDir)
  const annotation = {
    app: installed,
    appExecutable,
    rendererUrl: 'app://-/index.html',
    port,
    profileDir,
    sessionId,
    sharedHome: process.env.HOME ?? null,
    sharedCodexHome: process.env.CODEX_HOME ?? null,
    isolatedCordisxHome: cordisxHome,
    secondProviderStarted: false,
    appAsarPatched: false,
    profileProcessesAfterRunner: active.length,
    temporaryRootRemoved: active.length === 0,
  }
  await annotateReport(annotation).catch(async annotateError => {
    if (error === undefined) error = annotateError
  })
  if (active.length === 0) await rm(root, { recursive: true, force: true })
  else if (error === undefined) error = new Error(`isolated profile still has active processes: ${active.map(item => item.pid).join(',')}`)
}
if (error !== undefined) throw error
console.log(`[cordisx-desktop-agent-session-harness] report: ${reportPath}`)
