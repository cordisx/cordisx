/** Persisted labels are presentation hints only; never use them for routing or authorization. */
export interface NativeSessionDisplay {
  readonly providerId: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly serviceTier: 'priority' | null
  readonly updatedAt: number
}

export const nativeSessionDisplayPrefix = 'cordisx.session-display.v1:'
const valid = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0
  && value.length <= 512 && !/[\0\r\n]/u.test(value)

export class NativeSessionDisplayCache {
  constructor(private readonly storage: Storage | undefined, private readonly now: () => number = Date.now) {}

  private key(hostId: string, threadId: string): string {
    return nativeSessionDisplayPrefix + JSON.stringify([hostId, threadId])
  }

  read(hostId: string, threadId: string): NativeSessionDisplay | undefined {
    if (!valid(hostId) || !valid(threadId)) return undefined
    try {
      const value: unknown = JSON.parse(this.storage?.getItem(this.key(hostId, threadId)) ?? 'null')
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
      const item = value as Record<string, unknown>
      if (
        !valid(item.providerId) || !valid(item.model)
        || (item.reasoningEffort !== undefined && !valid(item.reasoningEffort))
        || (item.serviceTier !== null && item.serviceTier !== 'priority')
        || typeof item.updatedAt !== 'number' || !Number.isFinite(item.updatedAt)
      ) return undefined
      return {
        providerId: item.providerId,
        model: item.model,
        ...(item.reasoningEffort === undefined ? {} : { reasoningEffort: item.reasoningEffort as string }),
        serviceTier: item.serviceTier,
        updatedAt: item.updatedAt,
      }
    } catch {
      return undefined
    }
  }

  readSelection(hostId: string, state: import('./native-model-provider-state.js').SelectionSnapshot) {
    if (!state.threadId || state.available && state.reasoningEffort !== undefined && state.serviceTier !== undefined) {
      return undefined
    }
    return this.read(hostId, state.threadId)
  }

  /** Store only a fully observed tuple from an unlocked, bound selection. */
  writeSelection(
    hostId: string,
    state: import('./native-model-provider-state.js').SelectionSnapshot,
    locked: boolean,
  ): void {
    if (
      locked || !state.available || !state.threadId || !state.modelProvider || !state.model
      || state.reasoningEffort === undefined || state.serviceTier === undefined
    ) return
    this.write(hostId, state.threadId, {
      providerId: state.modelProvider,
      model: state.model,
      reasoningEffort: state.reasoningEffort,
      serviceTier: state.serviceTier,
    })
  }

  write(hostId: string, threadId: string, display: Omit<NativeSessionDisplay, 'updatedAt'>): void {
    if (
      !valid(hostId) || !valid(threadId) || !valid(display.providerId) || !valid(display.model)
      || (display.reasoningEffort !== undefined && !valid(display.reasoningEffort))
    ) return
    const old = this.read(hostId, threadId)
    if (
      old && old.providerId === display.providerId && old.model === display.model
      && old.reasoningEffort === display.reasoningEffort && old.serviceTier === display.serviceTier
    ) return
    try {
      this.storage?.setItem(this.key(hostId, threadId), JSON.stringify({ ...display, updatedAt: this.now() }))
    } catch {
      // Storage is optional, including in restricted native profiles.
    }
  }
}
