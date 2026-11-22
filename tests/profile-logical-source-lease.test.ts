import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { profileLogicalConversationOwner } from '../packages/cli/src/launcher/profile-logical-conversation-owner.js'
import { acquireProfileLogicalSource } from '../packages/cli/src/launcher/profile-logical-source-lease.js'

describe('profile logical source lease', () => {
  it('holds both fences until native release is acknowledged', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'logical-source-'))
    try {
      const store = await ChannelConversationStore.open(path.join(dir, 'state.json'))
      const owner = profileLogicalConversationOwner(store)
      const native = { acquireLogicalFence: vi.fn(async () => 'lease'), releaseLogicalFence: vi.fn(async () => true) }
      const acquired = await acquireProfileLogicalSource(owner, native, 'source')
      expect(acquired.state).toBe('acquired')
      if (acquired.state !== 'acquired') throw new Error('not acquired')
      expect(() => owner.fence.enterNative('turn/start', { threadId: 'source' })).toThrow('CONTINUATION_PENDING')
      expect(await acquireProfileLogicalSource(owner, native, 'source')).toEqual({ state: 'busy' })
      expect(await acquired.release()).toBe(true)
      expect(await acquired.release()).toBe(false)
      expect(native.releaseLogicalFence).toHaveBeenCalledOnce()
      const releaseWriter = owner.fence.enterNative('turn/start', { threadId: 'source' })
      releaseWriter()
      await store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('keeps the local fence when remote acquisition or release has an unknown outcome', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'logical-source-unknown-'))
    try {
      const store = await ChannelConversationStore.open(path.join(dir, 'state.json'))
      const owner = profileLogicalConversationOwner(store)
      const native = {
        acquireLogicalFence: vi.fn(async (id: string) => {
          if (id === 'unknown-acquire') throw new Error('timeout')
          return 'lease'
        }),
        releaseLogicalFence: vi.fn(async () => {
          throw new Error('timeout')
        }),
      }
      expect(await acquireProfileLogicalSource(owner, native, 'unknown-acquire')).toEqual({ state: 'unknown' })
      expect(owner.fence.isMigrating('unknown-acquire')).toBe(true)
      const acquired = await acquireProfileLogicalSource(owner, native, 'unknown-release')
      if (acquired.state !== 'acquired') throw new Error('not acquired')
      expect(await acquired.release()).toBe(false)
      expect(owner.fence.isMigrating('unknown-release')).toBe(true)
      await store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
