import { createServer, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { chmodSync, lstatSync } from 'node:fs'
import type { WalletSpendProviderSessionV1, WalletSpendWalletV1 } from './wallet-spend-ipc-types.js'
import { spendId, spendObject, spendSource } from './wallet-spend-validation.js'
import {
  checkSpendSocket,
  decodeSpendFrame,
  encodeSpendFrame,
  readSpendSecret,
  WALLET_SPEND_MAX_FRAME,
} from './wallet-spend-ipc-wire.js'

/** Private Node adapter. Only deployment config may select this process/socket/credential. */
export async function listenWalletSpendProvider(options: {
  readonly socketPath: string
  readonly secretFile: string
  /** Verify the original enrolled alias against the existing canonical database; never create an account. */
  readonly openSession: (wallet: WalletSpendWalletV1, live: () => boolean) => WalletSpendProviderSessionV1
}) {
  checkSpendSocket(options.socketPath, false)
  try {
    lstatSync(options.socketPath)
    throw new Error('socket path already exists')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const secret = readSpendSecret(options.secretFile), connections = new Set<Socket>()
  const server = createServer(socket => {
    connections.add(socket)
    let session: WalletSpendProviderSessionV1 | undefined, nonce = '', sequence = 0, retired = false
    let timer: ReturnType<typeof setTimeout> | undefined, buffer = Buffer.alloc(0)
    const quotes = new Map<string, { kind: string; handle: object }>()
    const close = () => {
      if (retired) return
      retired = true
      clearTimeout(timer)
      session?.close()
      quotes.clear()
      socket.destroy()
      connections.delete(socket)
    }
    socket.on('error', close)
    socket.on('close', close)
    socket.on('end', close)
    socket.on('data', data => {
      try {
        buffer = Buffer.concat([buffer, data])
        if (buffer.length > WALLET_SPEND_MAX_FRAME) throw new Error('oversized IPC request')
        const end = buffer.indexOf(10)
        if (end < 0) return
        // No pipelining; a native authorization belongs to this authenticated session only.
        if (end !== buffer.length - 1) throw new Error('pipelined IPC request')
        const frame = decodeSpendFrame(secret, buffer.subarray(0, end).toString('utf8'))
        buffer = Buffer.alloc(0)
        let value: unknown
        if (!session) {
          if (frame.operation !== 'open' || frame.sequence !== 0) throw new Error('invalid handshake')
          const p = spendObject(frame.payload, ['wallet', 'deadline'])
          const wallet = spendObject(p.wallet, ['origin', 'instanceId', 'accountId', 'subject', 'publicKey'])
          const deadline = p.deadline
          if (!Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline > Date.now() + 120_000) {
            throw new Error('invalid deadline')
          }
          spendId(wallet.instanceId)
          if (
            typeof wallet.accountId !== 'string' || !wallet.accountId || wallet.accountId.length > 512
            || typeof wallet.origin !== 'string' || new URL(wallet.origin).origin !== wallet.origin
            || typeof wallet.subject !== 'string' || !/^host-local:[A-Za-z0-9_-]{43}$/.test(wallet.subject)
            || typeof wallet.publicKey !== 'string' || !/^[A-Za-z0-9+/]{59}=$/.test(wallet.publicKey)
          ) throw new Error('invalid alias')
          timer = setTimeout(close, deadline - Date.now())
          session = options.openSession(
            wallet as unknown as WalletSpendWalletV1,
            () => !retired && Date.now() < deadline,
          )
          nonce = randomBytes(32).toString('hex')
          value = { serverNonce: nonce }
        } else {
          if (retired || frame.session !== nonce || frame.sequence !== sequence + 1) {
            throw new Error('stale IPC session')
          }
          sequence = frame.sequence
          const p = spendObject(frame.payload)
          switch (frame.operation) {
            case 'identity':
              spendObject(p, [])
              value = session.identity()
              break
            case 'quote': {
              spendObject(p, ['terms', 'requestId'])
              spendId(p.requestId)
              if (typeof p.terms !== 'string' || Buffer.byteLength(p.terms) > 65_536) throw new Error('invalid terms')
              const quote = session.quote(p.terms, p.requestId), token = randomBytes(32).toString('hex')
              quotes.set(token, { kind: 'reserve', handle: quote.handle })
              value = { token, terms: quote.terms }
              break
            }
            case 'quote-binding': {
              spendObject(p, ['challenge'])
              if (typeof p.challenge !== 'string' || Buffer.byteLength(p.challenge) > 65_536) {
                throw new Error('invalid challenge')
              }
              const quote = session.quoteBinding(p.challenge), token = randomBytes(32).toString('hex')
              quotes.set(token, { kind: 'bind', handle: quote.handle })
              value = { token, challenge: quote.challenge }
              break
            }
            case 'reserve':
            case 'bind': {
              spendObject(p, ['token'])
              const quote = quotes.get(p.token)
              if (!quote || quote.kind !== frame.operation) throw new Error('retired quote')
              quotes.delete(p.token)
              value = frame.operation === 'reserve'
                ? session.reserve(quote.handle)
                : session.bindGameAccount(quote.handle)
              break
            }
            case 'lookup':
              spendObject(p, ['source', 'requestId'])
              value = session.lookup(spendSource(p.source), spendId(p.requestId))
              break
            case 'apply':
              spendObject(p, ['source', 'decision'])
              if (typeof p.decision !== 'string' || Buffer.byteLength(p.decision) > 262_144) {
                throw new Error('invalid decision')
              }
              value = session.applyDecision(spendSource(p.source), p.decision)
              break
            case 'catalog':
            case 'orders':
              spendObject(p, ['storeId'])
              spendId(p.storeId)
              value = frame.operation === 'catalog' ? session.catalog(p.storeId) : session.orders(p.storeId)
              break
            case 'order':
              spendObject(p, ['storeId', 'requestId'])
              value = session.order(spendId(p.storeId), spendId(p.requestId))
              break
            case 'quote-purchase':
            case 'quote-cancellation': {
              spendObject(p, [
                'storeId',
                'itemId',
                'quantity',
                'expectedTotal',
                'requestId',
                ...(p.fulfillmentTarget === undefined ? [] : ['fulfillmentTarget']),
              ])
              spendId(p.storeId)
              spendId(p.itemId)
              spendId(p.requestId)
              if (
                !Number.isSafeInteger(p.quantity) || p.quantity < 1 || !Number.isSafeInteger(p.expectedTotal)
                || p.expectedTotal < 0
              ) throw new Error('invalid purchase')
              const quote = (frame.operation === 'quote-purchase' ? session.quotePurchase : session.quoteCancellation)(
                  p as Parameters<WalletSpendProviderSessionV1['quotePurchase']>[0],
                ),
                token = randomBytes(32).toString('hex')
              quotes.set(token, {
                kind: frame.operation === 'quote-purchase' ? 'purchase' : 'cancel-purchase',
                handle: quote.handle,
              })
              value = { token, quote: quote.quote }
              break
            }
            case 'purchase':
            case 'cancel-purchase': {
              spendObject(p, ['token'])
              const quote = quotes.get(p.token)
              if (
                !quote
                || (quote.kind !== 'purchase'
                  && !(frame.operation === 'cancel-purchase' && quote.kind === 'cancel-purchase'))
              ) throw new Error('retired quote')
              quotes.delete(p.token)
              value = frame.operation === 'purchase'
                ? session.purchase(quote.handle)
                : session.cancelPurchase(quote.handle)
              break
            }
            case 'legacy-receipt':
              spendObject(p, ['kind', 'requestId', 'input'])
              spendId(p.requestId)
              if (
                !['grant', 'migration', 'purchase'].includes(p.kind) || typeof p.input !== 'string'
                || Buffer.byteLength(p.input) > 65_536
              ) throw new Error('invalid legacy lookup')
              value = session.legacyReceipt(p as Parameters<WalletSpendProviderSessionV1['legacyReceipt']>[0])
              break
            default:
              throw new Error('unsupported operation')
          }
        }
        socket.write(
          encodeSpendFrame(secret, {
            session: frame.session,
            sequence: frame.sequence,
            operation: 'result',
            payload: { ok: true, value },
          }),
        )
      } catch {
        // Connection failure is deliberately uncertain; recovery queries the durable engine.
        close()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.socketPath, () => {
      chmodSync(options.socketPath, 0o600)
      resolve()
    })
  }).catch(error => {
    secret.fill(0)
    server.close()
    throw error
  })
  return {
    async close(): Promise<void> {
      for (const socket of connections) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      secret.fill(0)
    },
  }
}
