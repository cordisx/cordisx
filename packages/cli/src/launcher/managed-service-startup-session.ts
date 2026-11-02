import { randomUUID } from 'node:crypto'

/** Host-internal journal. Public projections are supplied by the startup authority. */
export interface StartupSessionRevision<T> {
  readonly epoch: string
  readonly sequence: number
  readonly value: T
}

/** One retained authority, with independent observers and cancellable waiters. */
export class StartupSession<T> {
  private current: StartupSessionRevision<T>
  private readonly listeners = new Set<(snapshot: StartupSessionRevision<T>) => void>()
  private readonly closeListeners = new Set<(reason: Error) => void>()
  private readonly pending: StartupSessionRevision<T>[] = []
  private delivering = false
  private closed: Error | undefined

  constructor(value: T, epoch = randomUUID()) {
    this.current = Object.freeze({ epoch, sequence: 0, value })
  }

  snapshot(): StartupSessionRevision<T> {
    return this.current
  }

  update(value: T): void {
    if (this.closed !== undefined) return
    this.current = Object.freeze({ epoch: this.current.epoch, sequence: this.current.sequence + 1, value })
    this.pending.push(this.current)
    if (this.delivering) return
    this.delivering = true
    try {
      while (this.pending.length > 0) {
        const snapshot = this.pending.shift()!
        for (const listener of [...this.listeners]) {
          if (!this.listeners.has(listener)) continue
          try {
            listener(snapshot)
          } catch { /* Reader isolation. */ }
        }
      }
    } finally {
      this.delivering = false
    }
  }

  /** Install before reading. A full snapshot repairs any missed sequence or epoch. */
  subscribe(listener: (snapshot: StartupSessionRevision<T>) => void): () => void {
    if (this.closed !== undefined) throw this.closed
    let lastSequence = -1
    const ordered = (snapshot: StartupSessionRevision<T>) => {
      if (snapshot.sequence <= lastSequence) return
      lastSequence = snapshot.sequence
      listener(snapshot)
    }
    this.listeners.add(ordered)
    try {
      ordered(this.current)
    } catch { /* Reader isolation. */ }
    return () => this.listeners.delete(ordered)
  }

  wait(
    predicate: (snapshot: StartupSessionRevision<T>) => boolean,
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
  ): Promise<StartupSessionRevision<T>> {
    if (this.closed !== undefined) return Promise.reject(this.closed)
    if (options.signal?.aborted) return Promise.reject(options.signal.reason)
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
      return Promise.reject(new Error('startup wait timeout is invalid'))
    }
    return new Promise((resolve, reject) => {
      let settled = false
      let unsubscribe: (() => void) | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (error?: unknown, snapshot?: StartupSessionRevision<T>) => {
        if (settled) return
        settled = true
        unsubscribe?.()
        if (timer !== undefined) clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        this.closeListeners.delete(close)
        if (snapshot !== undefined) resolve(snapshot)
        else reject(error)
      }
      const abort = () => finish(options.signal?.reason ?? new Error('startup wait cancelled'))
      const close = (reason: Error) => finish(reason)
      this.closeListeners.add(close)
      options.signal?.addEventListener('abort', abort, { once: true })
      unsubscribe = this.subscribe(snapshot => {
        try {
          if (predicate(snapshot)) finish(undefined, snapshot)
        } catch (error) {
          finish(error)
        }
      })
      // subscribe delivers synchronously, before its disposer can be assigned.
      if (settled) unsubscribe()
      else if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => finish(new Error('startup wait timed out')), options.timeoutMs)
      }
    })
  }

  dispose(reason = new Error('startup session disposed')): void {
    if (this.closed !== undefined) return
    this.closed = reason
    for (const close of [...this.closeListeners]) close(reason)
    this.closeListeners.clear()
    this.listeners.clear()
    this.pending.length = 0
  }
}
