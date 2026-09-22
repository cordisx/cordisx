import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { LauncherKeychainBackend } from '../secret-store.js'
import { CatalogError, object } from './contracts.js'

/** Encrypted profile state. Only the credential owner constructs this, under its exclusive lock. */
export class ManagedCatalogState {
  private raw: string | undefined
  private initialized = false

  constructor(
    private readonly file: string,
    private readonly backend: LauncherKeychainBackend,
    private readonly service: string,
    private readonly current: () => Promise<void>,
  ) {}

  private async readRaw(): Promise<string | undefined> {
    try {
      const handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size > 24 * 1024 * 1024 || (stat.mode & 0o077) !== 0) {
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

  private async key(create: boolean): Promise<Buffer> {
    if (await this.backend.status(this.service, 'catalog-state-key') === 'unset') {
      if (!create) throw new CatalogError('credential-unavailable')
      await this.backend.upsert(this.service, 'catalog-state-key', randomBytes(32).toString('base64url'))
    }
    const key = Buffer.from(await this.backend.read(this.service, 'catalog-state-key'), 'base64url')
    if (key.length !== 32) throw new CatalogError('credential-unavailable')
    return key
  }

  async read(): Promise<unknown> {
    await this.current()
    const raw = await this.readRaw()
    this.raw = raw
    this.initialized = true
    if (raw === undefined) return undefined
    try {
      const data = object(JSON.parse(raw))
      if (
        !data || data.version !== 1 || typeof data.iv !== 'string' || typeof data.tag !== 'string'
        || typeof data.body !== 'string'
      ) throw new Error('invalid')
      const key = await this.key(false)
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(data.iv, 'base64'))
        decipher.setAAD(Buffer.from(this.service))
        decipher.setAuthTag(Buffer.from(data.tag, 'base64'))
        const plain = Buffer.concat([decipher.update(Buffer.from(data.body, 'base64')), decipher.final()])
        await this.current()
        return JSON.parse(plain.toString('utf8'))
      } finally {
        key.fill(0)
      }
    } catch {
      throw new CatalogError('source-invalid')
    }
  }

  async write(value: unknown, authorized: () => boolean): Promise<void> {
    if (!this.initialized) await this.read()
    const plain = JSON.stringify(value)
    if (Buffer.byteLength(plain) > 16 * 1024 * 1024) throw new CatalogError('source-invalid')
    await this.current()
    if (!authorized()) throw new CatalogError('permission')
    if (await this.readRaw() !== this.raw) throw new CatalogError('source-invalid')
    const key = await this.key(true)
    let raw: string
    try {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(Buffer.from(this.service))
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      raw = JSON.stringify({
        version: 1,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        body: body.toString('base64'),
      })
    } finally {
      key.fill(0)
    }
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
