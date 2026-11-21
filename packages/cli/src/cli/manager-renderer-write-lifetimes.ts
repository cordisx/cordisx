type WriteLifetime = {
  active: number
  retirement?: Promise<boolean>
  finishRetirement?: () => void
}

/** Shared by the owner session authority and bootstrap resource cleanup. */
export class ManagerRendererWriteLifetimes {
  private readonly renderers = new Map<string, WriteLifetime>()

  private state(rendererId: string): WriteLifetime {
    let state = this.renderers.get(rendererId)
    if (!state) {
      state = { active: 0 }
      this.renderers.set(rendererId, state)
    }
    return state
  }

  begin(rendererId: string): (() => void) | undefined {
    const state = this.state(rendererId)
    if (state.retirement) return undefined
    state.active++
    let finished = false
    return () => {
      if (finished) return
      finished = true
      state.active--
      if (state.active === 0) state.finishRetirement?.()
    }
  }

  hasActive(rendererId: string): boolean {
    return (this.renderers.get(rendererId)?.active ?? 0) > 0
  }

  /** A write still running at retirement has an uncertain result, even after it settles. */
  retire(rendererId: string): Promise<boolean> {
    const state = this.state(rendererId)
    if (!state.retirement) {
      state.retirement = state.active === 0
        ? Promise.resolve(true)
        : new Promise(resolve => {
          state.finishRetirement = () => resolve(false)
        })
    }
    return state.retirement
  }
}
