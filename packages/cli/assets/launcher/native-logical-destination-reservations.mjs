/** Fence a created destination before its reply is exposed, even after caller timeout. */
export class NativeLogicalDestinationReservations {
  #pending = new Map()
  constructor(fence) {
    this.fence = fence
  }
  register(id) {
    if (this.#pending.size >= 4096) throw new Error('Native reservation limit reached')
    const reservation = {}
    this.#pending.set(id, reservation)
    return reservation
  }
  observe(message) {
    if (message.method !== undefined || !this.#pending.has(message.id)) return
    const reservation = this.#pending.get(message.id)
    this.#pending.delete(message.id)
    const threadId = message.result?.thread?.id
    if (message.error === undefined && typeof threadId === 'string') {
      reservation.lease = this.fence.acquire(threadId)
    }
  }
}
