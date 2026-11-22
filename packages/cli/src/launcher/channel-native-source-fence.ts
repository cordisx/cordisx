const ownerPermit = Symbol('logical-owner-permit')
/** Serializes source migration against native writes issued by this Host owner. */
export class ChannelNativeSourceFence {
  private readonly migrating = new Set<string>()
  private readonly writers = new Map<string, number>()
  constructor(private readonly persisted: (threadId: string) => boolean) {}
  isMigrating(threadId: string) {
    return this.migrating.has(threadId)
  }
  beginMigration(threadId: string): (() => void) | undefined {
    if (this.migrating.has(threadId) || this.writers.has(threadId)) return undefined
    this.migrating.add(threadId)
    let released = false
    return () => {
      if (released) return
      released = true
      this.migrating.delete(threadId)
    }
  }
  enterNative(method: string, params: Readonly<Record<string, unknown>>): () => void {
    const threadId = params.threadId
    if (typeof threadId !== 'string' || ['thread/read', 'thread/items/list', 'thread/turns/list'].includes(method)) {
      return () => {}
    }
    const permit = (params as { [ownerPermit]?: { owner: unknown; method: unknown } })[ownerPermit]
    if (this.migrating.has(threadId) && permit?.owner === this && permit.method === method) return () => {}
    if (this.migrating.has(threadId) || this.persisted(threadId)) throw new Error('CONTINUATION_PENDING')
    this.writers.set(threadId, (this.writers.get(threadId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = this.writers.get(threadId) ?? 0
      if (count <= 1) this.writers.delete(threadId)
      else this.writers.set(threadId, count - 1)
    }
  }
  allowFork(threadId: string, params: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    return this.allowOwned('thread/fork', threadId, params)
  }
  allowOwned(
    method: 'thread/fork' | 'thread/name/set' | 'thread/resume' | 'thread/metadata/update' | 'thread/section/move',
    threadId: string,
    params: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> {
    if (!this.migrating.has(threadId) || params.threadId !== threadId) throw new Error('CONTINUATION_PENDING')
    return { ...params, [ownerPermit]: { owner: this, method } }
  }
}
