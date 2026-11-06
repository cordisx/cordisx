import { type ChildProcess, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'

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
  if (
    process.platform !== 'linux' || browser.pid === undefined || browser.exitCode !== null
    || browser.signalCode !== null || signal.aborted
  ) return
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
    const end = value.lastIndexOf(')')
    const fields = value.slice(end + 2).split(/\s+/u)
    if (fields[19] === undefined) return undefined
    return {
      command: value.slice(value.indexOf('(') + 1, end).slice(0, 64),
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
    if (
      child === undefined || child.parent !== browser.pid || signal.aborted || browser.exitCode !== null
      || browser.signalCode !== null
    ) continue
    rows.push({ pid, ...child, wchan: await read(pid, 'wchan') })
  }
  if (!signal.aborted && diagnostics.processSamples.length < 4) {
    diagnostics.processSamples.push({ elapsedMs: elapsed(diagnostics), rows })
  }
}

/** Observe an owned launch without changing its arguments or readiness policy. */
export function launchObservedChrome(executable: string, args: string[], stderrLimit = 8_192) {
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
  const browser = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  observations.set(browser, diagnostics)
  let stderr = ''
  browser.once('spawn', () => event(diagnostics, 'spawned', { pid: browser.pid }))
  browser.stderr?.once('data', () => event(diagnostics, 'first-stderr'))
  browser.stderr?.on('data', data => {
    stderr = (stderr + String(data)).slice(-stderrLimit)
  })
  browser.on('error', error => {
    event(diagnostics, 'spawn-error', { message: error.message.slice(0, 256) })
    stderr = (stderr + error.message).slice(-stderrLimit)
  })
  browser.once('exit', (code, signal) => event(diagnostics, 'exit', { code, signal }))
  return { browser, stderr: () => stderr }
}

export function observeChromeReadiness(browser: ChildProcess, sampleDelays: readonly number[]) {
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
  const timers = sampleDelays.map(delay => setTimeout(() => void sample(), delay))
  return {
    async readActivePort(read: () => Promise<string>) {
      poll(diagnostics, 'port')
      try {
        const contents = await read()
        diagnostics.activePort = { elapsedMs: elapsed(diagnostics), contents: contents.slice(0, 256) }
        return contents
      } catch (error) {
        diagnostics.activePort = { elapsedMs: elapsed(diagnostics), errorCode: (error as NodeJS.ErrnoException).code }
        throw error
      }
    },
    activePort(port: number) {
      event(diagnostics, 'active-port', { port })
    },
    targetPoll() {
      poll(diagnostics, 'target')
    },
    pageTargets(details: Record<string, unknown>) {
      diagnostics.pageTargets = { elapsedMs: elapsed(diagnostics), ...details }
    },
    ready(phase: 'port' | 'page') {
      event(diagnostics, `${phase}-ready`)
      console.info(`[chrome] ${
        JSON.stringify({
          startedAt: diagnostics.startedAt,
          pid: browser.pid,
          readyMs: elapsed(diagnostics),
          portPolls: diagnostics.portPolls,
          targetPolls: diagnostics.targetPolls,
          maxPollGapMs: diagnostics.maxPollGapMs,
          events: diagnostics.events,
        })
      }`)
    },
    async failure(error: unknown) {
      event(diagnostics, 'readiness-failed', { exitCode: browser.exitCode, signalCode: browser.signalCode })
      // This bound collects failure evidence only; it never retries or accepts late readiness.
      const bound = setTimeout(() => sampling.abort(), 100)
      try {
        await sample()
      } finally {
        clearTimeout(bound)
        sampling.abort()
      }
      const { clockOrigin: _clockOrigin, ...report } = diagnostics
      return new Error(`${(error as Error).message}\nChrome launch diagnostics: ${JSON.stringify(report)}`, {
        cause: error,
      })
    },
    async dispose() {
      for (const timer of timers) clearTimeout(timer)
      sampling.abort()
      await Promise.all(pending)
    },
  }
}
