import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const failure = vi.hoisted(() => ({ directorySync: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args)
      if (args[1] === 'r' && failure.directorySync) {
        failure.directorySync = false
        return new Proxy(handle, {
          get(target, key) {
            if (key === 'sync') {
              return async () => {
                throw new Error('directory sync failed')
              }
            }
            const value = Reflect.get(target, key, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
      }
      return handle
    },
  }
})
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'

describe('Channel store uncertain durability', () => {
  it('serializes committed state with its native fence projection', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cx-store-barrier-'))
    try {
      const store = await ChannelConversationStore.open(path.join(dir, 'state.json'))
      let unblock!: () => void
      const gate = new Promise<void>(resolve => {
        unblock = resolve
      })
      const seen: number[] = []
      await store.bindCommitBarrier(async state => {
        seen.push(state.nextSequence)
        if (state.nextSequence === 2) await gate
      })
      let finished = false
      const first = store.mutate(state => {
        state.nextSequence = 2
      }).then(() => {
        finished = true
      })
      const second = store.mutate(state => {
        state.nextSequence = 3
      })
      await vi.waitFor(() => expect(seen).toEqual([1, 2]))
      expect(finished).toBe(false)
      unblock()
      await Promise.all([first, second])
      expect(seen).toEqual([1, 2, 3])
      await store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('pauses writes on native disconnect until the persisted projection is restored', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cx-store-pause-'))
    try {
      const store = await ChannelConversationStore.open(path.join(dir, 'state.json'))
      const barrier = vi.fn(async () => {})
      await store.bindCommitBarrier(barrier)
      store.pauseCommitBarrier()
      expect(store.hasCommitBarrier()).toBe(false)
      await expect(store.mutate(state => {
        state.nextSequence = 2
      })).rejects.toThrow('CONVERSATION_STORE_UNAVAILABLE')
      await store.resumeCommitBarrier()
      expect(barrier).toHaveBeenCalledTimes(2)
      expect(store.hasCommitBarrier()).toBe(true)
      await store.mutate(state => {
        state.nextSequence = 2
      })
      await store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('stops the owner if a committed fence cannot be synchronized', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cx-store-barrier-failure-'))
    try {
      const file = path.join(dir, 'state.json'), store = await ChannelConversationStore.open(file)
      await store.bindCommitBarrier(async state => {
        if (state.nextSequence === 2) throw new Error('fence unavailable')
      })
      await expect(store.mutate(state => {
        state.nextSequence = 2
      })).rejects.toThrow('fence unavailable')
      expect(JSON.parse(await readFile(file, 'utf8')).nextSequence).toBe(2)
      expect(() => store.snapshot()).toThrow('CONVERSATION_STORE_DURABILITY_UNCERTAIN')
      await store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('drains accepted writes and rejects late access after the profile owner closes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cx-store-close-'))
    try {
      const file = path.join(dir, 'state.json'), store = await ChannelConversationStore.open(file)
      const write = store.mutate(state => {
        state.nextSequence = 2
      })
      const closed = store.close()
      await expect(store.mutate(state => {
        state.nextSequence = 3
      })).rejects.toThrow('CONVERSATION_STORE_CLOSED')
      expect(() => store.snapshot()).toThrow('CONVERSATION_STORE_CLOSED')
      await write
      await closed
      const reopened = await ChannelConversationStore.open(file)
      expect(reopened.snapshot().nextSequence).toBe(2)
      await reopened.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('fences further use if the renamed state cannot be durably confirmed', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cx-store-sync-'))
    try {
      const file = path.join(dir, 'state.json'), store = await ChannelConversationStore.open(file)
      failure.directorySync = true
      await expect(store.mutate(state => {
        state.nextSequence = 2
      })).rejects.toThrow('directory sync failed')
      expect(() => store.snapshot()).toThrow('CONVERSATION_STORE_DURABILITY_UNCERTAIN')
      await expect(store.mutate(state => {
        state.nextSequence = 3
      }))
        .rejects.toThrow('CONVERSATION_STORE_DURABILITY_UNCERTAIN')
      expect(JSON.parse(await readFile(file, 'utf8')).nextSequence).toBe(2)
      await store.close()
      const reopened = await ChannelConversationStore.open(file)
      expect(reopened.snapshot().nextSequence).toBe(2)
      await reopened.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
