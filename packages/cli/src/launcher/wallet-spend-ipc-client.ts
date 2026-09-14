import { connect, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import {
  checkSpendSocket,
  decodeSpendFrame,
  encodeSpendFrame,
  readSpendSecret,
  WALLET_SPEND_MAX_FRAME,
} from './wallet-spend-ipc-wire.js'
import type { WalletSpendWalletV1 } from './wallet-spend-ipc-types.js'

export class WalletSpendIpcClient {
  private sequence = 0
  private pending: { resolve(value: unknown): void; reject(error: Error): void } | undefined
  private session = randomBytes(32).toString('hex')
  private buffer = Buffer.alloc(0)
  private closed = false
  private constructor(private readonly socket: Socket, private readonly secret: Buffer) {
    socket.on('data', data => {
      try {
        this.buffer = Buffer.concat([this.buffer, data])
        if (this.buffer.length > WALLET_SPEND_MAX_FRAME) throw new Error('IPC response too large')
        const end = this.buffer.indexOf(10)
        if (end < 0) return
        if (end !== this.buffer.length - 1 || !this.pending) throw new Error('unsolicited IPC response')
        const frame = decodeSpendFrame(this.secret, this.buffer.subarray(0, end).toString('utf8'))
        this.buffer = Buffer.alloc(0)
        if (frame.session !== this.session || frame.sequence !== this.sequence || frame.operation !== 'result') {
          throw new Error('uncorrelated IPC response')
        }
        const pending = this.pending
        this.pending = undefined
        const result = frame.payload as { ok: boolean; value?: unknown; code?: string }
        if (result.ok === true) pending.resolve(result.value)
        else pending.reject(Object.assign(new Error('provider rejected'), { code: result.code }))
      } catch {
        this.close()
      }
    })
    socket.on('error', () => this.close())
    socket.on('close', () => this.close())
  }
  static async open(
    config: { socketPath: string; secretFile: string },
    wallet: WalletSpendWalletV1,
    deadline: number,
    signal: AbortSignal,
  ): Promise<WalletSpendIpcClient> {
    checkSpendSocket(config.socketPath, true)
    const secret = readSpendSecret(config.secretFile)
    const socket = connect(config.socketPath), client = new WalletSpendIpcClient(socket, secret)
    const abort = () => client.close()
    signal.addEventListener('abort', abort, { once: true })
    socket.once('close', () => signal.removeEventListener('abort', abort))
    if (signal.aborted) client.close()
    try {
      const hello = await client.call('open', { wallet, deadline }) as { serverNonce: string }
      if (!/^[a-f0-9]{64}$/.test(hello.serverNonce)) throw new Error('invalid server nonce')
      client.session = hello.serverNonce
      return client
    } catch (error) {
      client.close()
      throw error
    }
  }
  call(operation: string, payload: unknown): Promise<unknown> {
    if (this.closed || this.pending) return Promise.reject(new Error('IPC unavailable'))
    if (operation !== 'open') this.sequence += 1
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject }
      try {
        this.socket.write(encodeSpendFrame(this.secret, {
          session: this.session,
          sequence: this.sequence,
          operation,
          payload,
        }))
      } catch {
        this.close()
      }
    })
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.pending?.reject(new Error('IPC unavailable'))
    this.pending = undefined
    this.socket.destroy()
    this.secret.fill(0)
  }
}
