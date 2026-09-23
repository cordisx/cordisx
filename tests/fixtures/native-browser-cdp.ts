import { once } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import WebSocket from 'ws'

export class CdpClient {
  readonly diagnostics: unknown[] = []
  readonly #socket: WebSocket
  readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  #nextId = 1

  private constructor(socket: WebSocket) {
    this.#socket = socket
    socket.on('message', data => {
      const message = JSON.parse(data.toString()) as {
        readonly id?: number
        readonly method?: string
        readonly params?: unknown
        readonly error?: { readonly message?: string }
        readonly result?: unknown
      }
      if (message.id === undefined) {
        if (
          message.method === 'Runtime.exceptionThrown' || message.method === 'Network.loadingFailed'
          || message.method === 'Runtime.consoleAPICalled'
        ) {
          this.diagnostics.push({ method: message.method, params: message.params })
          if (this.diagnostics.length > 30) this.diagnostics.shift()
        }
        return
      }
      const pending = this.#pending.get(message.id)
      if (pending === undefined) return
      this.#pending.delete(message.id)
      if (message.error !== undefined) pending.reject(new Error(message.error.message ?? 'Chrome CDP request failed'))
      else pending.resolve(message.result)
    })
    socket.on('close', () => {
      for (const pending of this.#pending.values()) pending.reject(new Error('Chrome CDP connection closed'))
      this.#pending.clear()
    })
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    return new CdpClient(socket)
  }

  async send(method: string, params: Record<string, unknown> = {}, timeoutMs = 5_000): Promise<unknown> {
    const id = this.#nextId
    this.#nextId += 1
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`Chrome CDP request timed out: ${method}`))
      }, timeoutMs)
      const succeed = (value: unknown): void => {
        clearTimeout(timer)
        resolve(value)
      }
      const fail = (error: Error): void => {
        clearTimeout(timer)
        reject(error)
      }
      this.#pending.set(id, { resolve: succeed, reject: fail })
      this.#socket.send(JSON.stringify({ id, method, params }), error => {
        if (error == null) return
        const pending = this.#pending.get(id)
        this.#pending.delete(id)
        pending?.reject(error)
      })
    })
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }) as {
      readonly exceptionDetails?: { readonly text?: string; readonly exception?: { readonly description?: string } }
      readonly result?: { readonly value?: T }
    }
    if (response.exceptionDetails !== undefined) {
      throw new Error(
        response.exceptionDetails.exception?.description ?? response.exceptionDetails.text
          ?? 'Chrome evaluation failed',
      )
    }
    return response.result?.value as T
  }

  async close(): Promise<void> {
    if (this.#socket.readyState === WebSocket.CLOSED) return
    const closed = once(this.#socket, 'close')
    this.#socket.close()
    await closed
  }
}

export async function stopChrome(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return
  const exited = once(process, 'exit')
  process.kill('SIGTERM')
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise<false>(resolve => setTimeout(() => resolve(false), 5_000)),
  ])
  if (stopped || process.exitCode !== null || process.signalCode !== null) return
  process.kill('SIGKILL')
  if (process.exitCode !== null || process.signalCode !== null) return
  const killed = await Promise.race([
    exited.then(() => true),
    new Promise<false>(resolve => setTimeout(() => resolve(false), 2_000)),
  ])
  if (!killed && process.exitCode === null && process.signalCode === null) {
    throw new Error('Chrome did not exit after SIGKILL')
  }
}
