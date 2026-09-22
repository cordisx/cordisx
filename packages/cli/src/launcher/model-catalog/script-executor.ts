import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { parseScriptOutput } from './script-output-parser.js'
import {
  type ScriptDiagnostic,
  type ScriptErrorCode,
  type ScriptExecution,
  type ScriptMode,
  type ScriptModel,
  ScriptSourceError,
} from './script-types.js'

const sleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds))

export function scriptExecutionSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'linux'
}

/** Owns one POSIX process group. This is cleanup, not a sandbox against hostile daemonization. */
export async function executeScript(
  input: ScriptExecution,
  mode: ScriptMode,
  signal: AbortSignal,
  diagnostic?: (value: ScriptDiagnostic) => void,
): Promise<readonly ScriptModel[]> {
  if (!scriptExecutionSupported()) throw new ScriptSourceError('script-unsupported')
  if (signal.aborted) throw new ScriptSourceError('cancelled')
  const started = Date.now()
  const { config } = input
  const command = config.command
  let stdoutBytes = 0
  let stderrBytes = 0
  let failure: ScriptErrorCode | undefined
  const chunks: Buffer[] = []
  let cleanup: Promise<void> | undefined
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(
      command.kind === 'exec' ? command.executable : command.command,
      command.kind === 'exec' ? [...command.args] : [],
      {
        cwd: config.cwd,
        env: { ...input.env },
        shell: command.kind === 'shell',
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
  } catch {
    throw new ScriptSourceError('script-exit-failed')
  }
  const groupSignal = (value: NodeJS.Signals | 0): boolean => {
    if (child.pid === undefined) return false
    try {
      process.kill(-child.pid, value)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = 'script-cleanup-failed'
      return false
    }
  }
  const stop = (): Promise<void> =>
    cleanup ??= (async () => {
      if (!groupSignal('SIGTERM')) return
      await sleep(1000)
      groupSignal('SIGKILL')
    })()
  const abort = () => {
    failure ??= 'cancelled'
    void stop()
  }
  const hostExit = () => {
    groupSignal('SIGKILL')
  }
  process.once('exit', hostExit)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const deadline = setTimeout(() => {
    failure ??= 'script-timeout'
    void stop()
  }, config.timeoutMs)
  const drain = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
    if (stream === 'stdout') stdoutBytes += chunk.byteLength
    else stderrBytes += chunk.byteLength
    if (stdoutBytes > config.maxStdoutBytes || stderrBytes > config.maxStderrBytes) {
      failure ??= 'script-budget-exceeded'
      chunks.length = 0
      void stop()
    } else if (stream === 'stdout' && !failure) chunks.push(chunk)
  }
  child.stdout!.on('data', chunk => drain(chunk as Buffer, 'stdout'))
  child.stderr!.on('data', chunk => drain(chunk as Buffer, 'stderr'))
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  // The deadline remains active if the root exits while a descendant holds the pipes.
  const exited = new Promise<void>(resolve => {
    child.once('error', () => {
      failure ??= 'script-exit-failed'
      resolve()
    })
    child.once('exit', (code, exitSignal) => {
      if (code !== 0 || exitSignal !== null) failure ??= 'script-exit-failed'
      resolve()
    })
  })
  let outcome: 'ok' | ScriptErrorCode = 'ok'
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await exited
    await stop()
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        closeTimer = setTimeout(() => reject(new ScriptSourceError('script-cleanup-failed')), 2000)
      }),
    ])
    if (signal.aborted) failure ??= 'cancelled'
    if (failure) throw new ScriptSourceError(failure)
    return parseScriptOutput(Buffer.concat(chunks), mode, config.maxModels)
  } catch (error) {
    outcome = error instanceof ScriptSourceError ? error.code : 'script-exit-failed'
    throw new ScriptSourceError(outcome)
  } finally {
    clearTimeout(deadline)
    clearTimeout(closeTimer)
    signal.removeEventListener('abort', abort)
    process.removeListener('exit', hostExit)
    child.stdout!.destroy()
    child.stderr!.destroy()
    chunks.length = 0
    try {
      diagnostic?.(
        Object.freeze({
          diagnosticId: randomUUID(),
          outcome,
          durationMs: Date.now() - started,
          stdoutBytes,
          stderrBytes,
        }),
      )
    } catch { /* Diagnostics do not control success. */ }
  }
}
