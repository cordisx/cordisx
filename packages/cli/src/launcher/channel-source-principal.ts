import type { ChannelEventRef } from '@cordisx/channel-runtime'

/** Equality excludes the message ID but retains the sender and complete conversation scope. */
export function sameChannelPrincipal(left: ChannelEventRef, right: ChannelEventRef): boolean {
  return !!left.actor?.userId && left.actor.userId === right.actor?.userId
    && (['adapterId', 'accountId', 'tenantId', 'conversationId', 'kind', 'threadId', 'semantics'] as const)
      .every(key => left[key] === right[key])
}

export function channelPrincipalSource(entries: readonly { source: ChannelEventRef }[]): ChannelEventRef | undefined {
  const first = entries[0]?.source
  return first && entries.every(entry => entry.source === first || sameChannelPrincipal(first, entry.source))
    ? first
    : undefined
}

export function waitForChannelSource(waitersByThread: Map<string, Set<() => void>>, threadId: string): Promise<void> {
  return new Promise(resolve => {
    const waiters = waitersByThread.get(threadId) ?? new Set<() => void>()
    const finish = () => {
      clearTimeout(timer)
      waiters.delete(finish)
      if (!waiters.size) waitersByThread.delete(threadId)
      resolve()
    }
    const timer = setTimeout(finish, 2_000)
    waiters.add(finish)
    waitersByThread.set(threadId, waiters)
  })
}

export function signalChannelSource(waitersByThread: Map<string, Set<() => void>>, threadId: string): void {
  const waiters = waitersByThread.get(threadId)
  waitersByThread.delete(threadId)
  waiters?.forEach(resolve => resolve())
}
