import { validateOutboundContentV3 } from '@cordisx/channel-runtime'
import { validateLegacyRichtextPayload } from './channel-send-richtext-payload.js'
export type ChannelSendPayload = import('@cordisx/channel-runtime').ChannelOutboundContentV3

export interface ChannelMediaPrepareInput {
  readonly account: { readonly adapterId: string; readonly accountId: string; readonly tenantId: string }
  readonly target: {
    readonly id: string
    readonly kind: 'direct' | 'group'
    readonly replyMode?: 'conversation' | 'reply' | 'thread'
    readonly replyTo?: string
  }
  readonly operationId: string
  readonly type: 'image' | 'audio' | 'video' | 'file'
  readonly format?: 'png' | 'jpeg' | 'opus' | 'pdf' | 'binary' | 'mp4'
  readonly mediaType?: string
  readonly filename?: string
  readonly name?: string
  readonly durationMs?: number
  readonly bytesBase64: string
}

export function validateChannelMediaPrepareInput(value: unknown): ChannelMediaPrepareInput {
  const input = record(value)
  keys(input, [
    'account',
    'target',
    'operationId',
    'type',
    'format',
    'mediaType',
    'filename',
    'name',
    'durationMs',
    'bytesBase64',
  ])
  const account = record(input.account), target = record(input.target)
  keys(account, ['adapterId', 'accountId', 'tenantId'])
  keys(target, ['id', 'kind', 'replyMode', 'replyTo'])
  for (const identifier of [account.adapterId, account.accountId, account.tenantId, target.id, input.operationId]) {
    if (typeof identifier !== 'string' || !identifier.trim() || identifier.length > 128) {
      throw new Error('INVALID_CHANNEL_PAYLOAD')
    }
  }
  if (
    !['direct', 'group'].includes(String(target.kind))
    || target.replyMode !== undefined && !['conversation', 'reply', 'thread'].includes(String(target.replyMode))
    || target.replyTo !== undefined
      && (typeof target.replyTo !== 'string' || !target.replyTo.trim() || target.replyTo.length > 128)
    || !['image', 'audio', 'video', 'file'].includes(String(input.type))
  ) throw new Error('INVALID_CHANNEL_PAYLOAD')
  const mimeFormats: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'audio/ogg': 'opus',
    'audio/opus': 'opus',
    'application/pdf': 'pdf',
    'application/octet-stream': 'binary',
    'video/mp4': 'mp4',
  }
  const format = input.format ?? (typeof input.mediaType === 'string' ? mimeFormats[input.mediaType] : undefined)
  const formats: Record<string, readonly string[]> = {
    image: ['png', 'jpeg'],
    audio: ['opus'],
    file: ['pdf', 'binary'],
    video: ['mp4'],
  }
  if (
    typeof format !== 'string' || !formats[String(input.type)]?.includes(format)
    || input.mediaType !== undefined && (typeof input.mediaType !== 'string' || mimeFormats[input.mediaType] !== format)
  ) {
    throw new Error('INVALID_CHANNEL_PAYLOAD')
  }
  if (input.name !== undefined && input.filename !== undefined && input.name !== input.filename) {
    throw new Error('INVALID_CHANNEL_PAYLOAD')
  }
  const filename = input.filename ?? input.name
  if (
    filename !== undefined && (typeof filename !== 'string' || !filename.length || filename.length > 255
      || filename.trim() !== filename || /[\/\\\x00-\x1f\x7f]/u.test(filename) || filename === '.' || filename === '..'
      || filename.endsWith('.'))
  ) {
    throw new Error('INVALID_CHANNEL_PAYLOAD')
  }
  if (
    (input.type === 'file' || input.type === 'video') && filename === undefined
    || format === 'pdf' && !(filename as string | undefined)?.toLowerCase().endsWith('.pdf')
    || format === 'mp4' && !(filename as string | undefined)?.toLowerCase().endsWith('.mp4')
    || input.durationMs !== undefined && (!['audio', 'video'].includes(String(input.type))
        || !Number.isSafeInteger(input.durationMs) || Number(input.durationMs) < 0
        || Number(input.durationMs) > 2_147_483_647)
  ) {
    throw new Error('INVALID_CHANNEL_PAYLOAD')
  }
  const bytes = input.bytesBase64
  if (
    typeof bytes !== 'string' || !bytes.length || bytes.length > 87_384 || bytes.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(bytes)
  ) throw new Error('INVALID_CHANNEL_PAYLOAD')
  const decoded = Buffer.from(bytes, 'base64')
  if (!decoded.length || decoded.length > 65_536 || decoded.toString('base64') !== bytes) {
    throw new Error('INVALID_CHANNEL_PAYLOAD')
  }
  return input as unknown as ChannelMediaPrepareInput
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_CHANNEL_PAYLOAD')
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('INVALID_CHANNEL_PAYLOAD')
}

function boundedText(value: unknown, maximum = 8192): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new Error('INVALID_CHANNEL_PAYLOAD')
  }
  return value
}

export function validateChannelSendPayload(value: unknown): ChannelSendPayload {
  const payload = record(value)
  if (payload.type === 'text') {
    keys(payload, ['type', 'text'])
    return { type: 'text', text: boundedText(payload.text) }
  }
  if (payload.type === 'richtext') {
    const successor = Array.isArray(payload.blocks) && payload.blocks.some(value => {
      const block = record(value)
      return block.type === 'inline-code' || block.type === 'code'
        || Array.isArray(block.nodes) && block.nodes.some(value => {
            const node = record(value)
            return node.type === 'link' || node.type === 'image'
          })
    })
    if (!successor) return validateLegacyRichtextPayload(payload)
    try {
      return validateOutboundContentV3(payload)
    } catch {
      throw new Error('INVALID_CHANNEL_PAYLOAD')
    }
  }
  if (payload.type === 'card') {
    keys(payload, ['type', 'title', 'body'])
    return { type: 'card', title: boundedText(payload.title, 256), body: boundedText(payload.body, 16384) }
  }
  if (
    payload.type === 'image' || payload.type === 'audio' || payload.type === 'video'
    || payload.type === 'file'
  ) {
    keys(payload, ['type', 'handle'])
    if (
      typeof payload.handle !== 'string' || !/^media:[A-Za-z0-9_-]{1,128}$/u.test(payload.handle)
    ) {
      throw new Error('INVALID_CHANNEL_PAYLOAD')
    }
    return { type: payload.type, handle: payload.handle }
  }
  throw new Error('INVALID_CHANNEL_PAYLOAD')
}

export type ChannelSendFallback = { readonly mode: 'reject' } | { readonly mode: 'text'; readonly text: string }

export function validateChannelSendFallback(value: unknown): ChannelSendFallback {
  const fallback = record(value)
  if (fallback.mode === 'reject') {
    keys(fallback, ['mode'])
    return { mode: 'reject' }
  }
  keys(fallback, ['mode', 'text'])
  if (fallback.mode !== 'text') throw new Error('INVALID_CHANNEL_PAYLOAD')
  return { mode: 'text', text: boundedText(fallback.text) }
}

export function validateChannelTerminalIntent(value: unknown): void {
  const intent = record(value)
  keys(intent, ['contract', 'schemaVersion', 'inputOperationId'])
  if (
    intent.contract !== 'cordisx.channel-terminal-intent/v1' || intent.schemaVersion !== 1
    || typeof intent.inputOperationId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(intent.inputOperationId)
  ) throw new Error('INVALID_CHANNEL_PAYLOAD')
}

export function prepareChannelSendInput(value: unknown): unknown {
  const input = record(value)
  if (Object.hasOwn(input, 'fallback')) validateChannelSendFallback(input.fallback)
  if (Object.hasOwn(input, 'terminal')) {
    validateChannelTerminalIntent(input.terminal)
    if (!input.target || Object.hasOwn(input, 'targets')) throw new Error('INVALID_CHANNEL_PAYLOAD')
  }
  if (!Object.hasOwn(input, 'payload') && !Object.hasOwn(input, 'content')) return value
  keys(input, ['account', 'target', 'targets', 'operationId', 'payload', 'content', 'fallback', 'terminal'])
  if (Object.hasOwn(input, 'payload') && Object.hasOwn(input, 'content')) throw new Error('INVALID_CHANNEL_PAYLOAD')
  const field = Object.hasOwn(input, 'payload') ? 'payload' : 'content'
  const payload = validateChannelSendPayload(input[field])
  if (payload.type !== 'text' || input.fallback !== undefined || field === 'content') {
    return { ...input, [field]: payload }
  }
  const { payload: _payload, ...remaining } = input
  return { ...remaining, text: payload.text }
}
