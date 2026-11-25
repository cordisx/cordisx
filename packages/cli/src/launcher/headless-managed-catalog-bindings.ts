import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import path from 'node:path'

export interface HeadlessManagedCatalogBinding {
  readonly providerId: string
  readonly revision: string
}

const validText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value)
const validBinding = (value: unknown): value is HeadlessManagedCatalogBinding => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return Object.keys(row).sort().join(',') === 'providerId,revision'
    && typeof row.providerId === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(row.providerId)
    && validText(row.revision, 512)
}

/** Profile-owned evidence; never infer a catalog revision from historic thread metadata. */
export class HeadlessManagedCatalogBindings {
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
  private closing = false

  constructor(private readonly file: string) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed || this.closing) return Promise.reject(new Error('MANAGED_CATALOG_BINDINGS_CLOSED'))
    const next = this.tail.catch(() => undefined).then(operation)
    this.tail = next
    return next
  }

  private async load(): Promise<{ raw: string | undefined; entries: Record<string, HeadlessManagedCatalogBinding> }> {
    let raw: string
    try {
      const file = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const metadata = await file.stat()
        if (
          !metadata.isFile() || metadata.size > 16 * 1024 * 1024 || (metadata.mode & 0o077) !== 0
          || process.getuid && metadata.uid !== process.getuid()
        ) throw new Error('MANAGED_CATALOG_BINDINGS_INVALID')
        raw = await file.readFile('utf8')
      } finally {
        await file.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { raw: undefined, entries: Object.create(null) }
      throw new Error('MANAGED_CATALOG_BINDINGS_INVALID')
    }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error('MANAGED_CATALOG_BINDINGS_INVALID')
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MANAGED_CATALOG_BINDINGS_INVALID')
    const record = value as Record<string, unknown>
    if (
      Object.keys(record).sort().join(',') !== 'entries,version' || record.version !== 1
      || !record.entries || typeof record.entries !== 'object' || Array.isArray(record.entries)
    ) {
      throw new Error('MANAGED_CATALOG_BINDINGS_INVALID')
    }
    const entries: Record<string, HeadlessManagedCatalogBinding> = Object.create(null)
    for (const [threadId, binding] of Object.entries(record.entries)) {
      if (!validText(threadId, 512) || !validBinding(binding)) throw new Error('MANAGED_CATALOG_BINDINGS_INVALID')
      entries[threadId] = binding
    }
    return { raw, entries }
  }

  read(threadId: string): Promise<HeadlessManagedCatalogBinding | undefined> {
    if (!validText(threadId, 512)) return Promise.reject(new Error('MANAGED_CATALOG_BINDING_INVALID'))
    return this.serial(async () => {
      const value = (await this.load()).entries[threadId]
      return value ? Object.freeze({ ...value }) : undefined
    })
  }

  record(threadId: string, binding: HeadlessManagedCatalogBinding): Promise<void> {
    if (!validText(threadId, 512) || !validBinding(binding)) {
      return Promise.reject(new Error('MANAGED_CATALOG_BINDING_INVALID'))
    }
    return this.serial(async () => {
      const { raw, entries } = await this.load()
      const existing = entries[threadId]
      if (existing) {
        if (existing.providerId !== binding.providerId || existing.revision !== binding.revision) {
          throw new Error('MANAGED_CATALOG_BINDING_CONFLICT')
        }
        return
      }
      entries[threadId] = { ...binding }
      const data = JSON.stringify({ version: 1, entries }) + '\n'
      if (Buffer.byteLength(data) > 16 * 1024 * 1024) throw new Error('MANAGED_CATALOG_BINDINGS_FULL')
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const temporary = path.join(path.dirname(this.file), `.managed-catalog-${randomUUID()}`)
      try {
        const file = await open(temporary, 'wx', 0o600)
        try {
          await file.writeFile(data)
          await file.sync()
        } finally {
          await file.close()
        }
        if ((await this.load()).raw !== raw) throw new Error('MANAGED_CATALOG_BINDING_CONFLICT')
        await rename(temporary, this.file)
      } finally {
        await rm(temporary, { force: true })
      }
    })
  }

  async close(): Promise<void> {
    this.closing = true
    await this.tail.catch(() => undefined)
    this.closed = true
  }
}
