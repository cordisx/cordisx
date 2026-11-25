import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rmdir } from 'node:fs/promises'
import path from 'node:path'
import type { ChannelForwardReceiptV1, ChannelForwardRequestV1 } from '@cordisx/protocol/channel-forward/v1'
import { validateForwardEntry } from './channel-forward-validation.js'

export interface ChannelForwardLedgerCodec<Request, Receipt> {
  validate(value: unknown): { request: Request; receipt: Receipt }
  pending(request: Request): Receipt
  unknown(request: Request, code: string): Receipt
}
const defaultCodec: ChannelForwardLedgerCodec<ChannelForwardRequestV1, ChannelForwardReceiptV1> = {
  validate: validateForwardEntry,
  pending: request => ({
    contract: 'cordisx.channel-forward-receipt/v1',
    schemaVersion: 1,
    operationId: request.operationId,
    operation: request.operation,
    state: 'sending',
  }),
  unknown: (request, code) => ({
    contract: 'cordisx.channel-forward-receipt/v1',
    schemaVersion: 1,
    operationId: request.operationId,
    operation: request.operation,
    state: 'unknown',
    code,
  }),
}
type Entry<Request, Receipt> = { request: Request; receipt: Receipt }

export class ChannelForwardStore<
  Request extends { readonly operationId: string } = ChannelForwardRequestV1,
  Receipt extends { readonly operationId: string; readonly state: string } = ChannelForwardReceiptV1,
> {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly filename: string,
    private readonly codec: ChannelForwardLedgerCodec<Request, Receipt> =
      defaultCodec as unknown as ChannelForwardLedgerCodec<Request, Receipt>,
  ) {}

  async run(
    scope: string,
    request: Request,
    perform: (request: Request) => Promise<Receipt>,
    readOnly = false,
  ): Promise<Receipt | undefined> {
    const operation = this.queue.then(async () => {
      await mkdir(path.dirname(this.filename), { recursive: true })
      const lock = `${this.filename}.lock`
      try {
        await mkdir(lock)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('FORWARD_LEDGER_LOCKED')
        throw error
      }
      try {
        let entries: Record<string, Entry<Request, Receipt>>
        try {
          entries = JSON.parse(await readFile(this.filename, 'utf8')) as Record<string, Entry<Request, Receipt>>
          if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
            throw new Error('FORWARD_STORE_INVALID')
          }
          if (Object.keys(entries).length > 10000) throw new Error('FORWARD_STORE_INVALID')
          for (const [key, entry] of Object.entries(entries)) {
            if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error('FORWARD_STORE_INVALID')
            this.codec.validate(entry)
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          entries = {}
        }
        const identity = createHash('sha256').update(JSON.stringify([scope, request.operationId])).digest('hex')
        const prior = entries[identity]
        if (prior) {
          if (JSON.stringify(prior.request) !== JSON.stringify(request)) throw new Error('FORWARD_OPERATION_CONFLICT')
          if (prior.receipt.state !== 'sending') return prior.receipt
          prior.receipt = this.codec.unknown(request, 'FORWARD_INTERRUPTED')
          await this.save(entries)
          return prior.receipt
        }
        if (readOnly) return undefined
        if (Object.keys(entries).length >= 10000) throw new Error('FORWARD_LEDGER_FULL')
        const pending = this.codec.pending(request)
        entries[identity] = { request, receipt: pending }
        this.codec.validate(entries[identity])
        await this.save(entries)
        const uuid = createHash('sha256').update(identity).digest('hex').slice(0, 32)
        let receipt: Receipt
        try {
          receipt = { ...await perform({ ...request, operationId: uuid }), operationId: request.operationId }
        } catch {
          receipt = this.codec.unknown(request, 'FORWARD_EFFECT_UNCERTAIN')
        }
        entries[identity] = { request, receipt }
        try {
          this.codec.validate(entries[identity])
        } catch {
          receipt = this.codec.unknown(request, 'FORWARD_RECEIPT_INVALID')
          entries[identity] = { request, receipt }
        }
        await this.save(entries)
        return receipt
      } finally {
        await rmdir(lock)
      }
    })
    this.queue = operation.catch(() => {})
    return operation
  }

  private async save(entries: Record<string, Entry<Request, Receipt>>): Promise<void> {
    await mkdir(path.dirname(this.filename), { recursive: true })
    const temporary = `${this.filename}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(entries))
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, this.filename)
    const directory = await open(path.dirname(this.filename), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }
}
