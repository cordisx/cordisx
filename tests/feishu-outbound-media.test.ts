import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { validateOutboundMedia } from '../packages/channel-runtime/src/outbound-media.js'
import { parseChannelCliMedia } from '../packages/cli/src/cli/channel-cli-media.js'
import { prepareFeishuOutboundMedia } from '../packages/cli/src/launcher/feishu-outbound-media.js'

const target = {
  adapterId: 'lark',
  accountId: 'synthetic',
  tenantId: 'synthetic',
  conversationId: 'chat',
  kind: 'group' as const,
  threadId: 'thread',
  semantics: 'topic' as const,
}
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
function media(bytes = png) {
  return {
    type: 'image' as const,
    handle: 'media:synthetic',
    format: 'png' as const,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}
function dependencies(bytes = png) {
  return {
    authority: { resolve: vi.fn(async () => bytes) },
    uploader: {
      image: vi.fn(async () => ({ code: 0, data: { image_key: 'synthetic-image' } })),
      file: vi.fn(async () => ({ code: 0, data: { file_key: 'synthetic-audio' } })),
    },
  }
}

describe('bounded outbound media', () => {
  it('uploads only resolved, hash-checked bytes with the original source target', async () => {
    const { authority, uploader } = dependencies()
    expect(await prepareFeishuOutboundMedia(media(), target, authority, uploader)).toEqual({
      msg_type: 'image',
      content: JSON.stringify({ image_key: 'synthetic-image' }),
    })
    expect(authority.resolve).toHaveBeenCalledWith('media:synthetic', target, png.length)
    expect(uploader.image).toHaveBeenCalledWith({ image_type: 'message', image: png })
  })
  it('passes existing Ogg Opus audio and duration without synthesizing or converting', async () => {
    const bytes = Buffer.alloc(47)
    bytes.write('OggS')
    bytes[5] = 2
    bytes[26] = 1
    bytes[27] = 19
    bytes.write('OpusHead', 28)
    const { authority, uploader } = dependencies(bytes)
    expect(
      await prepareFeishuOutboundMedia(
        {
          ...media(bytes),
          type: 'audio',
          format: 'opus',
          durationMs: 3000,
        },
        target,
        authority,
        uploader,
      ),
    ).toEqual({ msg_type: 'audio', content: '{"file_key":"synthetic-audio"}' })
    expect(uploader.file).toHaveBeenCalledWith({
      file_type: 'opus',
      file_name: 'audio.opus',
      file: bytes,
      duration: 3000,
    })
  })
  it.each([
    { handle: 'https://example.invalid/image.png' },
    { handle: '/tmp/image.png' },
    { path: '/tmp/image.png' },
    { size: 0 },
    { size: 10_000_001 },
    { format: 'svg' },
    { durationMs: 1 },
    { sha256: 'bad' },
    { type: 'audio', format: 'mp3' },
    { type: 'audio', format: 'opus', size: 30_000_001 },
  ])('rejects unsafe or unsupported metadata %j', override => {
    expect(() => validateOutboundMedia({ ...media(), ...override })).toThrow()
  })
  it('rejects changed bytes, wrong signatures, and failed scoped resolution before upload', async () => {
    for (const bytes of [Buffer.alloc(8), Buffer.alloc(1)]) {
      const { authority, uploader } = dependencies(bytes)
      await expect(prepareFeishuOutboundMedia(media(), target, authority, uploader)).rejects.toThrow()
      await expect(prepareFeishuOutboundMedia(media(bytes), target, authority, uploader)).rejects.toThrow()
      expect(uploader.image).not.toHaveBeenCalled()
    }
    const { authority, uploader } = dependencies()
    authority.resolve.mockRejectedValue(new Error('SOURCE_DENIED'))
    await expect(prepareFeishuOutboundMedia(media(), target, authority, uploader)).rejects.toThrow('SOURCE_DENIED')
    expect(uploader.image).not.toHaveBeenCalled()
  })
  it('requires successful upload keys and parses CLI metadata without file access', async () => {
    expect(parseChannelCliMedia(JSON.stringify(media()))).toEqual(media())
    const { authority, uploader } = dependencies()
    uploader.image.mockResolvedValue({ code: 1, data: { image_key: 'ignored' } })
    await expect(prepareFeishuOutboundMedia(media(), target, authority, uploader)).rejects.toThrow('UPLOAD_UNAVAILABLE')
  })
})
