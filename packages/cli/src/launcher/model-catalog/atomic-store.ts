import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { type CatalogSnapshot, object } from './contracts.js'

/** Single-owner primitive; detects observed conflicts, not a cross-process filesystem CAS. */
export class AtomicCatalogStore {
  private lastWritten: string | undefined
  private initialized = false
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string) {}

  async read(): Promise<unknown> {
    const raw = await this.readRaw()
    this.lastWritten = raw
    this.initialized = true
    if (raw === undefined) return undefined
    try {
      return JSON.parse(raw)
    } catch {
      return undefined
    }
  }

  commit(snapshot: CatalogSnapshot, current: () => boolean): Promise<'applied' | 'conflict' | 'stale'> {
    const operation = this.queue.then(async () => {
      if (!this.initialized) await this.read()
      if (!current()) return 'stale' as const
      if (await this.readRaw() !== this.lastWritten) return 'conflict' as const
      const raw = JSON.stringify({ schemaVersion: 1, snapshot })
      const directory = path.dirname(this.file)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporary = path.join(directory, `.catalog-${randomUUID()}.tmp`)
      try {
        const handle = await open(temporary, 'wx', 0o600)
        try {
          await handle.writeFile(raw)
          await handle.sync()
        } finally {
          await handle.close()
        }
        if (!current()) return 'stale' as const
        if (await this.readRaw() !== this.lastWritten) return 'conflict' as const
        if (!current()) return 'stale' as const
        await rename(temporary, this.file)
        this.lastWritten = raw
        return 'applied' as const
      } finally {
        await rm(temporary, { force: true })
      }
    })
    this.queue = operation.catch(() => undefined)
    return operation
  }

  private async readRaw(): Promise<string | undefined> {
    try {
      const handle = await open(this.file, 'r')
      try {
        const metadata = await handle.stat()
        if (!metadata.isFile() || metadata.size > 32 * 1024 * 1024) throw new Error('Catalog manifest exceeds budget')
        return await handle.readFile('utf8')
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (object(error)?.code === 'ENOENT') return undefined
      throw error
    }
  }
}
