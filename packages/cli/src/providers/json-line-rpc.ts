import type { Readable, Writable } from 'node:stream'

const DEFAULT_MAX_LINE_BYTES = 2 * 1024 * 1024

interface RpcErrorShape {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

interface PendingRequest {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly removeAbort: () => void
}

export class JsonLineRpcError extends Error {
  constructor(
    message: string,
    readonly rpcCode?: number,
    readonly rpcData?: unknown,
  ) {
    super(message)
    this.name = 'JsonLineRpcError'
  }
}

export interface JsonLineRpcClientOptions {
  readonly input: Readable
  readonly output: Writable
  readonly timeoutMs: number
  readonly maxLineBytes?: number
  readonly onProtocolError?: (error: Error) => void
  readonly onNotification?: (method: string, params: unknown) => void
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function errorShape(value: unknown): RpcErrorShape | undefined {
  const candidate = object(value)
  if (candidate === undefined || typeof candidate.code !== 'number' || typeof candidate.message !== 'string') return undefined
  return { code: candidate.code, message: candidate.message, ...(candidate.data === undefined ? {} : { data: candidate.data }) }
}

/** Minimal newline-delimited request client. Raw protocol messages never leave this module. */
export class JsonLineRpcClient {
  private nextId = 1
  private buffer = Buffer.alloc(0)
  private readonly pending = new Map<number, PendingRequest>()
  private closed = false
  private readonly maxLineBytes: number

  constructor(private readonly options: JsonLineRpcClientOptions) {
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
    options.input.on('data', this.onData)
    options.input.once('error', this.onInputError)
    options.input.once('end', this.onInputEnd)
    options.output.once('error', this.onOutputError)
  }

  request<Result>(method: string, params: unknown, signal?: AbortSignal): Promise<Result> {
    if (this.closed) return Promise.reject(new JsonLineRpcError('RPC client is closed'))
    if (!/^[a-zA-Z][a-zA-Z0-9._/-]{0,127}$/.test(method)) return Promise.reject(new JsonLineRpcError('RPC method is invalid'))
    if (signal?.aborted === true) return Promise.reject(new JsonLineRpcError(`RPC request aborted: ${method}`))
    const id = this.nextId++
    return new Promise<Result>((resolve, reject) => {
      const abort = (): void => {
        const pending = this.pending.get(id)
        if (pending === undefined) return
        this.pending.delete(id)
        clearTimeout(pending.timer)
        reject(new JsonLineRpcError(`RPC request aborted: ${method}`))
      }
      signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => {
        this.pending.delete(id)
        signal?.removeEventListener('abort', abort)
        reject(new JsonLineRpcError(`RPC request timed out: ${method}`))
      }, this.options.timeoutMs)
      this.pending.set(id, {
        method,
        resolve: value => resolve(value as Result),
        reject,
        timer,
        removeAbort: () => signal?.removeEventListener('abort', abort),
      })
      this.write({ id, method, params }).catch(error => {
        const pending = this.pending.get(id)
        if (pending === undefined) return
        this.pending.delete(id)
        clearTimeout(pending.timer)
        pending.removeAbort()
        reject(error)
      })
    })
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) throw new JsonLineRpcError('RPC client is closed')
    await this.write({ method, ...(params === undefined ? {} : { params }) })
  }

  close(reason = 'RPC client closed'): void {
    if (this.closed) return
    this.closed = true
    this.options.input.off('data', this.onData)
    this.options.input.off('error', this.onInputError)
    this.options.input.off('end', this.onInputEnd)
    this.options.output.off('error', this.onOutputError)
    this.failPending(new JsonLineRpcError(reason))
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.closed) return
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    if (this.buffer.byteLength + bytes.byteLength > this.maxLineBytes && !bytes.includes(10)) {
      this.protocolFailure(new JsonLineRpcError('RPC line exceeds maximum size'))
      return
    }
    this.buffer = Buffer.concat([this.buffer, bytes])
    while (true) {
      const newline = this.buffer.indexOf(10)
      if (newline < 0) break
      const line = this.buffer.subarray(0, newline)
      this.buffer = this.buffer.subarray(newline + 1)
      if (line.byteLength === 0) continue
      if (line.byteLength > this.maxLineBytes) {
        this.protocolFailure(new JsonLineRpcError('RPC line exceeds maximum size'))
        return
      }
      this.receive(line.toString('utf8').replace(/\r$/, ''))
      if (this.closed) return
    }
    if (this.buffer.byteLength > this.maxLineBytes) this.protocolFailure(new JsonLineRpcError('RPC line exceeds maximum size'))
  }

  private readonly onInputError = (error: Error): void => this.protocolFailure(new JsonLineRpcError(`RPC input failed: ${error.message}`))
  private readonly onOutputError = (error: Error): void => this.protocolFailure(new JsonLineRpcError(`RPC output failed: ${error.message}`))
  private readonly onInputEnd = (): void => this.protocolFailure(new JsonLineRpcError('RPC input ended'))

  private receive(line: string): void {
    let decoded: unknown
    try {
      decoded = JSON.parse(line) as unknown
    } catch {
      this.protocolFailure(new JsonLineRpcError('RPC peer sent malformed JSON'))
      return
    }
    const message = object(decoded)
    if (message === undefined) {
      this.protocolFailure(new JsonLineRpcError('RPC peer sent a non-object message'))
      return
    }
    if (typeof message.id === 'number' && typeof message.method === 'string') {
      void this.write({ id: message.id, error: { code: -32601, message: 'Method not found' } }).catch(() => undefined)
      return
    }
    if (typeof message.id !== 'number') {
      if (typeof message.method === 'string') this.options.onNotification?.(message.method, message.params)
      return
    }
    const pending = this.pending.get(message.id)
    if (pending === undefined) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    pending.removeAbort()
    const rpcError = errorShape(message.error)
    if (rpcError !== undefined) {
      pending.reject(new JsonLineRpcError(`${pending.method} failed: ${rpcError.message}`, rpcError.code, rpcError.data))
    } else if (Object.hasOwn(message, 'result')) {
      pending.resolve(message.result)
    } else {
      pending.reject(new JsonLineRpcError(`${pending.method} returned an invalid response`))
    }
  }

  private write(value: unknown): Promise<void> {
    if (this.closed) return Promise.reject(new JsonLineRpcError('RPC client is closed'))
    const line = `${JSON.stringify(value)}\n`
    if (Buffer.byteLength(line) > this.maxLineBytes) return Promise.reject(new JsonLineRpcError('RPC request exceeds maximum size'))
    return new Promise((resolve, reject) => {
      this.options.output.write(line, (error?: Error | null) => error == null ? resolve() : reject(error))
    })
  }

  private protocolFailure(error: Error): void {
    this.options.onProtocolError?.(error)
    this.close(error.message)
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.removeAbort()
      pending.reject(error)
    }
    this.pending.clear()
  }
}
