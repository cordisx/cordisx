export interface ChannelSettingsDraftSnapshot {
  readonly value: Readonly<Record<string, unknown>>
  readonly baseline: Readonly<Record<string, unknown>>
  readonly revision: number
  readonly conflict: boolean
  readonly formRevision: number
}

/** One source/generation owns this in-memory draft; no account data or new store is created. */
export class ChannelSettingsDraft {
  private state?: ChannelSettingsDraftSnapshot
  private readonly listeners = new Set<() => void>()
  initialize(value: Record<string, unknown>, revision: number): void {
    if (this.state) return
    this.state = {
      value: structuredClone(value),
      baseline: structuredClone(value),
      revision,
      conflict: false,
      formRevision: 0,
    }
  }
  snapshot = (): ChannelSettingsDraftSnapshot => {
    if (!this.state) throw new Error('SETTINGS_DRAFT_NOT_INITIALIZED')
    return this.state
  }
  subscribe = (listener: () => void): () => void => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private update(next: ChannelSettingsDraftSnapshot): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }
  change(value: Readonly<Record<string, unknown>>): void {
    this.update({ ...this.snapshot(), value: structuredClone(value) })
  }
  commit(value: Record<string, unknown>, revision: number): void {
    this.update({
      value: structuredClone(value),
      baseline: structuredClone(value),
      revision,
      conflict: false,
      formRevision: this.snapshot().formRevision + 1,
    })
  }
  commitFields(
    value: Record<string, unknown>,
    revision: number,
    fields: readonly string[],
    submitted?: Readonly<Record<string, unknown>>,
  ): void {
    const previous = this.snapshot(), retained = structuredClone(value)
    for (const key of new Set([...Object.keys(previous.baseline), ...Object.keys(previous.value)])) {
      const changedSinceSubmit = submitted !== undefined
        && JSON.stringify(previous.value[key]) !== JSON.stringify(submitted[key])
      if (
        fields.includes(key)
          ? !changedSinceSubmit
          : JSON.stringify(previous.value[key]) === JSON.stringify(previous.baseline[key])
      ) continue
      if (previous.value[key] === undefined) delete retained[key]
      else retained[key] = structuredClone(previous.value[key])
    }
    this.update({
      value: retained,
      baseline: structuredClone(value),
      revision,
      conflict: false,
      formRevision: previous.formRevision + 1,
    })
  }
  refresh(value: Record<string, unknown>, revision: number): void {
    const previous = this.snapshot(), retained = structuredClone(value)
    for (const key of new Set([...Object.keys(previous.baseline), ...Object.keys(previous.value)])) {
      if (JSON.stringify(previous.value[key]) === JSON.stringify(previous.baseline[key])) continue
      if (previous.value[key] === undefined) delete retained[key]
      else retained[key] = structuredClone(previous.value[key])
    }
    this.update({ ...previous, value: retained, baseline: structuredClone(value), revision, conflict: false })
  }
  markConflict(): void {
    this.update({ ...this.snapshot(), conflict: true })
  }
  reset(): void {
    const previous = this.snapshot()
    this.update({ ...previous, value: structuredClone(previous.baseline), formRevision: previous.formRevision + 1 })
  }
  resetFields(fields: readonly string[]): void {
    const previous = this.snapshot(), value: Record<string, unknown> = structuredClone(previous.value)
    for (const key of fields) {
      if (previous.baseline[key] === undefined) delete value[key]
      else value[key] = structuredClone(previous.baseline[key])
    }
    this.update({ ...previous, value, formRevision: previous.formRevision + 1 })
  }
}
