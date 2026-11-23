import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { ChannelInboundResources } from '../packages/cli/src/launcher/channel-inbound-resources.js'

const source = {
  adapterId: 'lark',
  accountId: 'synthetic',
  tenantId: 'synthetic',
  conversationId: 'chat',
  kind: 'group' as const,
  threadId: 'thread',
  semantics: 'topic' as const,
  eventId: 'event',
  messageId: 'message',
  actor: { adapterId: 'lark', accountId: 'synthetic', tenantId: 'synthetic', userId: 'actor' },
}

describe('outbound resource authority', () => {
  it.each([
    { kind: 'file', bytes: Buffer.from('%PDF-1.7\n'), name: 'report.pdf', format: 'pdf', type: 'file' },
    { kind: 'file', bytes: Buffer.from([0, 1, 2]), name: 'archive.bin', format: 'binary', type: 'file' },
    {
      kind: 'media',
      bytes: Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex'),
      name: 'clip.mp4',
      format: 'mp4',
      type: 'video',
    },
  ])('grants $format only from owned source and target', async fixture => {
    const resources = new ChannelInboundResources()
    const other = new ChannelInboundResources()
    try {
      const block = await resources.ingest(
        source,
        Readable.from([fixture.bytes]),
        fixture.kind,
        fixture.name,
        fixture.format,
      )
      if (block.type !== 'attachment') throw new Error('Expected attachment')
      const media = await resources.grantOutbound(block.handle, source, source)
      expect(media).toMatchObject({
        type: fixture.type,
        format: fixture.format,
        filename: fixture.name,
        size: fixture.bytes.length,
      })
      expect(await resources.resolve(media.handle, source, media.size)).toEqual(fixture.bytes)
      await expect(other.grantOutbound(block.handle, source, source)).rejects.toThrow('SOURCE_DENIED')
      await expect(resources.grantOutbound(block.handle, { ...source, eventId: 'other' }, source)).rejects.toThrow(
        'SOURCE_DENIED',
      )
      for (
        const target of [
          { ...source, accountId: 'other' },
          { ...source, tenantId: 'other' },
          { ...source, conversationId: 'other' },
          { ...source, threadId: 'other' },
        ]
      ) {
        await expect(resources.grantOutbound(block.handle, source, target)).rejects.toThrow('SOURCE_DENIED')
        await expect(resources.resolve(media.handle, target, media.size)).rejects.toThrow('SOURCE_DENIED')
      }
      for (const limit of [NaN, Infinity, 0, media.size - 1]) {
        await expect(resources.resolve(media.handle, source, limit)).rejects.toThrow('SOURCE_DENIED')
      }
      for (const handle of ['/tmp/file.pdf', 'https://example.invalid/file.pdf']) {
        await expect(resources.resolve(handle, source, media.size)).rejects.toThrow('SOURCE_DENIED')
      }
      await resources.dispose()
      await expect(resources.resolve(media.handle, source, media.size)).rejects.toThrow('SOURCE_DENIED')
    } finally {
      await resources.dispose()
      await other.dispose()
    }
  })
})
