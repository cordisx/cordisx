import {
  inlineCodeMarkdown,
  richtextRequirementsV3,
  UncertainChannelSendError,
  validateOutboundContentV3,
  validateOutboundMedia,
  validPreparedMediaSignature,
} from '@cordisx/channel-runtime'
import type { ChannelOutboundMedia, ChannelThreadRef } from '@cordisx/channel-runtime'
import { createHash } from 'node:crypto'
import type { FeishuMediaAuthority, FeishuMediaUploader } from './feishu-outbound-media.js'

export function renderFeishuRichtextV3(value: unknown, imageKeys: ReadonlyMap<string, string>): unknown {
  const content = validateOutboundContentV3(value)
  if (content.type !== 'richtext') throw new Error('INVALID_RICHTEXT_V3')
  const paragraphs = content.blocks.map(block => {
    if ('type' in block) {
      if (block.type === 'inline-code') return [{ tag: 'md', text: inlineCodeMarkdown(block.text) }]
      if (block.type === 'code') {
        return [{
          tag: 'code_block',
          text: block.text,
          ...(block.language === undefined ? {} : { language: block.language }),
        }]
      }
      return block.nodes.map(node => {
        if (node.type === 'mention') return { tag: 'at', user_id: node.userId }
        if (node.type === 'link') return { tag: 'a', text: node.text, href: node.url }
        if (node.type === 'image') {
          const imageKey = imageKeys.get(node.handle)
          if (!imageKey || !/^[A-Za-z0-9_-]{1,512}$/u.test(imageKey)) throw new Error('PREPARED_IMAGE_UNRESOLVED')
          return { tag: 'img', image_key: imageKey }
        }
        return {
          tag: 'text',
          text: node.text,
          ...(node.style === 'plain' ? {} : { style: [node.style === 'strong' ? 'bold' : 'italic'] }),
        }
      })
    }
    return [
      block.style === 'code'
        ? { tag: 'code_block', text: block.text }
        : {
          tag: 'text',
          text: block.text,
          ...(block.style === 'plain' ? {} : { style: [block.style === 'strong' ? 'bold' : 'italic'] }),
        },
    ]
  })
  const rendered = { en_us: { title: '', content: paragraphs } }
  if (Buffer.byteLength(JSON.stringify(rendered), 'utf8') > 196608) throw new Error('RICHTEXT_RENDERED_SIZE_DENIED')
  return rendered
}

export async function prepareFeishuRichtextV3(
  value: unknown,
  images: readonly ChannelOutboundMedia[],
  target: ChannelThreadRef,
  authority: FeishuMediaAuthority,
  uploader: Pick<FeishuMediaUploader, 'image'>,
  verify: () => Promise<void>,
): Promise<unknown> {
  const safe = validateOutboundContentV3(value)
  const handles = richtextRequirementsV3(safe).imageHandles
  if (images.length !== handles.length || new Set(images.map(image => image.handle)).size !== images.length) {
    throw new Error('PREPARED_IMAGE_SCOPE_DENIED')
  }
  const resolved: { handle: string; bytes: Buffer }[] = []
  const preflightKeys = new Map<string, string>()
  for (const handle of handles) {
    const image = validateOutboundMedia(images.find(image => image.handle === handle))
    if (image.type !== 'image') throw new Error('PREPARED_IMAGE_TYPE_DENIED')
    const bytes = Buffer.from(await authority.resolve(handle, target, image.size))
    if (
      bytes.length !== image.size || createHash('sha256').update(bytes).digest('hex') !== image.sha256
      || !validPreparedMediaSignature(image.format, bytes)
    ) throw new Error('PREPARED_IMAGE_INTEGRITY_DENIED')
    resolved.push({ handle, bytes })
    preflightKeys.set(handle, 'x'.repeat(512))
  }
  renderFeishuRichtextV3(safe, preflightKeys)
  await verify()
  const keys = new Map<string, string>()
  let effectStarted = false
  for (const image of resolved) {
    try {
      await verify()
      effectStarted = true
      const response = await uploader.image({ image_type: 'message', image: image.bytes })
      if (response.code !== 0 || !response.data?.image_key) throw new Error('PREPARED_IMAGE_UPLOAD_UNAVAILABLE')
      keys.set(image.handle, response.data.image_key)
    } catch (error) {
      if (effectStarted) throw new UncertainChannelSendError('PREPARED_IMAGE_UPLOAD_UNCERTAIN')
      throw error
    }
  }
  try {
    await verify()
    return renderFeishuRichtextV3(safe, keys)
  } catch {
    if (resolved.length) throw new UncertainChannelSendError('PREPARED_IMAGE_POSTUPLOAD_UNCERTAIN')
    throw new Error('RICHTEXT_AUTHORITY_REVOKED')
  }
}
