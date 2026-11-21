/** Share one owner-held kernel fence among that owner's live renderer sessions. */
export class SharedProfileFence {
  private queue: Promise<void> = Promise.resolve()
  private readonly leases = new Set<symbol>()
  private unlock: (() => Promise<void>) | undefined
  private closed = false
  private closing: Promise<void> | undefined

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
    let ended = false
    return async () => {
      if (ended) return
      ended = true
      await this.enqueue(async () => {
        if (!this.leases.delete(lease) || this.leases.size !== 0) return
        const release = this.unlock
        this.unlock = undefined
        await release?.()
      })
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = this.enqueue(async () => {
      this.leases.clear()
      const release = this.unlock
      this.unlock = undefined
      await release?.()
    })
    return this.closing
  }
}
