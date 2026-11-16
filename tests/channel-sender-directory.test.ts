import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ChannelSenderDirectory } from '../packages/cli/src/launcher/channel-sender-directory.js'
import { ChannelConversationDisplayStore } from '../packages/cli/src/launcher/channel-conversation-display-store.js'
import { channelMessageContext } from '../packages/cli/src/launcher/channel-message-context.js'

const event = {
  adapterId: 'feishu',
  accountId: 'account',
  tenantId: 'tenant',
  conversationId: 'oc_group',
  kind: 'group' as const,
  threadId: 'oc_group',
  semantics: 'conversation' as const,
  eventId: 'om_event',
  actor: { adapterId: 'feishu', accountId: 'account', tenantId: 'tenant', userId: 'ou_alice' },
}
function sdk(get: () => Promise<unknown>, members?: () => Promise<unknown>) {
  return { rawClient: { contact: { v3: { user: { get } } }, im: { v1: { chatMembers: { get: members } } } } } as never
}

describe('incoming Channel sender identity', () => {
  it('retains sender ID, normalized name, platform, group and mention names separately from authority', () => {
    const context = channelMessageContext({ source: { event } } as never, {
      senderName: ' Alice\0 ',
      mentions: [{ key: '@1', userId: 'ou_bob', name: 'Bob' }],
    }, { conversation: 'Our group' })
    expect(context).toEqual({
      platform: '飞书',
      conversation: { id: 'oc_group', kind: 'group', name: 'Our group' },
      sender: { userId: 'ou_alice', name: 'Alice' },
      mentions: [{ key: '@1', userId: 'ou_bob', name: 'Bob' }],
    })
    expect(event.actor.userId).toBe('ou_alice')
  })

  it('shares one lookup, persists names across reopen and uses stale names while refreshing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'channel-sender-')), file = path.join(root, 'senders.json')
    let display = await ChannelConversationDisplayStore.open(file)
    let directory = new ChannelSenderDirectory(display)
    directory.retainAccounts([event])
    const get = vi.fn(async () => ({ code: 0, data: { user: { name: 'Alice' } } }))
    try {
      expect(await Promise.all([directory.name(event, sdk(get)), directory.name(event, sdk(get))])).toEqual([
        'Alice',
        'Alice',
      ])
      expect(get).toHaveBeenCalledOnce()
      directory.clear()
      await display.close()
      display = await ChannelConversationDisplayStore.open(file)
      directory = new ChannelSenderDirectory(display)
      directory.retainAccounts([event])
      expect(await directory.name(event, sdk(get))).toBe('Alice')
      expect(get).toHaveBeenCalledOnce()
      const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 60 * 60_000)
      try {
        expect(await directory.name(event, sdk(async () => ({ code: 1 })))).toBe('Alice')
      } finally {
        now.mockRestore()
      }
    } finally {
      directory.clear()
      await display.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('falls back to group member names and discards a response after account removal and re-addition', async () => {
    const directory = new ChannelSenderDirectory()
    directory.retainAccounts([event])
    expect(
      await directory.name(
        event,
        sdk(
          async () => ({ code: 1 }),
          async () => ({ code: 0, data: { items: [{ member_id: 'ou_alice', name: 'Alice' }] } }),
        ),
      ),
    ).toBe('Alice')
    directory.retainAccounts([])
    directory.retainAccounts([event])
    let resolve!: (value: unknown) => void
    const pending = directory.name(
      event,
      sdk(() =>
        new Promise(done => {
          resolve = done
        })
      ),
    )
    directory.retainAccounts([])
    directory.retainAccounts([event])
    resolve({ code: 0, data: { user: { name: 'Retired result' } } })
    expect(await pending).toBeUndefined()
    expect(await directory.name(event, undefined)).toBeUndefined()
    directory.clear()
  })

  it('bounds an unavailable lookup at two seconds, so sender enrichment cannot hang a task', async () => {
    vi.useFakeTimers()
    const directory = new ChannelSenderDirectory()
    try {
      const pending = directory.name(event, sdk(() => new Promise(() => {})))
      await vi.advanceTimersByTimeAsync(2_000)
      expect(await pending).toBeUndefined()
    } finally {
      directory.clear()
      vi.useRealTimers()
    }
  })
})
