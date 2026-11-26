import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import { ChannelInboundResources } from './channel-inbound-resources.js'

const source: ChannelEventRef = {
  adapterId: 'feishu',
  accountId: 'app',
  tenantId: 'tenant',
  conversationId: 'oc_source',
  kind: 'group',
  threadId: 'oc_source',
  semantics: 'conversation',
  eventId: 'resource-caller',
  messageId: 'om_historical',
}
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2])

describe('owned inbound resource status', () => {
  it('discloses only matching owned source metadata and never a local path', async () => {
    const resources = new ChannelInboundResources()
    try {
      expect(resources.status(source, 'associated')).toEqual({ state: 'not-prepared' })
      const attachment = await resources.ingest(source, Readable.from([png]), 'image', 'image.png', 'associated')
      expect(resources.status(source, 'associated')).toMatchObject({ state: 'ready', attachment })
      expect(resources.status({ ...source, eventId: 'other-caller' }, 'associated')).toEqual({ state: 'not-prepared' })
      expect(resources.status(source, 'other-resource')).toEqual({ state: 'not-prepared' })
      expect(JSON.stringify(resources.status(source, 'associated'))).not.toContain('/tmp/')
    } finally {
      await resources.dispose()
    }
    expect(resources.status(source, 'associated')).toEqual({ state: 'unavailable' })
  })
  it('distinguishes retained expiry from active preparation without granting another owner access', async () => {
    vi.useFakeTimers()
    const resources = new ChannelInboundResources()
    try {
      await resources.ingest(source, Readable.from([png]), 'image', undefined, 'associated')
      vi.setSystemTime(Date.now() + 60 * 60 * 1000)
      expect(resources.status(source, 'associated')).toEqual({ state: 'expired' })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(resources.status(source, 'associated')).toEqual({ state: 'expired' })
      expect(resources.status({ ...source, tenantId: 'other' }, 'associated')).toEqual({ state: 'not-prepared' })
    } finally {
      await resources.dispose()
      vi.useRealTimers()
    }
  })
})
