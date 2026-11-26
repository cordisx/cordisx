import type {
  ChannelEventRef,
  ChannelOutboundMedia,
  ChannelTenantRef,
  ChannelThreadRef,
} from '@cordisx/channel-runtime'
import {
  richtextRequirementsV3,
  v3MentionContent,
  validateOutboundContent,
  validateOutboundFallback,
} from '@cordisx/channel-runtime'
import { createHash } from 'node:crypto'
import { type ChannelSendPayload, validateChannelSendPayload } from '../cli/channel-send-payload.js'
import { ChannelOutboundPreparationStore } from './channel-outbound-preparation.js'
import { channelReplyMode, channelReplyTarget } from './channel-reply-routing.js'

export interface ChannelPreparedMediaAuthority {
  resolve(handle: string, target: ChannelThreadRef, maximumBytes: number): Promise<Uint8Array>
}

export interface ChannelOutboundRpcCaller {
  readonly session?: string | undefined
  readonly turnId?: string | undefined
  readonly source?: ChannelEventRef | undefined
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST')
  return value as Record<string, unknown>
}
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\0\r\n]/u.test(value)) {
    throw new Error('INVALID_REQUEST')
  }
  return value
}

export function outboundCallerScope(caller: ChannelOutboundRpcCaller): string {
  const source = caller.source
  return createHash('sha256').update(JSON.stringify([
    caller.session ?? 'local-cli',
    caller.turnId ?? null,
    source
      ? [
        source.adapterId,
        source.accountId,
        source.tenantId,
        source.conversationId,
        source.kind,
        source.threadId,
        source.semantics,
        source.eventId,
        source.messageId ?? null,
        source.actor ?? null,
      ]
      : null,
  ])).digest('hex')
}

export function parseOutboundTarget(value: unknown, ref: ChannelTenantRef, operationId: string): ChannelThreadRef {
  const raw = record(value)
  if (Object.keys(raw).some(key => !['id', 'kind', 'replyTo', 'replyMode'].includes(key))) {
    throw new Error('INVALID_REQUEST')
  }
  const id = text(raw.id)
  if (
    !['direct', 'group'].includes(String(raw.kind)) || !/^(?:oc_|ou_)[A-Za-z0-9_]+$/u.test(id)
    || raw.kind === 'group' && !id.startsWith('oc_')
  ) throw new Error('INVALID_TARGET')
  const replyTo = raw.replyTo === undefined ? undefined : text(raw.replyTo)
  if (replyTo !== undefined && (!id.startsWith('oc_') || !/^om_[A-Za-z0-9_]+$/u.test(replyTo))) {
    throw new Error('INVALID_TARGET')
  }
  const mode = raw.replyMode === undefined
    ? replyTo === undefined ? 'conversation' : 'reply'
    : channelReplyMode(raw.replyMode)
  if (mode === 'none' || mode === 'agent' || mode === 'conversation' && replyTo !== undefined) {
    throw new Error('INVALID_REPLY_MODE')
  }
  return channelReplyTarget({
    ...ref,
    conversationId: id,
    kind: raw.kind as 'direct' | 'group',
    threadId: id,
    semantics: 'conversation',
    eventId: operationId,
    ...(replyTo === undefined ? {} : { messageId: replyTo }),
  }, mode)
}

export class ChannelOutboundRpc {
  readonly store = new ChannelOutboundPreparationStore()
  readonly authority: ChannelPreparedMediaAuthority = {
    resolve: async (handle, target, maximumBytes) => this.store.resolve(handle, target, maximumBytes),
  }
  private readonly uploads = new Map<string, { scope: string; target: ChannelThreadRef; expires: number }>()

  prepare(
    input: Record<string, unknown>,
    caller: ChannelOutboundRpcCaller,
    accounts: readonly { ref: ChannelTenantRef; state: string }[],
    authorize: (target: ChannelThreadRef) => void,
  ): unknown {
    for (const [id, entry] of this.uploads) if (entry.expires <= Date.now()) this.uploads.delete(id)
    const scope = outboundCallerScope(caller)
    if (input.action === 'begin') {
      if (
        Object.keys(input).some(key =>
          ![
            'action',
            'account',
            'target',
            'operationId',
            'type',
            'mediaType',
            'format',
            'name',
            'filename',
            'size',
            'sha256',
            'durationMs',
          ].includes(key)
        )
      ) throw new Error('INVALID_REQUEST')
      const raw = record(input.account)
      if (Object.keys(raw).some(key => !['adapterId', 'accountId', 'tenantId'].includes(key))) {
        throw new Error('INVALID_REQUEST')
      }
      const ref = { adapterId: text(raw.adapterId), accountId: text(raw.accountId), tenantId: text(raw.tenantId) }
      this.ready(accounts, ref)
      const operationId = text(input.operationId)
      if (operationId.length > 128) throw new Error('INVALID_REQUEST')
      const target = parseOutboundTarget(input.target, ref, operationId)
      authorize(target)
      const formats: Record<string, ChannelOutboundMedia['format']> = {
        'image/png': 'png',
        'image/jpeg': 'jpeg',
        'audio/ogg': 'opus',
        'video/mp4': 'mp4',
        'application/pdf': 'pdf',
        'application/octet-stream': 'binary',
      }
      const format = typeof input.mediaType === 'string' && Object.hasOwn(formats, input.mediaType)
        ? formats[input.mediaType]
        : undefined
      if (
        input.mediaType !== undefined && !format
        || input.format !== undefined && format !== undefined && input.format !== format
      ) throw new Error('INVALID_MEDIA_FORMAT')
      const selectedFormat = input.format ?? format
      if (!selectedFormat) throw new Error('INVALID_MEDIA_FORMAT')
      if (input.name !== undefined && input.filename !== undefined && input.name !== input.filename) {
        throw new Error('INVALID_REQUEST')
      }
      const filename = input.filename ?? input.name
      const uploadId = this.store.begin(scope, target, {
        type: input.type as ChannelOutboundMedia['type'],
        format: selectedFormat as ChannelOutboundMedia['format'],
        size: input.size as number,
        sha256: input.sha256 as string,
        ...(filename === undefined ? {} : { filename: filename as string }),
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs as number }),
      }, operationId)
      if (!this.uploads.has(uploadId)) this.uploads.set(uploadId, { scope, target, expires: Date.now() + 600000 })
      return { status: 'ok', uploadId }
    }
    const allowed = input.action === 'chunk' ? ['action', 'uploadId', 'offset', 'bytesBase64'] : ['action', 'uploadId']
    if (!['chunk', 'commit'].includes(String(input.action)) || Object.keys(input).some(key => !allowed.includes(key))) {
      throw new Error('INVALID_REQUEST')
    }
    const uploadId = text(input.uploadId)
    const entry = this.uploads.get(uploadId)
    if (!entry || entry.scope !== scope) throw new Error('MEDIA_SOURCE_DENIED')
    this.ready(accounts, entry.target)
    authorize(entry.target)
    if (input.action === 'chunk') {
      try {
        this.store.append(scope, uploadId, input.offset as number, input.bytesBase64 as string)
      } catch (error) {
        this.uploads.delete(uploadId)
        throw error
      }
      return { status: 'ok', uploadId }
    }
    return { status: 'ok', media: this.store.commit(scope, uploadId) }
  }

  content(
    input: Record<string, unknown>,
    caller: ChannelOutboundRpcCaller,
    targets: readonly ChannelThreadRef[],
    prior?: (index: number) => boolean,
  ) {
    if (
      input.payload !== undefined && input.content !== undefined || input.text !== undefined
        && (input.payload !== undefined || input.content !== undefined)
    ) throw new Error('INVALID_REQUEST')
    if (input.payload === undefined && input.content === undefined) {
      if (input.fallback !== undefined) throw new Error('INVALID_REQUEST')
      return undefined
    }
    const payload = validateChannelSendPayload(input.payload ?? input.content)
    const fallback = validateOutboundFallback(input.fallback ?? { mode: 'reject' })
    let outboundVersion: 3 | undefined
    try {
      validateOutboundContent(payload)
    } catch {
      outboundVersion = 3
    }
    return targets.map((target, index) => {
      if (!prior?.(index)) {
        for (const handle of richtextRequirementsV3(payload).imageHandles) {
          if (this.store.descriptor(outboundCallerScope(caller), handle, target).type !== 'image') {
            throw new Error('INVALID_MEDIA_TYPE')
          }
        }
      }
      if (['image', 'audio', 'video', 'file'].includes(payload.type)) {
        const mediaPayload = payload as Extract<ChannelSendPayload, { handle: string }>
        if (!prior?.(index)) {
          const media = this.store.descriptor(outboundCallerScope(caller), mediaPayload.handle, target)
          if (media.type !== payload.type) throw new Error('INVALID_MEDIA_TYPE')
        }
        return { content: mediaPayload, fallback }
      }
      return { content: payload, fallback, ...(outboundVersion === 3 ? { outboundVersion: 3 as const } : {}) }
    })
  }

  dispose(): void {
    this.uploads.clear()
    this.store.dispose()
  }

  validateMediaLimits(
    content: ChannelSendPayload,
    caller: ChannelOutboundRpcCaller,
    target: ChannelThreadRef,
    maximumBytes: number,
  ): void {
    const handles = 'handle' in content ? [content.handle] : richtextRequirementsV3(content).imageHandles
    let total = 0
    for (const handle of handles) {
      const media = this.store.descriptor(outboundCallerScope(caller), handle, target)
      total += media.size
      if (
        !Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || total > maximumBytes
        || content.type === 'richtext' && media.type !== 'image'
      ) throw new Error('MEDIA_SIZE_DENIED')
    }
  }

  validateTransport(
    content: ChannelSendPayload,
    fallback: import('@cordisx/channel-runtime').ChannelOutboundFallback,
    target: ChannelThreadRef,
    idempotencyKey: string,
    version: 2 | 3,
  ): void {
    const request = {
      contract: `cordisx.channel-message-send/v${version}`,
      schemaVersion: version,
      target,
      kind: 'reply',
      idempotencyKey,
      content,
      fallback,
    }
    if (Buffer.byteLength(JSON.stringify(request), 'utf8') > 196608) throw new Error('INVALID_CHANNEL_PAYLOAD')
  }

  async validateMentions(
    content: ChannelSendPayload,
    version: 2 | 3,
    verify: (content: import('@cordisx/channel-runtime').ChannelOutboundContent) => Promise<void>,
  ): Promise<void> {
    const mentions = version === 3 ? v3MentionContent(content) : validateOutboundContent(content)
    if (mentions) await verify(mentions)
  }

  private ready(accounts: readonly { ref: ChannelTenantRef; state: string }[], ref: ChannelTenantRef): void {
    if (
      !accounts.some(item =>
        item.state === 'ready' && item.ref.adapterId === ref.adapterId
        && item.ref.accountId === ref.accountId && item.ref.tenantId === ref.tenantId
      )
    ) throw new Error('CONNECTION_NOT_READY')
  }
}
