type WorkMode = 'default' | 'plan'
type Evidence = { readonly mode?: WorkMode; readonly pendingObservation?: WorkMode; readonly revision: number }

/**
 * Evidence for an exclusively owned app-server, separate from native readback.
 * Codex 0.149.1 and 0.167.0-alpha.3.2 initialize new sessions in default mode. A resumed
 * or otherwise unknown thread is never assigned that default here.
 */
export class HeadlessWorkMode {
  private readonly threads = new Map<string, Evidence>()
  private readonly pending = new Map<string, number>()
  private readonly concurrent = new Set<string>()
  private revision = 0
  constructor(private readonly knownNewThreadDefault: boolean) {}

  private put(threadId: string, mode?: WorkMode, pendingObservation?: WorkMode): Evidence {
    const entry = {
      ...(mode === undefined ? {} : { mode }),
      ...(pendingObservation === undefined ? {} : { pendingObservation }),
      revision: ++this.revision,
    }
    this.threads.set(threadId, entry)
    if (this.threads.size > 512) this.threads.delete(this.threads.keys().next().value!)
    return entry
  }

  started(threadId: string): void {
    if (this.knownNewThreadDefault && !this.threads.has(threadId)) this.put(threadId, 'default')
  }

  observe(threadId: string, value: unknown): void {
    const mode = value === 'default' || value === 'plan' ? value : undefined
    if (this.pending.get(threadId)) this.put(threadId, undefined, mode)
    else this.put(threadId, mode)
  }

  begin(threadId: string) {
    const previous = this.threads.get(threadId)?.mode
    if (this.pending.get(threadId)) this.concurrent.add(threadId)
    this.pending.set(threadId, (this.pending.get(threadId) ?? 0) + 1)
    const pending = this.put(threadId)
    let settled = false
    return (accepted: boolean, requested: unknown, unchanged: boolean) => {
      if (settled) return
      settled = true
      const remaining = (this.pending.get(threadId) ?? 1) - 1
      if (remaining) this.pending.set(threadId, remaining)
      else this.pending.delete(threadId)
      const mode = requested === 'default' || requested === 'plan' ? requested : undefined
      if (remaining) return
      const concurrent = this.concurrent.delete(threadId)
      const latest = this.threads.get(threadId)
      if (concurrent) return
      if (latest?.revision !== pending.revision) {
        if (accepted && mode && latest?.pendingObservation === mode) this.put(threadId, mode)
        return
      }
      this.put(threadId, accepted ? mode ?? (unchanged ? previous : undefined) : undefined)
    }
  }

  forget(threadId: string): void {
    this.put(threadId)
  }
  get(threadId: string): WorkMode | undefined {
    return this.threads.get(threadId)?.mode
  }
  clear(): void {
    this.threads.clear()
    this.pending.clear()
    this.concurrent.clear()
    this.pending.clear()
  }
}
