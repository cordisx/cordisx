type Outcome = 'empty' | 'offered' | 'failed'
type State = 'pending' | Outcome | 'acknowledged' | 'skipped'
type Entry = {
  readonly sequence: number
  readonly settled: Promise<void>
  readonly resolve: () => void
  state: State
}

/** Tracks poll delivery without replaying commands or their receipts. */
export class ManagerLifecyclePolls {
  private mode: 'legacy' | 'tracked' | undefined
  private current: Entry | undefined
  private nextSequence = 1
  private recovering = false
  private closed = false

  constructor(private readonly waitMs = 20_000) {}

  begin(sequence: number | undefined): { finish(outcome: Outcome): void } | undefined {
    if (this.closed) return undefined
    if (sequence === undefined) {
      if (this.mode === 'tracked') return undefined
      this.mode = 'legacy'
      return { finish: () => {} }
    }
    if (
      this.mode === 'legacy' || !Number.isSafeInteger(sequence) || sequence !== this.nextSequence
      || sequence >= Number.MAX_SAFE_INTEGER || this.current?.state === 'pending'
      || this.current?.state === 'offered' || this.current?.state === 'failed' || this.recovering
    ) return undefined
    this.mode = 'tracked'
    this.nextSequence++
    const entry = this.create(sequence, 'pending')
    this.current = entry
    return {
      finish: outcome => {
        if (entry.state !== 'pending') return
        entry.state = outcome
        entry.resolve()
      },
    }
  }

  acknowledge(): void {
    if (this.current?.state === 'offered') this.current.state = 'acknowledged'
  }

  async recover(sequence: number, signal: AbortSignal, confirm: () => Promise<boolean>): Promise<boolean> {
    if (
      this.closed || this.mode === 'legacy' || this.recovering || signal.aborted
      || !Number.isSafeInteger(sequence) || sequence < 1 || sequence >= Number.MAX_SAFE_INTEGER
    ) return false
    this.recovering = true
    const deny = () => {
      this.close()
      return false
    }
    try {
      let entry = this.current
      if (sequence === this.nextSequence) {
        if (this.current && !['empty', 'acknowledged', 'skipped'].includes(this.current.state)) return deny()
        // Seal an as-yet unseen sequence so a delayed poll cannot run later.
        this.mode = 'tracked'
        this.nextSequence++
        entry = this.create(sequence, 'skipped')
        this.current = entry
      }
      if (!entry || entry.sequence !== sequence) return deny()
      if (entry.state === 'pending') {
        let timer: ReturnType<typeof setTimeout> | undefined
        let abort: (() => void) | undefined
        try {
          await Promise.race([
            entry.settled,
            new Promise<void>(resolve => {
              timer = setTimeout(resolve, this.waitMs)
              abort = resolve
              signal.addEventListener('abort', abort, { once: true })
              if (signal.aborted) resolve()
            }),
          ])
        } finally {
          if (timer !== undefined) clearTimeout(timer)
          if (abort !== undefined) signal.removeEventListener('abort', abort)
        }
      }
      const current = () =>
        !this.closed && !signal.aborted && this.current === entry
        && (entry.state === 'empty' || entry.state === 'skipped')
      if (!current()) return deny()
      if (!await confirm().catch(() => false) || !current()) return deny()
      return true
    } finally {
      this.recovering = false
    }
  }

  close(): void {
    this.closed = true
    if (this.current?.state === 'pending') {
      this.current.state = 'failed'
      this.current.resolve()
    }
  }

  private create(sequence: number, state: State): Entry {
    let resolve!: () => void
    const settled = new Promise<void>(done => resolve = done)
    if (state !== 'pending') resolve()
    return { sequence, state, settled, resolve }
  }
}
