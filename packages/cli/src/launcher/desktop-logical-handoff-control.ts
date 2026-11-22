import type { ProfileLogicalConversationOwner } from './profile-logical-conversation-owner.js'
import type { ChannelLogicalHandoffPermits } from './channel-logical-handoff-permits.js'
import { inspectChannelLogicalHandoff } from './channel-logical-handoff.js'

const valid = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value)
const methods = ['turn/start', 'turn/steer', 'turn/addUserMessage']

/** Holds the profile's mutation queue until the intermediary has written an authorized checkpoint. */
export function createDesktopLogicalHandoffControl(input: {
  owner(): ProfileLogicalConversationOwner | undefined
  permits(): ChannelLogicalHandoffPermits | undefined
}) {
  const leases = new Map<string, { cancelled: boolean; release?: () => void }>()
  return {
    async handle(value: Record<string, unknown>, alive: () => boolean) {
      if (value.type === 'logical-handoff-release') {
        if (!valid(value.lease)) return false
        const pending = leases.get(value.lease)
        if (!pending) return false
        leases.delete(value.lease)
        pending.cancelled = true
        pending.release?.()
        return true
      }
      if (!valid(value.threadId) || typeof value.method !== 'string' || !methods.includes(value.method)) {
        return { state: 'blocked' as const }
      }
      const owner = input.owner(), permits = input.permits(), threadId = value.threadId, method = value.method
      if (!owner?.store.hasCommitBarrier() || !alive()) return { state: 'blocked' as const }
      if (value.type === 'logical-handoff-status') {
        const pending = inspectChannelLogicalHandoff(owner.store.snapshot(), method, threadId)
        if (pending.state !== 'pending') return pending
        const marker = permits?.peek(pending.jobId, threadId)
        return marker ? { ...pending, marker } : { state: 'blocked' as const }
      }
      if (
        value.type !== 'logical-handoff-authorize' || !valid(value.marker)
        || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.digest)
        || typeof value.guardId !== 'string' || !/^[a-f0-9]{48}$/u.test(value.guardId)
        || leases.has(value.guardId) || leases.size >= 128
      ) {
        return { state: 'blocked' as const }
      }
      const marker = value.marker, digest = value.digest, guardId = value.guardId
      const lease: { cancelled: boolean; release?: () => void } = { cancelled: false }
      leases.set(guardId, lease)
      let held: Awaited<ReturnType<typeof owner.store.holdCommittedSnapshot<boolean>>>
      try {
        held = await owner.store.holdCommittedSnapshot(state => {
          if (lease.cancelled || !alive()) return false
          const pending = inspectChannelLogicalHandoff(state, method, threadId)
          return pending.state === 'pending' && pending.digest === digest
            && permits?.consume(pending.jobId, threadId, marker) === true
        })
      } catch {
        if (leases.get(guardId) === lease) leases.delete(guardId)
        return { state: 'blocked' as const }
      }
      if (!held.value || lease.cancelled || !alive()) {
        if (leases.get(guardId) === lease) leases.delete(guardId)
        held.release()
        return { state: 'blocked' as const }
      }
      lease.release = held.release
      return { state: 'authorized' as const, lease: guardId }
    },
    releaseAll() {
      for (const pending of leases.values()) {
        pending.cancelled = true
        pending.release?.()
      }
      leases.clear()
    },
  }
}
