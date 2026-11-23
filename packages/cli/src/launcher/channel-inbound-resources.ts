import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import type { ChannelContentBlock, ChannelEventRef, ChannelThreadRef, ChannelUserInput } from '@cordisx/channel-runtime'
import type { ChannelOutboundMedia } from '@cordisx/channel-runtime'
import { validateOutboundMedia } from '@cordisx/channel-runtime'

const scope = (event: ChannelEventRef) =>
  JSON.stringify([
    event.adapterId,
    event.accountId,
    event.tenantId,
    event.conversationId,
    event.threadId,
    event.eventId,
    event.messageId,
    event.actor?.userId,
  ])
const entries = new Map<
  string,
  { scope: string; file: string; mediaType: string; expires: number; size: number; name?: string }
>()
const tickets = new Map<string, { expires: number; images: string[]; text: string; handles: string[] }>()
let root: Promise<string> | undefined
const lifetime = 60 * 60 * 1000

export class ChannelInboundResources {
  private readonly outbound = new Map<string, { attachment: string; target: string }>()
  private disposed = false
  private totalBytes = 0
  private readonly active = new Set<Readable>()
  private readonly handles = new Set<string>()
  private readonly directory = (async () => {
    root ??= mkdtemp(path.join(os.tmpdir(), 'cordisx-channel-resources-'))
    const directory = path.join(await root, randomUUID())
    await mkdir(directory, { mode: 0o700 })
    return directory
  })()
  private readonly timer = setInterval(() => {
    void this.expire()
  }, 60_000)
  constructor() {
    this.timer.unref()
  }
  async grantOutbound(
    handle: string,
    source: ChannelEventRef,
    target: ChannelThreadRef,
  ): Promise<ChannelOutboundMedia> {
    const entry = entries.get(handle)
    if (
      this.disposed || !entry || !this.handles.has(handle) || entry.scope !== scope(source)
      || entry.expires <= Date.now()
      || threadScope(source) !== threadScope(target)
    ) throw new Error('RESOURCE_SOURCE_DENIED')
    const format = entry.mediaType === 'image/png' ? 'png' : entry.mediaType === 'image/jpeg'
      ? 'jpeg'
      : entry.mediaType === 'audio/ogg'
      ? 'opus'
      : entry.mediaType === 'application/pdf'
      ? 'pdf'
      : entry.mediaType === 'video/mp4'
      ? 'mp4'
      : entry.mediaType === 'application/octet-stream'
      ? 'binary'
      : undefined
    if (!format) throw new Error('RESOURCE_OUTBOUND_FORMAT_UNSUPPORTED')
    const bytes = await boundedResourceBytes(entry.file, entry.size)
    const token = `media:${randomUUID()}`
    const media = validateOutboundMedia({
      type: format === 'opus'
        ? 'audio'
        : format === 'mp4'
        ? 'video'
        : format === 'pdf' || format === 'binary'
        ? 'file'
        : 'image',
      handle: token,
      format,
      size: entry.size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(format === 'pdf' || format === 'mp4' || format === 'binary'
        ? { filename: entry.name ?? (format === 'binary' ? 'attachment.bin' : `attachment.${format}`) }
        : {}),
    })
    this.outbound.set(token, { attachment: handle, target: threadScope(target) })
    return media
  }
  async resolve(handle: string, target: ChannelThreadRef, maximumBytes: number): Promise<Uint8Array> {
    const grant = this.outbound.get(handle)
    const entry = grant && entries.get(grant.attachment)
    if (
      this.disposed || !grant || grant.target !== threadScope(target) || !entry
      || entry.expires <= Date.now() || !Number.isSafeInteger(maximumBytes) || maximumBytes <= 0
      || entry.size > maximumBytes
    ) throw new Error('RESOURCE_SOURCE_DENIED')
    return boundedResourceBytes(entry.file, maximumBytes)
  }
  ownsOutbound(handle: string): boolean {
    return this.outbound.has(handle)
  }
  async ingest(
    event: ChannelEventRef,
    stream: Readable,
    kind: string,
    name?: string,
    resourceKey = '',
  ): Promise<ChannelContentBlock> {
    if (this.disposed || this.active.size >= 4 || this.handles.size >= 128) {
      stream.destroy()
      throw new Error('RESOURCE_CAPACITY_UNAVAILABLE')
    }
    this.active.add(stream)
    const timeout = setTimeout(() => stream.destroy(new Error('RESOURCE_TIMEOUT')), 30_000)
    timeout.unref()
    const maximum = kind === 'image' ? 10_000_000 : 30_000_000
    const handle = `attachment:${createHash('sha256').update(scope(event)).update(resourceKey).digest('hex')}`
    const existing = entries.get(handle)
    if (existing && existing.expires > Date.now()) {
      clearTimeout(timeout)
      this.active.delete(stream)
      stream.destroy()
      return {
        type: 'attachment',
        handle,
        mediaType: existing.mediaType,
        size: existing.size,
        ...(existing.name ? { name: existing.name } : {}),
      }
    }
    const file = path.join(await this.directory, randomUUID())
    const output = await open(file, 'wx', 0o600).catch(error => {
      clearTimeout(timeout)
      this.active.delete(stream)
      stream.destroy()
      throw error
    })
    let size = 0
    let reserved = 0
    let header = Buffer.alloc(0)
    try {
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += bytes.length
        if (size > maximum || this.totalBytes + bytes.length > 100_000_000 || this.disposed) {
          throw new Error('RESOURCE_TOO_LARGE')
        }
        this.totalBytes += bytes.length
        reserved += bytes.length
        if (header.length < 64) header = Buffer.concat([header, bytes.subarray(0, 64 - header.length)])
        await output.writeFile(bytes)
      }
      if (!size) throw new Error('RESOURCE_EMPTY')
      const mediaType = header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? 'image/png'
        : header.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
        ? 'image/jpeg'
        : header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP'
        ? 'image/webp'
        : header.toString('ascii', 0, 4) === 'OggS'
        ? 'audio/ogg'
        : header.toString('ascii', 4, 8) === 'ftyp'
        ? 'video/mp4'
        : header.toString('ascii', 0, 5) === '%PDF-'
        ? 'application/pdf'
        : 'application/octet-stream'
      if (kind === 'image' && !mediaType.startsWith('image/')) throw new Error('RESOURCE_IMAGE_FORMAT_UNSUPPORTED')
      const filename = name
        ? path.basename(name.replace(/\\/gu, '/')).replace(/[\x00-\x1f\x7f]/gu, '').trim().slice(0, 255)
        : undefined
      const safeName = filename && filename !== '.' && filename !== '..' && !filename.endsWith('.')
        ? filename
        : undefined
      entries.set(handle, {
        scope: scope(event),
        file,
        mediaType,
        expires: Date.now() + lifetime,
        size,
        ...(safeName ? { name: safeName } : {}),
      })
      this.handles.add(handle)
      return {
        type: 'attachment',
        handle,
        mediaType,
        size,
        ...(safeName ? { name: safeName } : {}),
      }
    } catch (error) {
      stream.destroy()
      this.totalBytes -= reserved
      await rm(file, { force: true })
      throw error
    } finally {
      clearTimeout(timeout)
      this.active.delete(stream)
      await output.close()
    }
  }
  private async expire() {
    for (const handle of this.handles) {
      const entry = entries.get(handle)
      if (entry && entry.expires <= Date.now()) {
        entries.delete(handle)
        this.handles.delete(handle)
        this.totalBytes -= entry.size
        await rm(entry.file, { force: true })
      }
    }
  }
  async dispose() {
    this.disposed = true
    for (const stream of this.active) stream.destroy()
    clearInterval(this.timer)
    for (const handle of this.handles) entries.delete(handle)
    this.handles.clear()
    this.outbound.clear()
    await rm(await this.directory, { recursive: true, force: true })
  }
}

const threadScope = (event: ChannelThreadRef) =>
  JSON.stringify([
    event.adapterId,
    event.accountId,
    event.tenantId,
    event.conversationId,
    event.threadId,
    event.kind,
    event.semantics,
  ])

async function boundedResourceBytes(file: string, maximum: number): Promise<Buffer> {
  const input = await open(file, 'r')
  try {
    const info = await input.stat()
    if (!info.isFile() || info.size <= 0 || info.size > maximum) throw new Error('RESOURCE_TOO_LARGE')
    const bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = await input.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) throw new Error('RESOURCE_CHANGED')
      offset += read.bytesRead
    }
    return bytes
  } finally {
    await input.close()
  }
}

export async function channelAttachmentTicket(message: ChannelUserInput): Promise<string | undefined> {
  const attachments = message.content.filter(block => block.type === 'attachment')
  if (!attachments.length) return undefined
  const images: string[] = [], descriptions: string[] = [], handles: string[] = []
  for (const block of attachments) {
    const entry = entries.get(block.handle)
    if (!entry || entry.scope !== scope(message.source.event) || entry.expires <= Date.now()) {
      descriptions.push('[Attachment unavailable: expired, revoked, or source mismatch]')
      continue
    }
    if (!(await stat(entry.file).catch(() => undefined))?.isFile()) {
      descriptions.push('[Attachment unavailable: local resource missing]')
      continue
    }
    if (entry.mediaType.startsWith('image/')) images.push(entry.file)
    else {descriptions.push(
        JSON.stringify({
          attachment: block.name ?? 'attachment',
          mediaType: entry.mediaType,
          localFile: entry.file,
          handling:
            'Read only if your tools and sandbox support this file. No automatic transcription or video understanding is provided.',
        }),
      )}
    handles.push(block.handle)
  }
  for (const [ticket, entry] of tickets) if (entry.expires <= Date.now()) tickets.delete(ticket)
  if (tickets.size >= 128) throw new Error('ATTACHMENT_TICKETS_BUSY')
  const ticket = randomUUID()
  tickets.set(ticket, { images, text: descriptions.join('\n'), handles, expires: Date.now() + 60_000 })
  return ticket
}

export function consumeChannelAttachmentTicket(value: unknown): { images: string[]; text: string } {
  if (value === undefined) return { images: [], text: '' }
  if (typeof value !== 'string') throw new Error('ATTACHMENT_TICKET_INVALID')
  const entry = tickets.get(value)
  tickets.delete(value)
  if (!entry || entry.expires <= Date.now()) throw new Error('ATTACHMENT_TICKET_INVALID')
  if (entry.handles.some(handle => !entries.has(handle) || entries.get(handle)!.expires <= Date.now())) {
    throw new Error('ATTACHMENT_TICKET_REVOKED')
  }
  return { images: entry.images, text: entry.text }
}

export function channelNativeResourceInput(prompt: string, ticket?: unknown) {
  const attachments = consumeChannelAttachmentTicket(ticket)
  return [
    { type: 'text', text: [prompt, attachments.text].filter(Boolean).join('\n'), text_elements: [] },
    ...attachments.images.map(file => ({ type: 'localImage', path: file })),
  ]
}
