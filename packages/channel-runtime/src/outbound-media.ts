import { ChannelIntegrityError, nonEmptyText } from './runtime-validation.js'
import type { ChannelNotification } from './types.js'

export function validateNotificationMedia(notification: ChannelNotification, hasQuestionCard: boolean) {
  const media = notification.media === undefined ? undefined : validateOutboundMedia(notification.media)
  if (media && (notification.text !== '' || hasQuestionCard)) {
    throw new ChannelIntegrityError('Media cannot be combined with text or a question card')
  }
  if (!media && !nonEmptyText(notification.text, 100_000)) {
    throw new ChannelIntegrityError('Channel notification text is invalid')
  }
  return media
}

export interface ChannelOutboundMedia {
  readonly type: 'image' | 'audio' | 'file' | 'video'
  readonly handle: string
  readonly format: 'png' | 'jpeg' | 'opus' | 'pdf' | 'binary' | 'mp4'
  readonly size: number
  readonly sha256: string
  readonly durationMs?: number
  readonly filename?: string
}

export function validOutboundFilename(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Array.from(value).length <= 255
    && value.trim() === value && !/[\\/\x00-\x1f\x7f]/u.test(value)
    && value !== '.' && value !== '..' && !value.endsWith('.')
}

export function validateOutboundMedia(value: unknown): ChannelOutboundMedia {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChannelIntegrityError('Invalid outbound media')
  }
  const media = value as ChannelOutboundMedia
  if (
    Object.keys(media).some(key =>
      !['type', 'handle', 'format', 'size', 'sha256', 'durationMs', 'filename'].includes(key)
    )
    || typeof media.handle !== 'string' || !/^media:[A-Za-z0-9_-]{1,128}$/u.test(media.handle)
    || typeof media.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(media.sha256)
    || !Number.isSafeInteger(media.size) || media.size <= 0
    || (media.type === 'image'
      ? !['png', 'jpeg'].includes(media.format) || media.size > 10_000_000 || media.durationMs !== undefined
      : media.type === 'audio'
      ? media.format !== 'opus' || media.size > 30_000_000
      : media.type === 'file'
      ? !['pdf', 'binary'].includes(media.format) || media.size > 30_000_000 || media.durationMs !== undefined
      : media.type !== 'video' || media.format !== 'mp4' || media.size > 30_000_000)
    || (media.filename !== undefined && !validOutboundFilename(media.filename))
    || ((media.type === 'file' || media.type === 'video') && media.filename === undefined)
    || (media.format === 'pdf' && !media.filename?.toLowerCase().endsWith('.pdf'))
    || (media.format === 'mp4' && !media.filename?.toLowerCase().endsWith('.mp4'))
    || (media.durationMs !== undefined
      && (!Number.isSafeInteger(media.durationMs) || media.durationMs < 0 || media.durationMs > 2_147_483_647))
  ) throw new ChannelIntegrityError('Invalid outbound media')
  return {
    type: media.type,
    handle: media.handle,
    format: media.format,
    size: media.size,
    sha256: media.sha256,
    ...(media.filename === undefined ? {} : { filename: media.filename }),
    ...(media.durationMs === undefined ? {} : { durationMs: media.durationMs }),
  }
}
