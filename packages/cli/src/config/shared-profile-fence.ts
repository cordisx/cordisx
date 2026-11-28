import { AsyncLocalStorage } from 'node:async_hooks'

/** Share one owner-held kernel fence among that owner's live renderer sessions. */
export class SharedProfileFence {
  private queue: Promise<void> = Promise.resolve()
  private readonly leases = new Set<symbol>()
  private unlock: (() => Promise<void>) | undefined
  private closed = false
  private closing: Promise<void> | undefined
  private readonly owned = new AsyncLocalStorage<symbol>()

  constructor(
    private readonly acquireLock: () => Promise<() => Promise<void>>,
    private readonly closedMessage: string,
  ) {}

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  async acquire(): Promise<() => Promise<void>> {
    if (this.owned.getStore() !== undefined) throw new Error(this.closedMessage)
    const lease = Symbol('profile-reader')
    await this.enqueue(async () => {
      if (this.closed) throw new Error(this.closedMessage)
      if (!this.unlock) {
        const release = await this.acquireLock()
        if (this.closed) {
          await release()
          throw new Error(this.closedMessage)
        }
        this.unlock = release
      }
      this.leases.add(lease)
    })
    if (this.closed) {
      await this.closing
      throw new Error(this.closedMessage)
    }
    let releasing: Promise<void> | undefined
    return () => {
      releasing ??= this.enqueue(async () => {
        if (!this.leases.delete(lease) || this.leases.size !== 0) return
        const release = this.unlock
        this.unlock = undefined
        await release?.()
      })
      if (this.owned.getStore() !== undefined) {
        // Queue real cleanup but never claim it completed inside its own writer.
        void releasing.catch(() => {})
        return Promise.reject(new Error(this.closedMessage))
      }
      return releasing
    }
  }

  /** Keep the kernel lock and all current leases held for one owner action. */
  protected async runWhileHeld<T>(action: (current: () => boolean) => Promise<T>): Promise<T> {
    if (this.owned.getStore() !== undefined) throw new Error(this.closedMessage)
    return await this.enqueue(async () => {
      if (this.closed || !this.unlock || this.leases.size === 0) throw new Error(this.closedMessage)
      const unlock = this.unlock
      let active = true
      try {
        return await this.owned.run(
          Symbol('profile-owner-write'),
          async () => await action(() => active && !this.closed && this.unlock === unlock && this.leases.size > 0),
        )
      } finally {
        active = false
      }
    })
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true
      this.closing = this.enqueue(async () => {
        this.leases.clear()
        const release = this.unlock
        this.unlock = undefined
        await release?.()
      })
    }
    // Waiting for our own queue entry would deadlock. Cleanup remains queued.
    if (this.owned.getStore() !== undefined) return Promise.reject(new Error(this.closedMessage))
    return this.closing
  }
}
