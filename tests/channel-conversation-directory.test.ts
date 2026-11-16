import { describe, expect, it, vi } from 'vitest'
import { ChannelConversationDirectory } from '../packages/cli/src/launcher/channel-conversation-directory.js'
import type { FeishuSdkChannel } from '../packages/cli/src/launcher/feishu-adapter.js'
import { ChannelConversationDisplayStore } from '../packages/cli/src/launcher/channel-conversation-display-store.js'

const ref = {
  adapterId: 'feishu',
  accountId: 'cli_own',
  tenantId: 'tenant',
  conversationId: 'group',
  kind: 'group' as const,
}
describe('conversation identity decoration', () => {
  it('returns a durable hint while a slow request refreshes a renamed group, and retains it on failure', async () => {
    vi.useFakeTimers()
    const store = new ChannelConversationDisplayStore()
    store.put(ref, { name: 'Saved group' })
    let resolve!: (value: { code: number; data: { name: string } }) => void
    const get = vi.fn(() =>
      new Promise<{ code: number; data: { name: string } }>(done => {
        resolve = done
      })
    )
    const channel = { rawClient: { im: { v1: { chat: { get } } } } } as unknown as FeishuSdkChannel
    const directory = new ChannelConversationDirectory(store)
    try {
      await expect(directory.identity(ref, channel)).resolves.toEqual({ name: 'Saved group' })
      await expect(directory.identity(ref, channel)).resolves.toEqual({ name: 'Saved group' })
      expect(get).toHaveBeenCalledTimes(1)
      resolve({ code: 0, data: { name: 'Renamed group' } })
      await vi.advanceTimersByTimeAsync(0)
      expect(store.get(ref)?.name).toBe('Renamed group')
      await vi.advanceTimersByTimeAsync(60_001)
      get.mockRejectedValueOnce(new Error('transient failure'))
      await expect(directory.identity(ref, channel)).resolves.toEqual({ name: 'Renamed group' })
      await vi.advanceTimersByTimeAsync(0)
      expect(store.get(ref)?.name).toBe('Renamed group')
    } finally {
      directory.dispose()
      vi.useRealTimers()
    }
  })

  it('does not persist a renamed result that arrives after account replacement or disposal', async () => {
    const store = new ChannelConversationDisplayStore()
    store.put(ref, { name: 'Saved group' })
    let resolve!: (value: { code: number; data: { name: string } }) => void
    const get = vi.fn(() =>
      new Promise<{ code: number; data: { name: string } }>(done => {
        resolve = done
      })
    )
    const channel = { rawClient: { im: { v1: { chat: { get } } } } } as unknown as FeishuSdkChannel
    const directory = new ChannelConversationDirectory(store)
    await directory.identity(ref, channel)
    directory.invalidate(ref)
    resolve({ code: 0, data: { name: 'Stale group' } })
    await new Promise(done => setTimeout(done, 0))
    expect(store.get(ref)?.name).toBe('Saved group')
    await directory.identity(ref, channel)
    directory.dispose()
    resolve({ code: 0, data: { name: 'Disposed group' } })
    await new Promise(done => setTimeout(done, 0))
    expect(store.get(ref)?.name).toBe('Saved group')
  })

  it('fetches a group using its connected account and preserves the name when artwork is absent', async () => {
    const get = vi.fn(async () => ({ code: 0, data: { name: 'Real group' } }))
    const directory = new ChannelConversationDirectory()
    const channel = { rawClient: { im: { v1: { chat: { get } } } } } as unknown as FeishuSdkChannel
    try {
      await expect(directory.identity(ref, channel)).resolves.toEqual({ name: 'Real group' })
      await directory.identity(ref, channel)
      expect(get).toHaveBeenCalledTimes(1)
      expect(get).toHaveBeenCalledWith({ path: { chat_id: 'group' } })
    } finally {
      directory.dispose()
    }
  })
  it('never publishes an old account result after replacement and falls back on directory failure', async () => {
    let resolve!: (value: { code: number; data: { name: string } }) => void
    const get = vi.fn(() =>
      new Promise<{ code: number; data: { name: string } }>(done => {
        resolve = done
      })
    )
    const directory = new ChannelConversationDirectory()
    const channel = { rawClient: { im: { v1: { chat: { get } } } } } as unknown as FeishuSdkChannel
    try {
      const pending = directory.identity(ref, channel, 'Known group')
      directory.invalidate(ref)
      resolve({ code: 0, data: { name: 'Stale group' } })
      await expect(pending).resolves.toEqual({ name: 'Known group' })
      get.mockRejectedValueOnce(new Error('private upstream body'))
      await expect(directory.identity(ref, channel, 'Known group')).resolves.toEqual({ name: 'Known group' })
    } finally {
      directory.dispose()
    }
  })
})
