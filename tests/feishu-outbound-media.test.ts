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
  it.each([
    {
      type: 'file' as const,
      format: 'pdf' as const,
      filename: '报告.pdf',
      bytes: Buffer.from('%PDF-1.7\n'),
      fileType: 'pdf',
      messageType: 'file',
    },
    {
      type: 'file' as const,
      format: 'binary' as const,
      filename: 'archive.bin',
      bytes: Buffer.from([0, 1, 2]),
      fileType: 'stream',
      messageType: 'file',
    },
    {
      type: 'video' as const,
      format: 'mp4' as const,
      filename: 'clip.mp4',
      bytes: Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex'),
      fileType: 'mp4',
      messageType: 'media',
    },
  ])('uploads authorized $format bytes with filename', async fixture => {
    const { authority, uploader } = dependencies(fixture.bytes)
    const descriptor = {
      ...media(fixture.bytes),
      type: fixture.type,
      format: fixture.format,
      filename: fixture.filename,
    }
    expect(await prepareFeishuOutboundMedia(descriptor, target, authority, uploader)).toEqual({
      msg_type: fixture.messageType,
      content: '{"file_key":"synthetic-audio"}',
    })
    expect(uploader.file).toHaveBeenCalledWith({
      file_type: fixture.fileType,
      file_name: fixture.filename,
      file: fixture.bytes,
    })
    expect(authority.resolve).toHaveBeenCalledWith(descriptor.handle, target, descriptor.size)
    expect(uploader.image).not.toHaveBeenCalled()
    uploader.file.mockResolvedValue({ code: 0, data: { file_key: '' } })
    await expect(prepareFeishuOutboundMedia(descriptor, target, authority, uploader)).rejects.toThrow(
      'UPLOAD_UNAVAILABLE',
    )
  })
  it.each(['../x.pdf', 'dir/x.pdf', 'dir\\x.pdf', 'x\u0000.pdf', '', ' x.pdf', 'x.pdf.', 'x'.repeat(256)])(
    'rejects unsafe filenames %j',
    filename => {
      expect(() => validateOutboundMedia({ ...media(), type: 'file', format: 'pdf', filename })).toThrow()
    },
  )
  it.each([
    { type: 'file', format: 'pdf', filename: 'x.bin' },
    { type: 'file', format: 'binary' },
    { type: 'file', format: 'binary', filename: 'x.bin', durationMs: 1 },
    { type: 'video', format: 'mp4', filename: 'x.mp4', size: 30_000_001 },
    { type: 'video', format: 'pdf', filename: 'x.pdf' },
  ])('rejects unsupported file/video metadata %j', override => {
    expect(() => validateOutboundMedia({ ...media(), ...override })).toThrow()
  })
  it.each(['pdf', 'mp4'] as const)('rejects false %s signatures before file upload', async format => {
    const bytes = Buffer.alloc(24)
    if (format === 'mp4') {
      bytes.writeUInt32BE(32, 0)
      bytes.write('ftypisom', 4)
    }
    const { authority, uploader } = dependencies(bytes)
    await expect(prepareFeishuOutboundMedia(
      {
        ...media(bytes),
        type: format === 'pdf' ? 'file' : 'video',
        format,
        filename: `x.${format}`,
      },
      target,
      authority,
      uploader,
    )).rejects.toThrow('MEDIA_INVALID')
    expect(uploader.file).not.toHaveBeenCalled()
  })
})
