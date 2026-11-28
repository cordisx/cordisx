type ReadLifetime = {
  active: Set<Promise<void>>
  channelConfigurationReads: Set<Promise<void>>
  retirement?: Promise<void>
}

/** Share renderer read lifetimes with the owner's resource and profile-fence cleanup. */
export class ManagerRendererReadLifetimes {
  private readonly renderers = new Map<string, ReadLifetime>()

  private state(rendererId: string): ReadLifetime {
    let state = this.renderers.get(rendererId)
    if (!state) {
      state = { active: new Set(), channelConfigurationReads: new Set() }
      this.renderers.set(rendererId, state)
    }
    return state
  }

  begin(rendererId: string, channelConfigurationIndependent = false): (() => void) | undefined {
    const state = this.state(rendererId)
    if (state.retirement) return undefined
    let resolve!: () => void
    const read = new Promise<void>(done => {
      resolve = done
    })
    state.active.add(read)
    if (!channelConfigurationIndependent) state.channelConfigurationReads.add(read)
    let finished = false
    return () => {
      if (finished) return
      finished = true
      state.active.delete(read)
      state.channelConfigurationReads.delete(read)
      resolve()
    }
  }

  /** Wait for Channel-dependent reads dispatched before its owner-specific gate closed. */
  async drainCurrent(rendererId: string, timeoutMs = 15_000): Promise<boolean> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) return false
    const state = this.state(rendererId)
    if (state.retirement) return false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const drained = await Promise.race([
        Promise.all(state.channelConfigurationReads).then(() => true),
        new Promise<boolean>(resolve => {
          timer = setTimeout(() => resolve(false), timeoutMs)
        }),
      ])
      return drained && state.retirement === undefined
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** No new read may start after retirement; existing reads must settle first. */
  retire(rendererId: string): Promise<void> {
    const state = this.state(rendererId)
    if (!state.retirement) {
      state.retirement = Promise.all(state.active).then(() => undefined)
    }
    return state.retirement
  }
}
