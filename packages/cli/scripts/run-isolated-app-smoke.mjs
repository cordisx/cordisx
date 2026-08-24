import { execFileSync, spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import process from 'node:process'

function value(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`${name} is required`)
  return process.argv[index + 1]
}

const separator = process.argv.indexOf('--')
if (separator < 0) throw new Error('separate live-smoke arguments with --')
const port = Number(value('--port'))
const profileDir = value('--profile-dir')
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port must be an unprivileged TCP port')
const smokeArgs = process.argv.slice(separator + 1)

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
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (exited(launcher)) throw new Error(`isolated launcher exited before renderer readiness (status ${String(launcher.exitCode)})`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) })
      if (response.ok) {
        const target = (await response.json()).find(item => item.url === 'app://-/index.html')
        if (target !== undefined && await cordisxReady(target)) return
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('isolated app:// renderer did not become available')
}

const crashpadBefore = await crashpadCount()
const launcher = spawn(process.execPath, [
  '--import', 'tsx', 'packages/cli/src/cli.ts', 'codex', 'smoke', '--data', 'isolated',
  '--debug-port', String(port), '--profile-dir', profileDir, '--', '--start-minimized',
], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
  detached: process.platform !== 'win32',
})
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
    smoke = spawn(process.execPath, ['packages/cli/scripts/live-smoke.mjs', '--port', String(port), ...smokeArgs], {
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
  console.log(`[cordisx-smoke-cleanup] ${JSON.stringify({
    port,
    portClosed: true,
    profileDir,
    profileProcesses: 0,
    crashpadBefore,
    crashpadAfter,
  })}`)
}

process.exitCode = result
