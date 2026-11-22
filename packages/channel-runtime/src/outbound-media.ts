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
  readonly type: 'image' | 'audio'
  readonly handle: string
  readonly format: 'png' | 'jpeg' | 'opus'
  readonly size: number
  readonly sha256: string
  readonly durationMs?: number
}

export function validateOutboundMedia(value: unknown): ChannelOutboundMedia {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChannelIntegrityError('Invalid outbound media')
  }
  const media = value as ChannelOutboundMedia
  if (
    Object.keys(media).some(key => !['type', 'handle', 'format', 'size', 'sha256', 'durationMs'].includes(key))
    || typeof media.handle !== 'string' || !/^media:[A-Za-z0-9_-]{1,128}$/u.test(media.handle)
    || typeof media.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(media.sha256)
    || !Number.isInteger(media.size) || media.size <= 0
    || (media.type === 'image'
      ? !['png', 'jpeg'].includes(media.format) || media.size > 10_000_000 || media.durationMs !== undefined
      : media.type !== 'audio' || media.format !== 'opus' || media.size > 30_000_000)
    || (media.durationMs !== undefined
      && (!Number.isSafeInteger(media.durationMs) || media.durationMs < 0 || media.durationMs > 2_147_483_647))
  ) throw new ChannelIntegrityError('Invalid outbound media')
  return {
    type: media.type,
    handle: media.handle,
    format: media.format,
    size: media.size,
    sha256: media.sha256,
    ...(media.durationMs === undefined ? {} : { durationMs: media.durationMs }),
  }
}
