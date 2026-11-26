import { describe, expect, it } from 'vitest'
import { feishuHistoricalResourceDescriptors } from './feishu-historical-resource-descriptors.js'

const message = (type: string, content: unknown) => ({
  message_id: 'om_source',
  chat_id: 'oc_source',
  msg_type: type,
  body: { content: JSON.stringify(content) },
})
const read = (value: unknown) => feishuHistoricalResourceDescriptors(value, 'oc_source', 'om_source')

describe('historical resource association validation', () => {
  it('extracts only associated resources from supported message structures', () => {
    expect(read(message('image', { image_key: 'img_associated' }))).toEqual([{
      type: 'image',
      fileKey: 'img_associated',
    }])
    expect(read(message('media', { file_key: 'file_associated', image_key: 'img_preview', file_name: 'video.mp4' })))
      .toEqual([{ type: 'video', fileKey: 'file_associated', fileName: 'video.mp4' }, {
        type: 'image',
        fileKey: 'img_preview',
      }])
    expect(
      read(
        message('post', {
          en_us: {
            content: [[{ tag: 'img', image_key: 'img_associated' }], [{ tag: 'text', text: 'file_key=not_authority' }, {
              tag: 'img',
              image_key: 'img_associated',
            }]],
          },
        }),
      ),
    )
      .toEqual([{ type: 'image', fileKey: 'img_associated' }])
  })
  it('rejects mismatched, deleted, invalid or unsupported messages before exposing keys', () => {
    const source = message('image', { image_key: 'img_associated' })
    for (
      const invalid of [{ ...source, chat_id: 'other' }, { ...source, message_id: 'other' }, {
        ...source,
        deleted: true,
      }]
    ) {
      expect(() => read(invalid)).toThrow('HISTORICAL_RESOURCE_SOURCE_MISMATCH')
    }
    for (const type of ['text', 'sticker', 'folder', 'interactive', 'cloud_file']) {
      expect(() => read(message(type, { file_key: 'not_authority' }))).toThrow('HISTORICAL_RESOURCE_UNSUPPORTED')
    }
    for (const content of [{ image_key: 'https://untrusted.example/file' }, {}, null, ['img_untrusted']]) {
      expect(() => read(message('image', content))).toThrow('HISTORICAL_RESOURCE_INVALID_MESSAGE')
    }
  })
  it('rejects excessive descriptors, structure depth and missing assets rather than silently truncating', () => {
    expect(() =>
      read(
        message('post', {
          content: Array.from({ length: 17 }, (_, index) => ({ tag: 'img', image_key: `img_${index}` })),
        }),
      )
    )
      .toThrow('HISTORICAL_RESOURCE_LIMIT')
    let nested: unknown = { tag: 'img', image_key: 'img_associated' }
    for (let depth = 0; depth < 14; depth++) nested = { nested }
    expect(() => read(message('post', nested))).toThrow('HISTORICAL_RESOURCE_LIMIT')
    expect(() => read(message('post', { content: [[{ tag: 'a', image_key: 'not_authority' }]] })))
      .toThrow('HISTORICAL_RESOURCE_NOT_FOUND')
  })
})
