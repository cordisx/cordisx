import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ChannelConversationRef, ChannelTenantRef } from '@cordisx/channel-runtime'
import type { RasterImageSnapshotV1 } from '@cordisx/protocol/raster-image/v1'
import { cloneBrandIconV1 } from '@cordisx/protocol/brand-icon/v1'

export interface ChannelConversationDisplay {
  readonly ref: ChannelConversationRef
  readonly name?: string
  readonly avatar?: RasterImageSnapshotV1
  readonly updatedAt: string
}

const MAX_RECORDS = 5_000
const MAX_FILE_BYTES = 8_388_608
const accountKey = (ref: ChannelTenantRef) => JSON.stringify([ref.adapterId, ref.accountId, ref.tenantId])
const recordKey = (ref: ChannelConversationRef) => JSON.stringify([accountKey(ref), ref.conversationId, ref.kind])
const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value)

export function conversationDisplayName(value: unknown, ref: ChannelConversationRef): string | undefined {
  if (typeof value !== 'string' || value === ref.conversationId) return undefined
  const name = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 120)
  return name && name !== ref.conversationId && !/^(?:oc_|ou_)[A-Za-z0-9_]+$/u.test(name) ? name : undefined
}

function avatarSnapshot(value: RasterImageSnapshotV1 | undefined): RasterImageSnapshotV1 | undefined {
  if (value === undefined) return undefined
  try {
    const icon = cloneBrandIconV1({ kind: 'raster-image', image: value })
    return typeof icon === 'string' ? undefined : Object.freeze(icon.image)
  } catch {
    return undefined
  }
}

/** Display hints only. No messages, credentials, membership authority or issued capability tokens. */
export class ChannelConversationDisplayStore {
  private readonly records = new Map<string, ChannelConversationDisplay>()
  private writes: Promise<void> = Promise.resolve()
  private allowedAccounts?: ReadonlySet<string>
  private dirty = false
  private saving = false
  private disposed = false

  constructor(private readonly file?: string) {}

  static async open(file: string): Promise<ChannelConversationDisplayStore> {
    const store = new ChannelConversationDisplayStore(file)
    try {
      if ((await stat(file)).size > MAX_FILE_BYTES) return store
      const data = JSON.parse(await readFile(file, 'utf8')) as { schemaVersion?: unknown; records?: unknown }
      if (
        data.schemaVersion !== 1 || !Array.isArray(data.records) || data.records.length > MAX_RECORDS
        || Object.keys(data).some(key => !['schemaVersion', 'records'].includes(key))
      ) return store
      for (const value of data.records as ChannelConversationDisplay[]) {
        const ref = value?.ref
        if (
          !ref || !['direct', 'group', 'broadcast'].includes(ref.kind)
          || ![ref.adapterId, ref.accountId, ref.tenantId, ref.conversationId].every(validId)
          || Object.keys(ref).some(key =>
            !['adapterId', 'accountId', 'tenantId', 'conversationId', 'kind'].includes(key)
          )
          || Object.keys(value).some(key => !['ref', 'name', 'avatar', 'updatedAt'].includes(key))
          || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
        ) continue
        const name = conversationDisplayName(value.name, ref), avatar = avatarSnapshot(value.avatar)
        if (!name && !avatar) continue
        store.records.set(
          recordKey(ref),
          Object.freeze({
            ref: Object.freeze({ ...ref }),
            ...(name === undefined ? {} : { name }),
            ...(avatar === undefined ? {} : { avatar }),
            updatedAt: value.updatedAt,
          }),
        )
      }
    } catch { /* A missing or corrupt display cache cannot prevent startup. */ }
    return store
  }

  get(ref: ChannelConversationRef): ChannelConversationDisplay | undefined {
    return this.records.get(recordKey(ref))
  }

  list(ref: ChannelTenantRef): readonly ChannelConversationDisplay[] {
    const account = accountKey(ref)
    return [...this.records.values()].filter(value => accountKey(value.ref) === account)
  }

  retainAccounts(refs: readonly ChannelTenantRef[]): void {
    if (this.disposed) return
    const allowed = new Set(refs.map(accountKey))
    this.allowedAccounts = allowed
    let changed = false
    for (const [key, value] of this.records) {
      if (!allowed.has(accountKey(value.ref))) {
        this.records.delete(key)
        changed = true
      }
    }
    if (changed) this.persist()
  }

  put(
    ref: ChannelConversationRef,
    value: { readonly name?: string | undefined; readonly avatar?: RasterImageSnapshotV1 | undefined },
  ): void {
    if (this.disposed || this.allowedAccounts && !this.allowedAccounts.has(accountKey(ref))) return
    const key = recordKey(ref), prior = this.records.get(key)
    const name = conversationDisplayName(value.name, ref) ?? prior?.name
    const avatar = avatarSnapshot(value.avatar) ?? prior?.avatar
    if (!name && !avatar || name === prior?.name && avatar?.data === prior?.avatar?.data) return
    this.records.delete(key)
    this.records.set(
      key,
      Object.freeze({
        ref: Object.freeze({
          adapterId: ref.adapterId,
          accountId: ref.accountId,
          tenantId: ref.tenantId,
          conversationId: ref.conversationId,
          kind: ref.kind,
        }),
        ...(name === undefined ? {} : { name }),
        ...(avatar === undefined ? {} : { avatar }),
        updatedAt: new Date().toISOString(),
      }),
    )
    this.persist()
  }

  private persist(): void {
    if (!this.file) return
    this.dirty = true
    if (this.saving) return
    this.saving = true
    // Batch a directory page into one snapshot instead of rewriting for every row.
    this.writes = this.writes.then(async () => {
      while (this.dirty) {
        this.dirty = false
        await this.write(this.payload())
      }
    }).catch(() => undefined).finally(() => {
      this.saving = false
      if (this.dirty) this.persist()
    })
  }

  private payload(): string {
    // Bounds apply only to disposable display hints, never to real relationships.
    while (this.records.size > MAX_RECORDS) this.records.delete(this.records.keys().next().value!)
    let payload = JSON.stringify({ schemaVersion: 1, records: [...this.records.values()] })
    if (Buffer.byteLength(payload) > MAX_FILE_BYTES) {
      for (const [key, value] of this.records) {
        if (!value.avatar) continue
        const { avatar: _image, ...name } = value
        this.records.set(key, Object.freeze(name))
      }
      payload = JSON.stringify({ schemaVersion: 1, records: [...this.records.values()] })
      while (Buffer.byteLength(payload) > MAX_FILE_BYTES && this.records.size) {
        this.records.delete(this.records.keys().next().value!)
        payload = JSON.stringify({ schemaVersion: 1, records: [...this.records.values()] })
      }
    }
    return payload
  }

  private async write(payload: string): Promise<void> {
    const file = this.file!
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(payload)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, file)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  async flush(): Promise<void> {
    while (this.saving) await this.writes
  }

  async close(): Promise<void> {
    this.disposed = true
    await this.flush()
  }
}
