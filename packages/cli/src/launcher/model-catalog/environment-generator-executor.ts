import { spawn } from 'node:child_process'

const MAX_SCRIPT_BYTES = 16_384
const MAX_STDOUT_BYTES = 16_384
const MAX_STDERR_BYTES = 8_192
const TIMEOUT_MS = 10_000
const CLEANUP_GRACE_MS = 250
const CLOSE_GRACE_MS = 2_000
const sleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds))

export type EnvironmentGeneratorErrorCode =
  | 'invalid'
  | 'unavailable'
  | 'busy'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'too-large'
  | 'empty'

export class EnvironmentGeneratorError extends Error {
  constructor(readonly code: EnvironmentGeneratorErrorCode) {
    super(code)
  }
}

export function environmentGeneratorSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'linux'
}

/** Runs one local user-approved script. Process-group cleanup is best effort and is not a sandbox. */
async function executeEnvironmentGenerator(script: string, signal: AbortSignal): Promise<string> {
  if (!environmentGeneratorSupported()) throw new EnvironmentGeneratorError('unavailable')
  if (typeof script !== 'string' || Buffer.byteLength(script) > MAX_SCRIPT_BYTES || script.includes('\0')) {
    throw new EnvironmentGeneratorError('invalid')
  }
  if (signal.aborted) throw new EnvironmentGeneratorError('cancelled')
  let child: ReturnType<typeof spawn>
  try {
    child = spawn('/bin/sh', ['-s'], {
      cwd: '/',
      env: { LANG: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch {
    throw new EnvironmentGeneratorError('failed')
  }
  let failure: EnvironmentGeneratorErrorCode | undefined
  let stdoutBytes = 0
  let stderrBytes = 0
  const chunks: Buffer[] = []
  let cleanup: Promise<void> | undefined
  const signalGroup = (value: NodeJS.Signals): boolean => {
    if (child.pid === undefined) return false
    try {
      process.kill(-child.pid, value)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= 'failed'
      return false
    }
  }
  const stop = (): Promise<void> =>
    cleanup ??= (async () => {
      if (!signalGroup('SIGTERM')) return
      await sleep(CLEANUP_GRACE_MS)
      signalGroup('SIGKILL')
    })()
  const abort = () => {
    failure ??= 'cancelled'
    void stop()
  }
  const hostExit = () => signalGroup('SIGKILL')
  signal.addEventListener('abort', abort, { once: true })
  process.once('exit', hostExit)
  if (signal.aborted) abort()
  const deadline = setTimeout(() => {
    failure ??= 'timeout'
    void stop()
  }, TIMEOUT_MS)
  deadline.unref?.()
  const drain = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
    if (stream === 'stdout') stdoutBytes += chunk.byteLength
    else stderrBytes += chunk.byteLength
    if (stdoutBytes > MAX_STDOUT_BYTES || stderrBytes > MAX_STDERR_BYTES) {
      failure ??= 'too-large'
      chunks.length = 0
      void stop()
    } else if (stream === 'stdout' && failure === undefined) chunks.push(chunk)
  }
  child.stdout!.on('data', chunk => drain(chunk as Buffer, 'stdout'))
  child.stderr!.on('data', chunk => drain(chunk as Buffer, 'stderr'))
  child.stdin!.on('error', () => undefined)
  child.stdin!.end(script)
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  const exited = new Promise<void>(resolve => {
    child.once('error', () => {
      failure ??= 'failed'
      resolve()
    })
    child.once('exit', (code, exitSignal) => {
      if (code !== 0 || exitSignal !== null) failure ??= 'failed'
      resolve()
    })
  })
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await exited
    await stop()
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        closeTimer = setTimeout(() => reject(new EnvironmentGeneratorError('failed')), CLOSE_GRACE_MS)
      }),
    ])
    if (signal.aborted) failure ??= 'cancelled'
    if (failure !== undefined) throw new EnvironmentGeneratorError(failure)
    let value: string
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    } catch {
      throw new EnvironmentGeneratorError('failed')
    }
    if (value.includes('\0')) throw new EnvironmentGeneratorError('failed')
    value = value.replace(/\r?\n$/u, '')
    if (value === '') throw new EnvironmentGeneratorError('empty')
    return value
  } finally {
    clearTimeout(deadline)
    clearTimeout(closeTimer)
    signal.removeEventListener('abort', abort)
    process.removeListener('exit', hostExit)
    child.stdin!.destroy()
    child.stdout!.destroy()
    child.stderr!.destroy()
    chunks.length = 0
  }
}

export class EnvironmentGeneratorExecutor {
  #active: { readonly runId: string; readonly abort: AbortController } | undefined
  #closed = false

  async run(runId: string, script: string): Promise<string> {
    if (this.#closed) throw new EnvironmentGeneratorError('unavailable')
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(runId)) throw new EnvironmentGeneratorError('invalid')
    if (this.#active !== undefined) throw new EnvironmentGeneratorError('busy')
    const active = { runId, abort: new AbortController() }
    this.#active = active
    try {
      return await executeEnvironmentGenerator(script, active.abort.signal)
    } finally {
      if (this.#active === active) this.#active = undefined
    }
  }

  cancel(runId: string): boolean {
    const active = this.#active
    if (active === undefined || active.runId !== runId) return false
    active.abort.abort()
    return true
  }

  close(): void {
    this.#closed = true
    this.#active?.abort.abort()
  }
}
