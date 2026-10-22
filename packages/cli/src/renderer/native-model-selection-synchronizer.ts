interface NativeSelectionControl {
  readonly model: string
  readonly reasoningEffort?: string
  selectModel(model: string, effort?: string): Promise<void>
}

/** Coalesce native updates and wait for React's committed selection before releasing Send. */
export class NativeModelSelectionSynchronizer {
  private pending: { readonly key: string; readonly completion: Promise<void> } | undefined

  async synchronize(options: {
    readonly scopeKey: string
    readonly model: string
    readonly effort: string | undefined
    readonly verifyEffort: boolean
    readonly readControl: () => NativeSelectionControl | undefined
    readonly assertCurrent: () => void
  }): Promise<void> {
    const { model, effort, verifyEffort, readControl, assertCurrent } = options
    assertCurrent()
    const control = readControl()
    if (!control) throw new Error('Native model control unavailable')
    const key = JSON.stringify([options.scopeKey, model, effort])
    if (this.pending?.key === key) await this.pending.completion
    else if (control.model !== model || verifyEffort && control.reasoningEffort !== effort) {
      const update = { key, completion: control.selectModel(model, effort) }
      this.pending = update
      try {
        await update.completion
      } finally {
        if (this.pending === update) this.pending = undefined
      }
    }
    for (let attempt = 0;; attempt++) {
      assertCurrent()
      const live = readControl()
      if (live?.model === model && (!verifyEffort || live.reasoningEffort === effort)) return
      if (attempt >= 80) throw new Error('Native model selection was not acknowledged')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
}
