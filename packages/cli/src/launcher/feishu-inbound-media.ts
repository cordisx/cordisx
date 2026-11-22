import type { NormalizedMessage } from '@larksuiteoapi/node-sdk'
import type { Readable } from 'node:stream'
import type { ChannelContentBlock, ChannelEventRef } from '@cordisx/channel-runtime'
import { ChannelInboundResources } from './channel-inbound-resources.js'

export interface FeishuMessageResourceClient {
  get(input: { path: { message_id: string; file_key: string }; params: { type: 'image' | 'file' } }): Promise<{
    getReadableStream(): Readable
  }>
}

export async function feishuInboundContent(
  message: NormalizedMessage,
  event: ChannelEventRef,
  resources: ChannelInboundResources,
  client?: FeishuMessageResourceClient,
): Promise<[ChannelContentBlock, ...ChannelContentBlock[]]> {
  let text = message.content.slice(0, 90_000)
  const contentType = message.rawContentType ?? 'text'
  const blocks: ChannelContentBlock[] = []
  const descriptors = (message.resources ?? []).slice(0, 16)
  const seen = new Set<string>()
  for (const resource of descriptors) {
    if (seen.has(resource.fileKey)) continue
    seen.add(resource.fileKey)
    text = text.split(resource.fileKey).join('[resource]')
    try {
      if (!client || resource.type === 'sticker' || !/^[A-Za-z0-9_-]{1,512}$/u.test(resource.fileKey)) {
        throw new Error('RESOURCE_UNSUPPORTED')
      }
      const response = await client.get({
        path: { message_id: message.messageId, file_key: resource.fileKey },
        params: { type: resource.type === 'image' ? 'image' : 'file' },
      })
      blocks.push(
        await resources.ingest(event, response.getReadableStream(), resource.type, resource.fileName, resource.fileKey),
      )
    } catch {
      blocks.push({
        type: 'text',
        text:
          `[${resource.type} attachment unavailable: unsupported, permission denied, invalid format, or download limit]`,
      })
    }
  }
  if ((message.resources?.length ?? 0) > 16) {
    blocks.push({ type: 'text', text: '[Additional attachments omitted: limit 16]' })
  }
  const supported = ['text', 'post', 'image', 'audio', 'file', 'media', 'video']
  if (!supported.includes(contentType)) {
    text = `[${
      contentType.replace(/[^a-zA-Z0-9_-]/gu, '').slice(0, 64) || 'unknown'
    } message: text-only fallback; embedded resources/actions are unsupported]\n${text}`
  }
  if (text.trim()) blocks.unshift({ type: 'text', text })
  if (!blocks.length) {
    blocks.push({ type: 'text', text: `[${message.rawContentType} message unavailable: no usable content]` })
  }
  return blocks as [ChannelContentBlock, ...ChannelContentBlock[]]
}
