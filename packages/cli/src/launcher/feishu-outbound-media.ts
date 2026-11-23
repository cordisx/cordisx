import { createHash } from 'node:crypto'
import { validPreparedMediaSignature } from '@cordisx/channel-runtime'
import { validateOutboundMedia } from '@cordisx/channel-runtime'
import type { ChannelOutboundMedia, ChannelThreadRef } from '@cordisx/channel-runtime'
import type { ChannelOutboundContent } from '@cordisx/channel-runtime'
import { validateOutboundContent } from '@cordisx/channel-runtime'

export interface FeishuMediaAuthority {
  resolve(handle: string, target: ChannelThreadRef, maximumBytes: number): Promise<Uint8Array> | Uint8Array
}

export function renderFeishuTypedContent(
  value: ChannelOutboundContent,
): { msg_type: 'text' | 'post' | 'interactive'; content: unknown } {
  const content = validateOutboundContent(value)
  if (content.type === 'text') return { msg_type: 'text', content: { text: content.text } }
  if (content.type === 'richtext') {
    return {
      msg_type: 'post',
      content: {
        en_us: {
          title: '',
          content: content.blocks.map(block => [
            block.style === 'code'
              ? { tag: 'code_block', text: block.text }
              : {
                tag: 'text',
                text: block.text,
                ...(block.style === 'plain' ? {} : { style: [block.style === 'strong' ? 'bold' : 'italic'] }),
              },
          ]),
        },
      },
    }
  }
  if (content.type === 'card') {
    return {
      msg_type: 'interactive',
      content: {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: content.title } },
        elements: [{ tag: 'div', text: { tag: 'plain_text', content: content.body } }],
      },
    }
  }
  throw new Error('FEISHU_TYPED_CONTENT_REQUIRES_MEDIA_UPLOAD')
}

export interface FeishuMediaUploader {
  image(
    data: { image_type: 'message'; image: Buffer },
  ): Promise<{ code?: number; data?: { image_key?: string | undefined } }>
  file(
    data: { file_type: 'opus' | 'pdf' | 'stream' | 'mp4'; file_name: string; file: Buffer; duration?: number },
  ): Promise<{
    code?: number
    data?: { file_key?: string | undefined }
  }>
}

export async function prepareFeishuOutboundMedia(
  value: ChannelOutboundMedia,
  target: ChannelThreadRef,
  authority: FeishuMediaAuthority,
  uploader: FeishuMediaUploader,
): Promise<{ msg_type: 'image' | 'audio' | 'file' | 'media'; content: string }> {
  const media = validateOutboundMedia(value)
  const resolved = await authority.resolve(media.handle, target, media.size)
  if (!(resolved instanceof Uint8Array) || resolved.byteLength !== media.size) throw new Error('OUTBOUND_MEDIA_INVALID')
  const bytes = Buffer.from(resolved)
  if (createHash('sha256').update(bytes).digest('hex') !== media.sha256) throw new Error('OUTBOUND_MEDIA_INVALID')
  if (!validPreparedMediaSignature(media.format, bytes)) throw new Error('OUTBOUND_MEDIA_INVALID')
  if (media.type === 'image') {
    const response = await uploader.image({ image_type: 'message', image: bytes })
    if (response.code !== 0 || !response.data?.image_key) throw new Error('OUTBOUND_MEDIA_UPLOAD_UNAVAILABLE')
    return { msg_type: 'image', content: JSON.stringify({ image_key: response.data.image_key }) }
  }
  const response = await uploader.file({
    file_type: media.format === 'binary'
      ? 'stream'
      : media.format === 'pdf'
      ? 'pdf'
      : media.format === 'mp4'
      ? 'mp4'
      : 'opus',
    file_name: media.filename ?? 'audio.opus',
    file: bytes,
    ...(media.durationMs === undefined ? {} : { duration: media.durationMs }),
  })
  if (response.code !== 0 || !response.data?.file_key) throw new Error('OUTBOUND_MEDIA_UPLOAD_UNAVAILABLE')
  return {
    msg_type: media.type === 'video' ? 'media' : media.type === 'file' ? 'file' : 'audio',
    content: JSON.stringify({ file_key: response.data.file_key }),
  }
}
