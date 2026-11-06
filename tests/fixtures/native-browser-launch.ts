import { type ChildProcess, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { waitForChromeDebugPort } from './chrome-debug-port.js'

interface BrowserDiagnostics {
  readonly startedAt: string
  readonly clockOrigin: number
  readonly events: Array<Record<string, unknown>>
  readonly processSamples: Array<Record<string, unknown>>
  activePort?: Record<string, unknown>
  pageTargets?: Record<string, unknown>
  lastPollAt?: number
  maxPollGapMs: number
  portPolls: number
  targetPolls: number
  rootStartTime?: string
}

const observations = new WeakMap<ChildProcess, BrowserDiagnostics>()
const elapsed = (diagnostics: BrowserDiagnostics) => Math.round(performance.now() - diagnostics.clockOrigin)

function event(diagnostics: BrowserDiagnostics, name: string, details: Record<string, unknown> = {}) {
  if (diagnostics.events.length < 24) {
    diagnostics.events.push({ event: name, elapsedMs: elapsed(diagnostics), ...details })
  }
}

function poll(diagnostics: BrowserDiagnostics, phase: 'port' | 'target') {
  const now = performance.now()
  if (diagnostics.lastPollAt !== undefined) {
    diagnostics.maxPollGapMs = Math.max(diagnostics.maxPollGapMs, Math.round(now - diagnostics.lastPollAt))
  }
  diagnostics.lastPollAt = now
  if (phase === 'port') diagnostics.portPolls += 1
  else diagnostics.targetPolls += 1
}

/** Read only the spawned Chrome and its children; never inspect other browser/App processes. */
async function processSample(browser: ChildProcess, diagnostics: BrowserDiagnostics, signal: AbortSignal) {
  if (process.platform !== 'linux' || browser.pid === undefined || browser.exitCode !== null || signal.aborted) return
  const read = async (pid: number, name: string) => {
    try {
      return (await readFile(`/proc/${pid}/${name}`, { encoding: 'utf8', signal })).trim().slice(0, 1_024)
    } catch (error) {
      return { errorCode: (error as NodeJS.ErrnoException).code ?? 'unknown' }
    }
  }
  const stat = async (pid: number) => {
    const value = await read(pid, 'stat')
    if (typeof value !== 'string') return undefined
    // Linux comm can contain spaces and parentheses; fields start after its final ')'.
    const fields = value.slice(value.lastIndexOf(')') + 2).split(/\s+/u)
    if (fields[19] === undefined) return undefined
    return {
      state: fields[0],
      parent: Number(fields[1]),
      userTicks: fields[11],
      systemTicks: fields[12],
      startTime: fields[19],
    }
  }
  const root = await stat(browser.pid)
  if (root === undefined || signal.aborted || browser.exitCode !== null || browser.signalCode !== null) return
  diagnostics.rootStartTime ??= root.startTime
  if (root.startTime !== diagnostics.rootStartTime) return
  const children = await read(browser.pid, `task/${browser.pid}/children`)
  const childPids = typeof children === 'string' ? children.split(/\s+/u).filter(Boolean).map(Number).slice(0, 8) : []
  const rows: Array<Record<string, unknown>> = [{ pid: browser.pid, ...root, wchan: await read(browser.pid, 'wchan') }]
  for (const pid of childPids) {
    const child = await stat(pid)
    if (child === undefined || child.parent !== browser.pid || signal.aborted || browser.exitCode !== null) continue
    rows.push({ pid, ...child, wchan: await read(pid, 'wchan') })
  }
  if (!signal.aborted) diagnostics.processSamples.push({ elapsedMs: elapsed(diagnostics), rows })
}

/** Shared isolated browser policy keeps native fixtures equivalent on macOS and Linux CI. */
function chromeLaunchArguments(profile: string): string[] {
  return [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--remote-allow-origins=*',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ]
}

export function launchChrome(executable: string, profile: string) {
  const diagnostics: BrowserDiagnostics = {
    startedAt: new Date().toISOString(),
    clockOrigin: performance.now(),
    events: [],
    processSamples: [],
    maxPollGapMs: 0,
    portPolls: 0,
    targetPolls: 0,
  }
  event(diagnostics, 'spawn-request')
  const browser = spawn(executable, chromeLaunchArguments(profile), { stdio: ['ignore', 'ignore', 'pipe'] })
  observations.set(browser, diagnostics)
  let stderr = ''
  browser.once('spawn', () => event(diagnostics, 'spawned', { pid: browser.pid }))
  browser.stderr?.once('data', () => event(diagnostics, 'first-stderr'))
  browser.stderr?.on('data', data => {
    stderr = (stderr + data.toString()).slice(-8_192)
  })
  browser.on('error', error => {
    event(diagnostics, 'spawn-error', { message: error.message })
    stderr = (stderr + error.message).slice(-8_192)
  })
  browser.once('exit', (code, signal) => event(diagnostics, 'exit', { code, signal }))
  return { browser, stderr: () => stderr }
}

export async function waitForChromeTarget(
  profile: string,
  browser: ChildProcess,
  stderr: () => string,
): Promise<string> {
  const deadline = Date.now() + 15_000
  const diagnostics = observations.get(browser)
  if (diagnostics === undefined) throw new Error('Chrome readiness requires the launch-owned browser')
  event(diagnostics, 'readiness-start')
  const sampling = new AbortController()
  const pending = new Set<Promise<void>>()
  const sample = () => {
    const task = processSample(browser, diagnostics, sampling.signal).catch(error => {
      event(diagnostics, 'process-sample-error', { message: (error as Error).message.slice(0, 256) })
    })
    pending.add(task)
    void task.finally(() => pending.delete(task))
    return task
  }
  const samples = [0, 5_000, 10_000].map(delay =>
    setTimeout(() => {
      void sample()
    }, delay)
  )
  try {
    // Chrome binds its own port and publishes it in this browser's private profile.
    const port = await waitForChromeDebugPort(
      browser,
      async () => {
        poll(diagnostics, 'port')
        try {
          const contents = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')
          diagnostics.activePort = { elapsedMs: elapsed(diagnostics), contents: contents.slice(0, 256) }
          return contents
        } catch (error) {
          diagnostics.activePort = { elapsedMs: elapsed(diagnostics), errorCode: (error as NodeJS.ErrnoException).code }
          throw error
        }
      },
      stderr,
      Math.max(0, deadline - Date.now()),
    )
    event(diagnostics, 'active-port', { port })
    while (Date.now() < deadline) {
      if (browser.exitCode !== null || browser.signalCode !== null) {
        throw new Error(`Chrome exited before CDP was ready: ${stderr()}`)
      }
      poll(diagnostics, 'target')
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000) })
        diagnostics.pageTargets = { elapsedMs: elapsed(diagnostics), status: response.status }
        if (response.ok) {
          const targets = await response.json() as Array<
            { readonly type?: string; readonly url?: string; readonly webSocketDebuggerUrl?: string }
          >
          diagnostics.pageTargets.targets = targets.slice(0, 8).map(target => ({
            type: target.type,
            url: target.url?.slice(0, 128),
            hasWebSocket: target.webSocketDebuggerUrl !== undefined,
          }))
          const target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl !== undefined)
          if (target?.webSocketDebuggerUrl !== undefined) {
            event(diagnostics, 'page-ready')
            console.info(
              `[chrome] ${
                JSON.stringify({
                  startedAt: diagnostics.startedAt,
                  pid: browser.pid,
                  readyMs: elapsed(diagnostics),
                  portPolls: diagnostics.portPolls,
                  targetPolls: diagnostics.targetPolls,
                  maxPollGapMs: diagnostics.maxPollGapMs,
                })
              }`,
            )
            return target.webSocketDebuggerUrl
          }
        }
      } catch (error) {
        diagnostics.pageTargets = { elapsedMs: elapsed(diagnostics), error: (error as Error).message }
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`timed out waiting for Chrome CDP: ${stderr()}`)
  } catch (error) {
    event(diagnostics, 'readiness-failed', { exitCode: browser.exitCode, signalCode: browser.signalCode })
    await sample()
    const { clockOrigin: _clockOrigin, ...report } = diagnostics
    throw new Error(`${(error as Error).message}\nChrome launch diagnostics: ${JSON.stringify(report)}`, {
      cause: error,
    })
  } finally {
    for (const timer of samples) clearTimeout(timer)
    sampling.abort()
    await Promise.all(pending)
  }
}
