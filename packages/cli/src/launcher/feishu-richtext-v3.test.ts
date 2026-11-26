import { expect, it, vi } from 'vitest'
import { prepareFeishuRichtextV3, renderFeishuRichtextV3 } from './feishu-richtext-v3.js'
import { createHash } from 'node:crypto'
import type { ChannelOutboundMedia, ChannelThreadRef } from '@cordisx/channel-runtime'

it('renders native links/images and isolated generated code without interpreting prose', () => {
  const content = {
    type: 'richtext',
    blocks: [
      {
        type: 'paragraph',
        nodes: [{ type: 'link', text: '**literal**', url: 'https://example.org' }, {
          type: 'image',
          handle: 'media:scoped',
        }, { type: 'mention', userId: 'ou_verified' }],
      },
      { type: 'inline-code', text: '`<at user_id="all">`' },
      { type: 'code', text: 'return 42', language: 'GO' },
    ],
  }
  expect(renderFeishuRichtextV3(content, new Map([['media:scoped', 'img_verified']]))).toEqual({
    en_us: {
      title: '',
      content: [
        [{ tag: 'a', text: '**literal**', href: 'https://example.org' }, { tag: 'img', image_key: 'img_verified' }, {
          tag: 'at',
          user_id: 'ou_verified',
        }],
        [{ tag: 'md', text: '`` `<at user_id="all">` ``' }],
        [{ tag: 'code_block', text: 'return 42', language: 'GO' }],
      ],
    },
  })
})

it('rejects unresolved or malformed image keys instead of dropping nodes', () => {
  const content = {
    type: 'richtext',
    blocks: [{ type: 'paragraph', nodes: [{ type: 'image', handle: 'media:scoped' }] }],
  }
  expect(() => renderFeishuRichtextV3(content, new Map())).toThrow('PREPARED_IMAGE_UNRESOLVED')
  expect(() => renderFeishuRichtextV3(content, new Map([['media:scoped', '<bad>']]))).toThrow(
    'PREPARED_IMAGE_UNRESOLVED',
  )
})

it('rejects raw Markdown and mixed inline code', () => {
  expect(() =>
    renderFeishuRichtextV3({
      type: 'richtext',
      blocks: [{ type: 'paragraph', nodes: [{ type: 'md', text: '<at user_id="all">' }] }],
    }, new Map())
  ).toThrow()
  expect(() =>
    renderFeishuRichtextV3({
      type: 'richtext',
      blocks: [{ type: 'paragraph', nodes: [{ type: 'inline-code', text: 'x' }] }],
    }, new Map())
  ).toThrow()
})

const target: ChannelThreadRef = {
  adapterId: 'feishu',
  accountId: 'app',
  tenantId: 'tenant',
  conversationId: 'oc_chat',
  kind: 'group',
  threadId: 'oc_chat',
  semantics: 'conversation',
}
const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex')
const image = (handle: string): ChannelOutboundMedia => ({
  type: 'image',
  handle,
  format: 'png',
  size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
})
const content = {
  type: 'richtext',
  blocks: [{
    type: 'paragraph',
    nodes: [{ type: 'image', handle: 'media:first' }, { type: 'image', handle: 'media:second' }],
  }],
}

it('resolves and verifies all images and mentions before first upload', async () => {
  const upload = vi.fn(async () => ({ code: 0, data: { image_key: 'img_key' } }))
  const resolve = vi.fn(async (handle: string) => {
    if (handle === 'media:second') throw new Error('expired')
    return bytes
  })
  await expect(
    prepareFeishuRichtextV3(content, [image('media:first'), image('media:second')], target, { resolve }, {
      image: upload,
    }, async () => {}),
  ).rejects.toThrow('expired')
  expect(upload).not.toHaveBeenCalled()
  await expect(
    prepareFeishuRichtextV3(
      content,
      [image('media:first'), image('media:second')],
      target,
      { resolve: async () => bytes },
      { image: upload },
      async () => {
        throw new Error('mention denied')
      },
    ),
  ).rejects.toThrow('mention denied')
  expect(upload).not.toHaveBeenCalled()
})

it('rejects oversized content before resolving or uploading images', async () => {
  const resolve = vi.fn(async () => bytes)
  const upload = vi.fn(async () => ({ code: 0, data: { image_key: 'img_key' } }))
  const oversized = { type: 'richtext', blocks: Array(128).fill({ text: '字'.repeat(4096), style: 'plain' }) }
  await expect(prepareFeishuRichtextV3(oversized, [], target, { resolve }, { image: upload }, async () => {})).rejects
    .toThrow()
  expect(resolve).not.toHaveBeenCalled()
  expect(upload).not.toHaveBeenCalled()
})

it('reports upload uncertainty without replaying another effect', async () => {
  const upload = vi.fn(async () => {
    throw new Error('network lost')
  })
  await expect(
    prepareFeishuRichtextV3(
      content,
      [image('media:first'), image('media:second')],
      target,
      { resolve: async () => bytes },
      { image: upload },
      async () => {},
    ),
  ).rejects.toThrow('PREPARED_IMAGE_UPLOAD_UNCERTAIN')
  expect(upload).toHaveBeenCalledTimes(1)
})

it('stops before the second upload when authority is revoked while the first upload awaits', async () => {
  let revoked = false
  let release = () => {}
  let started = () => {}
  const pendingUpload = new Promise<void>(resolve => {
    release = resolve
  })
  const firstStarted = new Promise<void>(resolve => {
    started = resolve
  })
  const upload = vi.fn(async () => {
    started()
    await pendingUpload
    return { code: 0, data: { image_key: 'img_first' } }
  })
  const verify = async () => {
    if (revoked) throw new Error('generation revoked')
  }
  const preparation = prepareFeishuRichtextV3(
    content,
    [image('media:first'), image('media:second')],
    target,
    { resolve: async () => bytes },
    { image: upload },
    verify,
  )
  await firstStarted
  revoked = true
  release()
  await expect(preparation).rejects.toThrow('PREPARED_IMAGE_UPLOAD_UNCERTAIN')
  expect(upload).toHaveBeenCalledTimes(1)
})
