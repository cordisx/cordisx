import type { ChildProcess } from 'node:child_process'

type LifecycleEvent =
  | { readonly event: 'supervisor-stop-requested' }
  | { readonly event: 'startup-handoff-resolved' }
  | { readonly event: 'launcher-signal'; readonly signal: 'SIGINT' | 'SIGTERM' }
  | { readonly event: 'host-exit'; readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly event: 'host-process-error' }
  | { readonly event: 'readiness-failed' }
  | { readonly event: 'lifecycle-failed' }
  | { readonly event: 'cleanup-started' }
  | { readonly event: 'host-termination-requested'; readonly alreadyExited: boolean }

/** Fixed fields only: never serialize errors, renderer text, URLs, or supervisor credentials. */
export function logHostLifecycle(
  stdout: (line: string) => void,
  event: LifecycleEvent,
  context: { readonly hostPid?: number | undefined; readonly ready?: boolean } = {},
): void {
  stdout(`[cordisx-lifecycle] ${JSON.stringify({ at: Date.now(), launcherPid: process.pid, ...context, ...event })}`)
}

export function observeHostExit(
  child: ChildProcess,
  stdout: (line: string) => void,
  ready: () => boolean,
): () => void {
  const onExit = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
    logHostLifecycle(stdout, { event: 'host-exit', exitCode, signal }, { hostPid: child.pid, ready: ready() })
  }
  const onError = (): void => {
    logHostLifecycle(stdout, { event: 'host-process-error' }, { hostPid: child.pid, ready: ready() })
  }
  if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode)
  else child.once('exit', onExit)
  child.on('error', onError)
  return () => {
    child.removeListener('exit', onExit)
    child.removeListener('error', onError)
  }
}

export function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode === 0 || child.signalCode !== null
      ? Promise.resolve()
      : Promise.reject(new Error(`host exited with status ${String(child.exitCode)}`))
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0 || signal !== null) resolve()
      else reject(new Error(`host exited with status ${String(code)}`))
    })
  })
}

export function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
}

/** A launch is usable only after the CDP watcher has installed a renderer. */
export async function waitForHostExitAfterReadiness(input: {
  readonly childExit: Promise<void>
  readonly ready: Promise<void>
  readonly signal: AbortSignal
}): Promise<void> {
  let ready = false
  void input.ready.then(() => {
    ready = true
  })
  await Promise.race([
    input.childExit.then(() => {
      if (!ready) throw new Error('Host exited before CordisX CDP became ready')
    }),
    waitForAbort(input.signal),
  ])
}
