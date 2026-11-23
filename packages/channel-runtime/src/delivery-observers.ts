import type { ChannelPluginIdentity, ChannelThreadRef } from './types.js'
import type { ChannelStoreState, StoredOutboxRecord } from './store.js'

export interface ChannelSentDelivery {
  readonly target: ChannelThreadRef
  readonly caller: ChannelPluginIdentity
  readonly deliveryId: string
  readonly createdAt: string
  readonly sentAt: string
}

/** Process-local launcher observation; callbacks cannot change or gate the outbox. */
export class ChannelDeliveryObservers {
  readonly enqueued = new Set<(target: ChannelThreadRef) => void>()
  private readonly sent = new Set<(event: ChannelSentDelivery) => void>()
  private readonly guards = new Map<string, () => boolean>()
  guard(id: string, current: () => boolean) {
    if (!this.guards.has(id)) this.guards.set(id, current)
  }
  guarded(id: string) {
    return this.guards.has(id)
  }
  permitted(id: string) {
    try {
      return this.guards.get(id)?.() === true
    } catch {
      return false
    }
  }
  cancelStale(state: ChannelStoreState, claimed: StoredOutboxRecord, now: string) {
    const row = state.outbox[claimed.deliveryId]
    if (row?.status === 'processing') state.outbox[claimed.deliveryId] = { ...row, status: 'cancelled', updatedAt: now }
    this.guards.delete(claimed.deliveryId)
  }
  observeSent = (listener: (event: ChannelSentDelivery) => void) => {
    this.sent.add(listener)
    return () => {
      this.sent.delete(listener)
    }
  }
  observeEnqueued = (listener: (target: ChannelThreadRef) => void) => {
    this.enqueued.add(listener)
    return () => {
      this.enqueued.delete(listener)
    }
  }
  confirmed(event: ChannelSentDelivery) {
    this.guards.delete(event.deliveryId)
    for (const listener of this.sent) {
      try {
        listener(event)
      } catch {}
    }
  }
  dispose() {
    this.enqueued.clear()
    this.sent.clear()
    this.guards.clear()
  }
}
