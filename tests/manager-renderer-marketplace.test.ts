import { expect, it, vi } from 'vitest'
import { createManagerRendererMarketplaceChannel } from '../packages/cli/src/cli/manager-renderer-marketplace.js'
import type { ManagerRendererChannelContext } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import type { PluginManagementService } from '../packages/cli/src/management/service.js'

it('serves only currently enabled owner-configured feeds and refuses replay', async () => {
  const controller = new AbortController()
  const context: ManagerRendererChannelContext = {
    rendererId: 'renderer',
    profileId: 'work',
    ownerGeneration: 'owner',
    signal: controller.signal,
    admitted: true,
  }
  let enabled = true
  const service = {
    query: async () => ({ sources: [{ url: 'https://example.test/marketplace.json', enabled }] }),
  } as unknown as Pick<PluginManagementService, 'query'>
  const fetchFeed = vi.fn(async (url: string) => ({ url, status: 200, text: '{"plugins":[]}' }))
  const channel = createManagerRendererMarketplaceChannel({
    profileId: 'work',
    generation: 'owner',
    service,
    isCurrent: () => true,
    fetchFeed,
  })
  const request = (requestId: string, url = 'https://example.test/marketplace.json') =>
    JSON.stringify({ requestId, url })
  const read = channel.prepare(request('one'), context)
  expect(read.mode).toBe('read')
  await expect(read.dispatch()).resolves.toEqual({ requestId: 'one', ok: true, status: 200, text: '{"plugins":[]}' })
  await expect(channel.prepare(request('one'), context).dispatch()).rejects.toThrow('MARKETPLACE_UNAVAILABLE')
  await expect(channel.prepare(request('other', 'https://other.test/private'), context).dispatch()).resolves.toEqual({
    requestId: 'other',
    ok: false,
    error: 'Marketplace feed is unavailable.',
  })
  enabled = false
  await expect(channel.prepare(request('disabled'), context).dispatch()).resolves.toMatchObject({ ok: false })
  expect(fetchFeed).toHaveBeenCalledOnce()
  expect(() => channel.prepare(request('invalid', 'http://user:pass@example.test/feed'), context)).toThrow()
  controller.abort()
  expect(() => channel.prepare(request('retired'), context)).toThrow('MARKETPLACE_UNAVAILABLE')
})

it('does not publish a feed after its configured source is removed during the fetch', async () => {
  const controller = new AbortController()
  const context: ManagerRendererChannelContext = {
    rendererId: 'renderer',
    profileId: 'work',
    ownerGeneration: 'owner',
    signal: controller.signal,
    admitted: true,
  }
  let enabled = true
  let started!: () => void
  let finish!: () => void
  const reached = new Promise<void>(resolve => started = resolve)
  const paused = new Promise<void>(resolve => finish = resolve)
  const service = {
    query: async () => ({ sources: [{ url: 'https://example.test/marketplace.json', enabled }] }),
  } as unknown as Pick<PluginManagementService, 'query'>
  const channel = createManagerRendererMarketplaceChannel({
    profileId: 'work',
    generation: 'owner',
    service,
    isCurrent: () => true,
    fetchFeed: async url => {
      started()
      await paused
      return { url, status: 200, text: '{"plugins":[]}' }
    },
  })
  const read = channel.prepare(
    JSON.stringify({ requestId: 'one', url: 'https://example.test/marketplace.json' }),
    context,
  )
    .dispatch()
  await reached
  enabled = false
  finish()
  await expect(read).resolves.toEqual({ requestId: 'one', ok: false, error: 'Marketplace feed is unavailable.' })
})
