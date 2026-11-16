import type { RasterImageSnapshotV1 } from '@cordisx/protocol/raster-image/v1'
import type { ChannelTenantRef } from '@cordisx/channel-runtime'
import { cloneBrandIconV1 } from '@cordisx/protocol/brand-icon/v1'

export interface ChannelAccountIdentity {
  readonly accountName?: string
  readonly accountAvatar?: RasterImageSnapshotV1
}

export interface FeishuBotProfile {
  readonly name?: string
  /** Private authenticated provider response; never a renderer field. */
  readonly avatarUrl?: string
}

const MAX_IMAGE_BYTES = 2_097_152

function avatarUrl(value: string): URL {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== ''
    || !['feishucdn.com', 'larksuitecdn.com', 'larkofficecdn.com'].some(domain =>
      url.hostname === domain || url.hostname.endsWith(`.${domain}`)
    )
  ) throw new Error('channel-account-avatar-source-unavailable')
  return url
}

/** Downloads artwork without account headers and returns only a normalized small PNG. */
export async function loadChannelAccountAvatar(value: string, signal: AbortSignal): Promise<RasterImageSnapshotV1> {
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(5_000)])
  let url = avatarUrl(value)
  let response: Response | undefined
  for (let redirect = 0; redirect < 3; redirect += 1) {
    response = await fetch(url, { signal: lifetime, redirect: 'manual', credentials: 'omit' })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (location === null) throw new Error('channel-account-avatar-unavailable')
    url = avatarUrl(new URL(location, url).href)
  }
  if (response === undefined || !response.ok || response.body === null) {
    throw new Error('channel-account-avatar-unavailable')
  }
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_IMAGE_BYTES) {
    await response.body.cancel()
    throw new Error('channel-account-avatar-too-large')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > MAX_IMAGE_BYTES) throw new Error('channel-account-avatar-too-large')
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  lifetime.throwIfAborted()
  const { default: sharp } = await import('sharp')
  const bytes = Buffer.concat(chunks, length)
  const image = sharp(bytes, { limitInputPixels: 4_194_304, failOn: 'error' })
  const metadata = await image.metadata()
  if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1) {
    throw new Error('channel-account-avatar-format-unavailable')
  }
  const png = await image.rotate().resize(128, 128, { fit: 'cover' }).toColourspace('srgb').ensureAlpha().png()
    .toBuffer()
  lifetime.throwIfAborted()
  const icon = cloneBrandIconV1({
    kind: 'raster-image',
    image: {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/raster-image-snapshot.v1.schema.json',
      contract: 'cordisx.raster-image-snapshot/v1',
      schemaVersion: 1,
      mediaType: 'image/png',
      encoding: 'base64',
      data: png.toString('base64'),
      width: 128,
      height: 128,
    },
  })
  if (typeof icon === 'string') throw new Error('channel-account-avatar-invalid')
  return icon.image
}

function accountKey(ref: ChannelTenantRef): string {
  return JSON.stringify([ref.adapterId, ref.accountId, ref.tenantId])
}

/** Memory belongs to one launcher generation. It is never written to config or a database. */
export class ChannelAccountIdentityStore {
  private readonly lifetime = new AbortController()
  private readonly records = new Map<
    string,
    { profile: ChannelAccountIdentity; avatarUrl?: string; revision: number }
  >()
  private readonly pending = new Set<Promise<void>>()

  constructor(private readonly loadAvatar = loadChannelAccountAvatar) {}

  receive(ref: ChannelTenantRef, input: FeishuBotProfile): void {
    if (this.lifetime.signal.aborted) return
    const key = accountKey(ref)
    if (!this.records.has(key) && this.records.size >= 256) return
    const prior = this.records.get(key)
    const name = input.name?.replace(/[\u0000-\u001F\u007F]/gu, '\uFFFD').trim()
    const accountName = name === undefined || name === '' ? undefined : Array.from(name).slice(0, 256).join('')
    const source = input.avatarUrl !== undefined && input.avatarUrl.length <= 4_096 ? input.avatarUrl : undefined
    if (prior?.avatarUrl === source && prior?.profile.accountName === accountName) return
    if (prior !== undefined && prior.avatarUrl === source) {
      const { accountName: _priorName, ...artwork } = prior.profile
      prior.profile = Object.freeze({ ...artwork, ...(accountName === undefined ? {} : { accountName }) })
      return
    }
    const record = {
      profile: Object.freeze({
        ...(accountName === undefined ? {} : { accountName }),
      }) as ChannelAccountIdentity,
      ...(source === undefined ? {} : { avatarUrl: source }),
      revision: (prior?.revision ?? 0) + 1,
    }
    this.records.set(key, record)
    if (source === undefined) return
    const work = this.loadAvatar(source, this.lifetime.signal).then(image => {
      if (this.lifetime.signal.aborted || this.records.get(key) !== record) return
      const icon = cloneBrandIconV1({ kind: 'raster-image', image })
      if (typeof icon === 'string') return
      record.profile = Object.freeze({ ...record.profile, accountAvatar: icon.image })
    }).catch(() => undefined)
    this.pending.add(work)
    void work.finally(() => this.pending.delete(work))
  }

  snapshot(ref: ChannelTenantRef): ChannelAccountIdentity | undefined {
    return this.records.get(accountKey(ref))?.profile
  }

  async dispose(): Promise<void> {
    this.lifetime.abort()
    this.records.clear()
    await Promise.allSettled(this.pending)
    this.pending.clear()
  }
}
