import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rmdir } from 'node:fs/promises'
import path from 'node:path'
import type { ChannelForwardReceiptV1, ChannelForwardRequestV1 } from '@cordisx/protocol/channel-forward/v1'
import { validateForwardEntry } from './channel-forward-validation.js'

type Entry = { request: ChannelForwardRequestV1; receipt: ChannelForwardReceiptV1 }

export class ChannelForwardStore {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly filename: string) {}

  async run(
    scope: string,
    request: ChannelForwardRequestV1,
    perform: (request: ChannelForwardRequestV1) => Promise<ChannelForwardReceiptV1>,
    readOnly = false,
  ): Promise<ChannelForwardReceiptV1 | undefined> {
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
        let entries: Record<string, Entry>
        try {
          entries = JSON.parse(await readFile(this.filename, 'utf8')) as Record<string, Entry>
          if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
            throw new Error('FORWARD_STORE_INVALID')
          }
          if (Object.keys(entries).length > 10000) throw new Error('FORWARD_STORE_INVALID')
          for (const [key, entry] of Object.entries(entries)) {
            if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error('FORWARD_STORE_INVALID')
            validateForwardEntry(entry)
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
          prior.receipt = {
            contract: 'cordisx.channel-forward-receipt/v1',
            schemaVersion: 1,
            operationId: request.operationId,
            operation: request.operation,
            state: 'unknown',
            code: 'FORWARD_INTERRUPTED',
          }
          await this.save(entries)
          return prior.receipt
        }
        if (readOnly) return undefined
        if (Object.keys(entries).length >= 10000) throw new Error('FORWARD_LEDGER_FULL')
        const pending: ChannelForwardReceiptV1 = {
          contract: 'cordisx.channel-forward-receipt/v1',
          schemaVersion: 1,
          operationId: request.operationId,
          operation: request.operation,
          state: 'sending',
        }
        entries[identity] = { request, receipt: pending }
        validateForwardEntry(entries[identity])
        await this.save(entries)
        const uuid = createHash('sha256').update(identity).digest('hex').slice(0, 32)
        let receipt: ChannelForwardReceiptV1
        try {
          receipt = { ...await perform({ ...request, operationId: uuid }), operationId: request.operationId }
        } catch {
          receipt = { ...pending, state: 'unknown', code: 'FORWARD_EFFECT_UNCERTAIN' }
        }
        entries[identity] = { request, receipt }
        try {
          validateForwardEntry(entries[identity])
        } catch {
          receipt = { ...pending, state: 'unknown', code: 'FORWARD_RECEIPT_INVALID' }
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

  private async save(entries: Record<string, Entry>): Promise<void> {
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
