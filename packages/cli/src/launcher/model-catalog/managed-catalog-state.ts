import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { CatalogError, object } from './contracts.js'

/** Plaintext profile state. Only the Provider owner constructs this, under its exclusive lock. */
export class ManagedCatalogState {
  private raw: string | undefined
  private initialized = false

  constructor(
    private readonly file: string,
    private readonly current: () => Promise<void>,
  ) {}

  private async readRaw(): Promise<string | undefined> {
    try {
      const handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await handle.stat()
        if (
          !stat.isFile() || stat.size > 24 * 1024 * 1024 || (stat.mode & 0o077) !== 0
          || process.getuid && stat.uid !== process.getuid()
        ) {
          throw new CatalogError('source-invalid')
        }
        return await handle.readFile('utf8')
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (object(error)?.code === 'ENOENT') return undefined
      throw error
    }
  }

  async read(): Promise<unknown> {
    await this.current()
    const raw = await this.readRaw()
    this.raw = raw
    this.initialized = true
    if (raw === undefined) return undefined
    try {
      const value = JSON.parse(raw) as unknown
      await this.current()
      return value
    } catch {
      throw new CatalogError('source-invalid')
    }
  }

  async write(value: unknown, authorized: () => boolean): Promise<void> {
    if (!this.initialized) await this.read()
    const raw = JSON.stringify(value)
    if (raw === undefined) throw new CatalogError('source-invalid')
    if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw new CatalogError('source-invalid')
    await this.current()
    if (!authorized()) throw new CatalogError('permission')
    if (await this.readRaw() !== this.raw) throw new CatalogError('source-invalid')
    const temporary = path.join(path.dirname(this.file), `.state-${randomUUID()}`)
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(raw)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.current()
      if (!authorized()) throw new CatalogError('permission')
      if (await this.readRaw() !== this.raw) throw new CatalogError('source-invalid')
      await rename(temporary, this.file)
      this.raw = raw
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
