import { describe, expect, it, vi } from 'vitest'

vi.mock(
  './channel-message-search-rpc.js',
  () => ({ channelMessageSearchRpc: vi.fn(async () => ({ status: 'search' })) }),
)
vi.mock(
  './channel-thread-history-rpc.js',
  () => ({ channelThreadHistoryRpc: vi.fn(async () => ({ status: 'thread' })) }),
)
vi.mock(
  './channel-historical-resources-rpc.js',
  () => ({ channelHistoricalResourcesRpc: vi.fn(async () => ({ status: 'resource' })) }),
)

import { channelReadRpc } from './channel-read-rpc.js'
import { channelHistoricalResourcesRpc } from './channel-historical-resources-rpc.js'

describe('production Channel read RPC dispatch', () => {
  it('routes resource operations without altering search or thread-read entrypoints', async () => {
    const account = { adapterId: 'feishu', accountId: 'app', tenantId: 'tenant' }
    const context = { caller: 'session', current: {}, active: () => true } as Parameters<typeof channelReadRpc>[3]
    expect(await channelReadRpc('message-search', {}, account, context)).toEqual({ status: 'search' })
    expect(await channelReadRpc('thread-history', {}, account, context)).toEqual({ status: 'thread' })
    for (const operation of ['resource-refetch', 'resource-status', 'resource-read']) {
      expect(await channelReadRpc(operation, {}, account, context)).toEqual({ status: 'resource' })
      expect(channelHistoricalResourcesRpc).toHaveBeenLastCalledWith({}, account, context, operation)
    }
    expect(() => channelReadRpc('other', {}, account, context)).toThrow('INVALID_REQUEST')
  })
})
