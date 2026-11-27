type Entry = { task: Promise<boolean>; result?: boolean }

/** Slow native history scans must not hold the Channel input and job pump. */
export class ChannelRecoveryScheduler {
  private readonly entries = new Map<string, Entry>()
  private closed = false

  async run(key: string, operation: () => Promise<boolean>): Promise<boolean> {
    if (this.closed) return true
    let entry = this.entries.get(key)
    if (entry?.result !== undefined) {
      this.entries.delete(key)
      return entry.result
    }
    if (!entry) {
      if (this.entries.size >= 256) {
        for (const [id, item] of this.entries) if (item.result !== undefined) this.entries.delete(id)
        if (this.entries.size >= 256) return true
      }
      entry = { task: Promise.resolve(false) }
      const current = entry
      current.task = Promise.resolve().then(operation).then(result => {
        current.result = result
        return result
      })
      this.entries.set(key, current)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const completed = await Promise.race([
        entry.task.then(() => true),
        new Promise<false>(resolve => {
          timer = setTimeout(() => resolve(false), 100)
        }),
      ])
      if (!completed) return true
      this.entries.delete(key)
      return entry.result ?? true
    } finally {
      clearTimeout(timer)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.entries.values()].map(entry => entry.task))
    this.entries.clear()
  }
}
