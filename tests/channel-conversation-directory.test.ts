import { describe, expect, it, vi } from 'vitest'
import { ChannelConversationDirectory } from '../packages/cli/src/launcher/channel-conversation-directory.js'
import type { FeishuSdkChannel } from '../packages/cli/src/launcher/feishu-adapter.js'

const ref = {
  adapterId: 'feishu',
  accountId: 'cli_own',
  tenantId: 'tenant',
  conversationId: 'group',
  kind: 'group' as const,
}
describe('conversation identity decoration', () => {
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
