type ReadLifetime = {
  active: Set<Promise<void>>
  retirement?: Promise<void>
}

/** Share renderer read lifetimes with the owner's resource and profile-fence cleanup. */
export class ManagerRendererReadLifetimes {
  private readonly renderers = new Map<string, ReadLifetime>()

  private state(rendererId: string): ReadLifetime {
    let state = this.renderers.get(rendererId)
    if (!state) {
      state = { active: new Set() }
      this.renderers.set(rendererId, state)
    }
    return state
  }

  begin(rendererId: string): (() => void) | undefined {
    const state = this.state(rendererId)
    if (state.retirement) return undefined
    let resolve!: () => void
    const read = new Promise<void>(done => {
      resolve = done
    })
    state.active.add(read)
    let finished = false
    return () => {
      if (finished) return
      finished = true
      state.active.delete(read)
      resolve()
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
