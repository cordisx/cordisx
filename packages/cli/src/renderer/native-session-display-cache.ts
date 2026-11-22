import { isModelReasoningEffort } from '../model-reasoning-capabilities.js'

/** Persisted labels are presentation hints only; never use them for routing or authorization. */
export interface NativeSessionDisplay {
  readonly providerId: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly serviceTier?: 'priority' | null
  readonly updatedAt: number
}

export const nativeSessionDisplayPrefix = 'cordisx.session-display.v1:'
const valid = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0
  && value.length <= 512 && !/[\0\r\n]/u.test(value)

export class NativeSessionDisplayCache {
  constructor(private readonly storage: Storage | undefined, private readonly now: () => number = Date.now) {}

  private key(hostId: string, threadId: string | undefined): string {
    return nativeSessionDisplayPrefix + JSON.stringify([hostId, threadId ?? null])
  }

  read(hostId: string, threadId: string | undefined): NativeSessionDisplay | undefined {
    if (!valid(hostId) || threadId !== undefined && !valid(threadId)) return undefined
    try {
      const value: unknown = JSON.parse(this.storage?.getItem(this.key(hostId, threadId)) ?? 'null')
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
      const item = value as Record<string, unknown>
      if (
        !valid(item.providerId) || !valid(item.model)
        || (item.reasoningEffort !== undefined && !isModelReasoningEffort(item.reasoningEffort))
        || (item.serviceTier !== undefined && item.serviceTier !== null && item.serviceTier !== 'priority')
        || typeof item.updatedAt !== 'number' || !Number.isFinite(item.updatedAt)
      ) return undefined
      return {
        providerId: item.providerId,
        model: item.model,
        ...(item.reasoningEffort === undefined ? {} : { reasoningEffort: item.reasoningEffort as string }),
        ...(item.serviceTier === undefined ? {} : { serviceTier: item.serviceTier as 'priority' | null }),
        updatedAt: item.updatedAt,
      }
    } catch {
      return undefined
    }
  }

  readSelection(hostId: string, state: import('./native-model-provider-state.js').SelectionSnapshot) {
    if (
      state.available && isModelReasoningEffort(state.reasoningEffort) && state.serviceTier !== undefined
    ) {
      return undefined
    }
    return this.read(hostId, state.threadId)
  }

  projectSelection(
    hostId: string,
    state: import('./native-model-provider-state.js').SelectionSnapshot,
    locked: boolean,
  ) {
    const display = this.readSelection(hostId, state)
    this.writeSelection(hostId, state, locked)
    return display
  }

  /** Store confirmed labels independently of optional effort/Fast metadata. */
  writeSelection(
    hostId: string,
    state: import('./native-model-provider-state.js').SelectionSnapshot,
    locked: boolean,
  ): void {
    if (
      locked || !state.available || !state.modelProvider || !state.model
    ) return
    const previous = this.read(hostId, state.threadId)
    const sameTuple = previous?.providerId === state.modelProvider && previous.model === state.model
    this.write(hostId, state.threadId, {
      providerId: state.modelProvider,
      model: state.model,
      ...(isModelReasoningEffort(state.reasoningEffort)
        ? { reasoningEffort: state.reasoningEffort }
        : sameTuple && previous.reasoningEffort !== undefined
        ? { reasoningEffort: previous.reasoningEffort }
        : {}),
      ...(state.serviceTier !== undefined
        ? { serviceTier: state.serviceTier }
        : sameTuple && previous.serviceTier !== undefined
        ? { serviceTier: previous.serviceTier }
        : {}),
    })
  }

  write(hostId: string, threadId: string | undefined, display: Omit<NativeSessionDisplay, 'updatedAt'>): void {
    if (
      !valid(hostId) || threadId !== undefined && !valid(threadId) || !valid(display.providerId)
      || !valid(display.model)
      || (display.reasoningEffort !== undefined && !isModelReasoningEffort(display.reasoningEffort))
      || (display.serviceTier !== undefined && display.serviceTier !== null && display.serviceTier !== 'priority')
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
