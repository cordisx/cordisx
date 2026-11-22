/** Drains owner-side managed-service calls before a lifecycle transition starts. */
export class ManagerManagedServiceUIGate {
  private inFlight = 0
  private reservation: symbol | undefined
  private fenced = false
  private closed = false
  private readonly waiters = new Set<() => void>()

  get open(): boolean {
    return !this.closed && !this.fenced && this.reservation === undefined
  }

  begin(): () => void {
    if (!this.open) throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
    this.inFlight++
    let finished = false
    return () => {
      if (finished) return
      finished = true
      this.inFlight--
      for (const waiter of this.waiters) waiter()
    }
  }

  async reserve(current: () => boolean, timeoutMs = 15_000): Promise<{
    isCurrent(): boolean
    release(): boolean
    fence(): void
  }> {
    if (!this.open || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
      throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
    }
    const token = Symbol('managed-service-ui-transition')
    this.reservation = token
    const alive = () => {
      try {
        return !this.closed && !this.fenced && this.reservation === token && current() === true
      } catch {
        return false
      }
    }
    const drained = this.inFlight === 0 || await new Promise<boolean>(resolve => {
      const finish = (value: boolean) => {
        clearTimeout(timer)
        this.waiters.delete(check)
        resolve(value)
      }
      const check = () => {
        if (!alive() || this.inFlight === 0) finish(alive() && this.inFlight === 0)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      timer.unref()
      this.waiters.add(check)
      check()
    })
    if (!drained || !alive() || this.inFlight !== 0) {
      if (alive()) this.reservation = undefined
      else this.fenced = true
      throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
    }
    let ended = false
    const valid = () => !ended && alive() && this.inFlight === 0
    return {
      isCurrent: valid,
      release: () => {
        if (ended) return false
        if (!valid()) {
          ended = true
          this.fenced = true
          return false
        }
        ended = true
        this.reservation = undefined
        return true
      },
      fence: () => {
        if (ended) return
        ended = true
        this.fenced = true
        this.reservation = undefined
      },
    }
  }

  close(): void {
    this.closed = true
    for (const waiter of this.waiters) waiter()
  }
}
