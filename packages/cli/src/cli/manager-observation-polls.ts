type Settled = { readonly ok: true; readonly value: unknown } | { readonly ok: false }
type Entry = {
  readonly payload: string
  readonly result: Promise<Settled>
  settled: boolean
  delivered: boolean
}

/** Keep one owner call while a browser yields its scarce HTTP connection between polls. */
export class ManagerObservationPolls {
  private readonly entries = new Map<string, Entry>()
  private closed = false

  constructor(private readonly waitMs = 750) {}

  async poll(
    requestId: string,
    payload: string,
    start: () => Promise<unknown>,
  ): Promise<{ readonly status: 'pending' } | { readonly status: 'complete'; readonly value: unknown }> {
    if (this.closed) throw new Error('manager-observation-unavailable')
    let entry = this.entries.get(requestId)
    if (entry && entry.payload !== payload) throw new Error('manager-observation-unavailable')
    if (!entry) {
      if (this.entries.size >= 64) {
        for (const [key, previous] of this.entries) {
          if (previous.settled && previous.delivered) this.entries.delete(key)
          if (this.entries.size < 64) break
        }
      }
      if (this.entries.size >= 64) throw new Error('manager-observation-unavailable')
      let created!: Entry
      const result = Promise.resolve().then(start).then(
        value => {
          created.settled = true
          return { ok: true as const, value }
        },
        () => {
          created.settled = true
          return { ok: false as const }
        },
      )
      created = { payload, result, settled: false, delivered: false }
      entry = created
      this.entries.set(requestId, entry)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        entry.result,
        new Promise<undefined>(resolve => {
          timer = setTimeout(() => resolve(undefined), this.waitMs)
        }),
      ])
      if (this.closed) throw new Error('manager-observation-unavailable')
      if (result === undefined) return { status: 'pending' }
      entry.delivered = true
      if (!result.ok) throw new Error('manager-observation-unavailable')
      return { status: 'complete', value: result.value }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  close(): void {
    this.closed = true
    this.entries.clear()
  }
}
