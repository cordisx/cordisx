type WorkMode = 'default' | 'plan'
type Evidence = { readonly mode?: WorkMode; readonly revision: number }

/**
 * Evidence for an exclusively owned app-server, separate from native readback.
 * Codex 0.149.1 and 0.167.0-alpha.3.2 initialize new sessions in default mode. A resumed
 * or otherwise unknown thread is never assigned that default here.
 */
export class HeadlessWorkMode {
  private readonly threads = new Map<string, Evidence>()
  private readonly pending = new Map<string, number>()
  private revision = 0
  constructor(private readonly knownNewThreadDefault: boolean) {}

  private put(threadId: string, mode?: WorkMode): Evidence {
    const entry = { ...(mode === undefined ? {} : { mode }), revision: ++this.revision }
    this.threads.set(threadId, entry)
    if (this.threads.size > 512) this.threads.delete(this.threads.keys().next().value!)
    return entry
  }

  started(threadId: string): void {
    if (this.knownNewThreadDefault && !this.threads.has(threadId)) this.put(threadId, 'default')
  }

  observe(threadId: string, value: unknown): void {
    this.put(threadId, !this.pending.get(threadId) && (value === 'default' || value === 'plan') ? value : undefined)
  }

  begin(threadId: string) {
    const previous = this.threads.get(threadId)?.mode
    this.pending.set(threadId, (this.pending.get(threadId) ?? 0) + 1)
    const pending = this.put(threadId)
    let settled = false
    return (accepted: boolean, requested: unknown, unchanged: boolean) => {
      if (settled) return
      settled = true
      const remaining = (this.pending.get(threadId) ?? 1) - 1
      if (remaining) this.pending.set(threadId, remaining)
      else this.pending.delete(threadId)
      if (remaining || this.threads.get(threadId)?.revision !== pending.revision) return
      const mode = requested === 'default' || requested === 'plan' ? requested : undefined
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
  }
}
