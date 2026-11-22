import { createHash } from 'node:crypto'
import { validateOutboundMedia } from '@cordisx/channel-runtime'
import type { ChannelOutboundMedia, ChannelThreadRef } from '@cordisx/channel-runtime'

export interface FeishuMediaAuthority {
  resolve(handle: string, target: ChannelThreadRef, maximumBytes: number): Promise<Uint8Array>
}

export interface FeishuMediaUploader {
  image(data: { image_type: 'message'; image: Buffer }): Promise<{ code?: number; data?: { image_key?: string } }>
  file(data: { file_type: 'opus'; file_name: string; file: Buffer; duration?: number }): Promise<{
    code?: number
    data?: { file_key?: string }
  }>
}

export async function prepareFeishuOutboundMedia(
  value: ChannelOutboundMedia,
  target: ChannelThreadRef,
  authority: FeishuMediaAuthority,
  uploader: FeishuMediaUploader,
): Promise<{ msg_type: 'image' | 'audio'; content: string }> {
  const media = validateOutboundMedia(value)
  const resolved = await authority.resolve(media.handle, target, media.size)
  if (!(resolved instanceof Uint8Array) || resolved.byteLength !== media.size) throw new Error('OUTBOUND_MEDIA_INVALID')
  const bytes = Buffer.from(resolved)
  if (createHash('sha256').update(bytes).digest('hex') !== media.sha256) throw new Error('OUTBOUND_MEDIA_INVALID')
  const validFormat = media.format === 'png'
    ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : media.format === 'jpeg'
    ? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
    : bytes.length >= 47 && bytes.toString('ascii', 0, 4) === 'OggS'
      && bytes[4] === 0 && (bytes[5]! & 2) !== 0 && bytes[26] === 1 && bytes[27]! >= 19
      && bytes.toString('ascii', 28, 36) === 'OpusHead'
  if (!validFormat) throw new Error('OUTBOUND_MEDIA_INVALID')
  if (media.type === 'image') {
    const response = await uploader.image({ image_type: 'message', image: bytes })
    if (response.code !== 0 || !response.data?.image_key) throw new Error('OUTBOUND_MEDIA_UPLOAD_UNAVAILABLE')
    return { msg_type: 'image', content: JSON.stringify({ image_key: response.data.image_key }) }
  }
  const response = await uploader.file({
    file_type: 'opus',
    file_name: 'audio.opus',
    file: bytes,
    ...(media.durationMs === undefined ? {} : { duration: media.durationMs }),
  })
  if (response.code !== 0 || !response.data?.file_key) throw new Error('OUTBOUND_MEDIA_UPLOAD_UNAVAILABLE')
  return { msg_type: 'audio', content: JSON.stringify({ file_key: response.data.file_key }) }
}
