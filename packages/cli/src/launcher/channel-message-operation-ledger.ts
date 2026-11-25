import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { ChannelMessageOperationResultV1 } from '@cordisx/protocol/channel-message-operations/v1'
import { validateStoredMessageOperation } from './channel-message-operation-store-validation.js'

interface Entry {
  readonly descriptor: string
  readonly createdAt: number
  readonly result: ChannelMessageOperationResultV1
}

export class ChannelMessageOperationLedger {
  private constructor(private readonly filename: string, private readonly now: () => number) {}

  static async open(filename: string, now = Date.now): Promise<ChannelMessageOperationLedger> {
    const ledger = new ChannelMessageOperationLedger(path.resolve(filename), now)
    await ledger.load()
    return ledger
  }

  key(scope: unknown, operationId: string): string {
    return createHash('sha256').update(JSON.stringify([scope, operationId])).digest('hex')
  }

  async receipt(key: string): Promise<ChannelMessageOperationResultV1 | null> {
    return structuredClone((await this.load())[key]?.result ?? null)
  }

  async execute(
    key: string,
    descriptor: unknown,
    operationId: string,
    effect: () => Promise<ChannelMessageOperationResultV1>,
  ): Promise<ChannelMessageOperationResultV1> {
    if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error('INVALID_REQUEST')
    const hash = createHash('sha256').update(JSON.stringify(descriptor)).digest('hex')
    const lock = await this.lock()
    try {
      const entries = await this.load()
      const existing = entries[key]
      if (existing) {
        if (existing.descriptor !== hash) throw new Error('CHANNEL_IDEMPOTENCY_CONFLICT')
        return structuredClone(existing.result)
      }
      if (Object.keys(entries).length >= 10000) throw new Error('CHANNEL_OPERATION_STORE_FULL')
      const entry: Entry = {
        descriptor: hash,
        createdAt: this.now(),
        result: { status: 'unknown', code: 'CHANNEL_OPERATION_PENDING', operationId },
      }
      entries[key] = entry
      await this.persist(entries)
      let result: ChannelMessageOperationResultV1
      try {
        result = await effect()
      } catch {
        result = { status: 'unknown', code: 'CHANNEL_OPERATION_UNCERTAIN', operationId }
      }
      validateStoredMessageOperation(result)
      if (result.operationId !== operationId) throw new Error('CHANNEL_OPERATION_STORE_INVALID')
      entries[key] = { ...entry, result }
      await this.persist(entries)
      return structuredClone(result)
    } finally {
      await lock.close()
      await unlink(`${this.filename}.lock`)
    }
  }

  private async load(): Promise<Record<string, Entry>> {
    try {
      const handle = await open(this.filename, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('CHANNEL_OPERATION_STORE_INVALID')
        const raw: unknown = JSON.parse(await handle.readFile('utf8'))
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('CHANNEL_OPERATION_STORE_INVALID')
        const document = raw as { contract?: unknown; entries?: unknown }
        if (
          Object.keys(raw).sort().join(',') !== 'contract,entries'
          || document.contract !== 'cordisx.channel-message-operation-store/v1' || !document.entries
          || typeof document.entries !== 'object' || Array.isArray(document.entries)
          || Object.keys(document.entries).length > 10000
        ) throw new Error('CHANNEL_OPERATION_STORE_INVALID')
        for (const [key, value] of Object.entries(document.entries)) {
          const entry = value as Entry
          if (
            !/^[a-f0-9]{64}$/u.test(key) || !entry || typeof entry !== 'object' || Array.isArray(entry)
            || Object.keys(entry).sort().join(',') !== 'createdAt,descriptor,result'
            || typeof entry.descriptor !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.descriptor)
            || !Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0
          ) throw new Error('CHANNEL_OPERATION_STORE_INVALID')
          validateStoredMessageOperation(entry.result)
        }
        return document.entries as Record<string, Entry>
      } finally {
        await handle.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.create(null) as Record<string, Entry>
      throw error
    }
  }

  private async lock() {
    await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 })
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        return await open(`${this.filename}.lock`, 'wx', 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    throw new Error('CHANNEL_OPERATION_STORE_BUSY')
  }

  private async persist(entries: Record<string, Entry>): Promise<void> {
    const temporary = `${this.filename}.${randomBytes(12).toString('hex')}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify({ contract: 'cordisx.channel-message-operation-store/v1', entries }))
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporary, this.filename)
      const directory = await open(path.dirname(this.filename), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }
}
