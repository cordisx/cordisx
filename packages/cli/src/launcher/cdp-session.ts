import WebSocket from 'ws'

export const CDP_REQUEST_TIMEOUT_MS = 5_000
const MAX_RENDERER_DIAGNOSTIC_BYTES = 8_192

export class CdpInstallationAbortedError extends Error {}

export function cdpInstallationAborted(): CdpInstallationAbortedError {
  return new CdpInstallationAbortedError('CordisX CDP installation aborted')
}

export async function abortable<Value>(promise: Promise<Value>, signal?: AbortSignal): Promise<Value> {
  if (signal === undefined) return await promise
  if (signal.aborted) throw cdpInstallationAborted()
  return await new Promise<Value>((resolve, reject) => {
    const onAbort = (): void => reject(cdpInstallationAborted())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export interface CdpTarget {
  readonly id: string
  readonly type: string
  readonly title: string
  readonly url: string
  readonly webSocketDebuggerUrl?: string
}

interface CdpResponse {
  readonly id?: number
  readonly result?: Record<string, unknown>
  readonly error?: { readonly code: number; readonly message: string }
  readonly method?: string
  readonly params?: Record<string, unknown>
}

export class CdpSession {
  private nextId = 1
  private closed = false
  private readonly pending = new Map<number, {
    readonly resolve: (value: Record<string, unknown>) => void
    readonly reject: (error: Error) => void
  }>()
  private readonly eventListeners = new Map<string, Set<(params: Record<string, unknown>) => void>>()

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as CdpResponse
      if (message.method !== undefined) {
        for (const listener of this.eventListeners.get(message.method) ?? []) listener(message.params ?? {})
      }
      if (message.id === undefined) return
      const callback = this.pending.get(message.id)
      if (callback === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) callback.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`))
      else callback.resolve(message.result ?? {})
    })
    socket.on('close', () => {
      this.closed = true
      for (const callback of this.pending.values()) callback.reject(new Error('CDP connection closed'))
      this.pending.clear()
    })
  }

  static async connect(url: string): Promise<CdpSession> {
    const socket = new WebSocket(url, { handshakeTimeout: 5_000 })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    return new CdpSession(socket)
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = CDP_REQUEST_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP connection is closed'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        // ws may pass null on success even though its TypeScript callback uses undefined.
        if (error == null) return
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  onEvent(method: string, listener: (params: Record<string, unknown>) => void): () => void {
    const listeners = this.eventListeners.get(method) ?? new Set()
    listeners.add(listener)
    this.eventListeners.set(method, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.eventListeners.delete(method)
    }
  }

  close(): void {
    this.closed = true
    this.socket.close()
  }

  isClosed(): boolean {
    return this.closed || this.socket.readyState !== WebSocket.OPEN
  }
}

export async function evaluateRuntimeOperation<Value = void>(
  session: CdpSession,
  expression: string,
  timeoutMs = CDP_REQUEST_TIMEOUT_MS,
): Promise<Value> {
  const response = await session.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
  }, timeoutMs)
  const exception = runtimeEvaluationException(response)
  if (exception !== undefined) throw new Error(`renderer lifecycle evaluation failed: ${exception}`)
  const value = (response.result as { value?: unknown } | undefined)?.value as {
    ok?: unknown
    error?: unknown
    result?: Value
  } | undefined
  if (value?.ok !== true) {
    throw new Error(
      typeof value?.error === 'string'
        ? value.error.slice(0, MAX_RENDERER_DIAGNOSTIC_BYTES)
        : 'renderer lifecycle operation returned ok=false without an error',
    )
  }
  return value.result as Value
}

/** Preserve a bounded renderer exception for launcher diagnostics. */
export function runtimeEvaluationException(response: Record<string, unknown>): string | undefined {
  const details = response.exceptionDetails
  if (details === undefined) return undefined
  if (details === null || typeof details !== 'object') {
    return String(details).slice(0, MAX_RENDERER_DIAGNOSTIC_BYTES)
  }
  const record = details as {
    readonly text?: unknown
    readonly lineNumber?: unknown
    readonly columnNumber?: unknown
    readonly exception?: { readonly description?: unknown }
  }
  const description = typeof record.exception?.description === 'string'
    ? record.exception.description
    : typeof record.text === 'string'
    ? record.text
    : 'unknown Runtime.evaluate exception'
  const line = typeof record.lineNumber === 'number' ? record.lineNumber + 1 : undefined
  const column = typeof record.columnNumber === 'number' ? record.columnNumber + 1 : undefined
  const location = line === undefined ? '' : ` (line ${line}${column === undefined ? '' : `, column ${column}`})`
  return `${description}${location}`.slice(0, MAX_RENDERER_DIAGNOSTIC_BYTES)
}
