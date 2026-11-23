import { createHash, randomUUID } from 'node:crypto'
import { validPreparedMediaSignature } from '@cordisx/channel-runtime'
import { type ChannelOutboundMedia, type ChannelThreadRef, validateOutboundMedia } from '@cordisx/channel-runtime'

export type ChannelOutboundPreparationMetadata = Omit<ChannelOutboundMedia, 'handle'>

export interface ChannelOutboundPreparationOptions {
  readonly maximumCount?: number
  readonly maximumBytes?: number
  readonly now?: () => number
}

interface Upload {
  readonly scope: string
  readonly target: string
  readonly operationId: string
  readonly media: ChannelOutboundMedia
  readonly expires: number
  readonly bytes: Buffer
  readonly chunks: Map<number, { size: number; sha256: string }>
  offset: number
  sealed: boolean
}

const lifetime = 10 * 60 * 1000
const chunkLimit = 64 * 1024

function targetKey(target: ChannelThreadRef): string {
  if (
    !target || !['adapterId', 'accountId', 'tenantId', 'conversationId', 'threadId'].every(key => {
      const value = target[key as keyof ChannelThreadRef]
      return typeof value === 'string' && value.length > 0 && value.length <= 4096
    }) || !['direct', 'group', 'broadcast'].includes(target.kind)
    || !['conversation', 'topic', 'reply-chain'].includes(target.semantics)
  ) {
    throw new Error('MEDIA_TARGET_INVALID')
  }
  return JSON.stringify([
    target.adapterId,
    target.accountId,
    target.tenantId,
    target.conversationId,
    target.kind,
    target.threadId,
    target.semantics,
  ])
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export class ChannelOutboundPreparationStore {
  private readonly uploads = new Map<string, Upload>()
  private readonly handles = new Map<string, Upload>()
  private readonly maximumCount: number
  private readonly maximumBytes: number
  private readonly now: () => number
  private readonly timer: ReturnType<typeof setInterval>
  private totalBytes = 0
  private disposed = false

  constructor(options: ChannelOutboundPreparationOptions = {}) {
    this.maximumCount = options.maximumCount ?? 128
    this.maximumBytes = options.maximumBytes ?? 128 * 1024 * 1024
    this.now = options.now ?? Date.now
    if (![this.maximumCount, this.maximumBytes].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new Error('MEDIA_LIMIT_INVALID')
    }
    this.timer = setInterval(() => this.expire(), 60_000)
    this.timer.unref()
  }

  begin(
    scope: string,
    target: ChannelThreadRef,
    metadata: ChannelOutboundPreparationMetadata,
    operationId: string,
  ): string {
    this.assertLive()
    if (![scope, operationId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 4096)) {
      throw new Error('MEDIA_SCOPE_INVALID')
    }
    const targetScope = targetKey(target)
    const media = validateOutboundMedia({ ...metadata, handle: `media:${randomUUID()}` })
    this.expire()
    for (const [uploadId, existing] of this.uploads) {
      if (existing.scope !== scope || existing.operationId !== operationId) continue
      if (
        existing.target !== targetScope || JSON.stringify({ ...existing.media, handle: '' })
          !== JSON.stringify({ ...media, handle: '' })
      ) throw new Error('MEDIA_OPERATION_CONFLICT')
      return uploadId
    }
    if (this.uploads.size >= this.maximumCount || media.size > this.maximumBytes - this.totalBytes) {
      throw new Error('MEDIA_CAPACITY_UNAVAILABLE')
    }
    const bytes = Buffer.alloc(media.size)
    const uploadId = `upload:${randomUUID()}`
    this.uploads.set(uploadId, {
      scope,
      target: targetScope,
      operationId,
      media: Object.freeze(media),
      expires: this.now() + lifetime,
      bytes,
      chunks: new Map(),
      offset: 0,
      sealed: false,
    })
    this.totalBytes += media.size
    return uploadId
  }

  append(scope: string, uploadId: string, offset: number, bytesBase64: string): void {
    const upload = this.upload(scope, uploadId)
    if (upload.sealed) throw new Error('MEDIA_UPLOAD_SEALED')
    try {
      if (
        !Number.isSafeInteger(offset) || offset < 0 || typeof bytesBase64 !== 'string'
        || bytesBase64.length === 0 || bytesBase64.length > 4 * Math.ceil(chunkLimit / 3)
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(bytesBase64)
      ) {
        throw new Error('MEDIA_CHUNK_INVALID')
      }
      const bytes = Buffer.from(bytesBase64, 'base64')
      if (
        bytes.toString('base64') !== bytesBase64 || bytes.length > chunkLimit
        || bytes.length > upload.media.size - offset
      ) throw new Error('MEDIA_CHUNK_INVALID')
      const sha256 = digest(bytes)
      const previous = upload.chunks.get(offset)
      if (previous) {
        if (previous.size !== bytes.length || previous.sha256 !== sha256) throw new Error('MEDIA_CHUNK_CONFLICT')
        return
      }
      if (offset !== upload.offset) throw new Error('MEDIA_CHUNK_ORDER')
      bytes.copy(upload.bytes, offset)
      upload.chunks.set(offset, { size: bytes.length, sha256 })
      upload.offset += bytes.length
    } catch (error) {
      this.remove(uploadId, upload)
      throw error
    }
  }

  commit(scope: string, uploadId: string): ChannelOutboundMedia {
    const upload = this.upload(scope, uploadId)
    if (!upload.sealed) {
      if (
        upload.offset !== upload.media.size || digest(upload.bytes) !== upload.media.sha256
        || !validPreparedMediaSignature(upload.media.format, upload.bytes)
      ) {
        this.remove(uploadId, upload)
        throw new Error('MEDIA_INTEGRITY_INVALID')
      }
      upload.sealed = true
      upload.chunks.clear()
      this.handles.set(upload.media.handle, upload)
    }
    return { ...upload.media }
  }

  resolve(handle: string, target: ChannelThreadRef, maximumBytes: number): Uint8Array {
    const upload = this.handle(handle, target)
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || upload.media.size > maximumBytes) {
      throw new Error('MEDIA_SIZE_DENIED')
    }
    return Uint8Array.from(upload.bytes)
  }

  descriptor(scope: string, handle: string, target: ChannelThreadRef): ChannelOutboundMedia {
    const upload = this.handle(handle, target)
    if (upload.scope !== scope) throw new Error('MEDIA_SOURCE_DENIED')
    return { ...upload.media }
  }

  dispose(): void {
    this.disposed = true
    clearInterval(this.timer)
    this.uploads.clear()
    this.handles.clear()
    this.totalBytes = 0
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('MEDIA_STORE_DISPOSED')
  }

  private expire(): void {
    const now = this.now()
    for (const [uploadId, upload] of this.uploads) {
      if (upload.expires <= now) this.remove(uploadId, upload)
    }
  }

  private remove(uploadId: string, upload: Upload): void {
    this.uploads.delete(uploadId)
    this.handles.delete(upload.media.handle)
    this.totalBytes -= upload.media.size
  }

  private upload(scope: string, uploadId: string): Upload {
    this.assertLive()
    this.expire()
    const upload = this.uploads.get(uploadId)
    if (!upload || upload.scope !== scope) throw new Error('MEDIA_SOURCE_DENIED')
    return upload
  }

  private handle(handle: string, target: ChannelThreadRef): Upload {
    this.assertLive()
    this.expire()
    const upload = this.handles.get(handle)
    if (!upload || upload.target !== targetKey(target)) throw new Error('MEDIA_SOURCE_DENIED')
    return upload
  }
}
