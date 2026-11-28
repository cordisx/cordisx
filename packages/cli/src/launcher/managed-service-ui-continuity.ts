import { isDeepStrictEqual } from 'node:util'
import type { ManagedServiceUICapabilityMutation } from './plugin-lifecycle-model.js'
import type { ManagedServiceNodeActivation } from './managed-service-node-host.js'
import {
  type ManagedServiceUISourceSnapshot,
  observeManagedServiceUISources,
  sameManagedServiceUISources,
} from './managed-service-ui-fence-sources.js'

/** This capture stays inside the owner; it contains private service references and tokens. */
export interface ManagedServiceUIContinuityCapture {
  readonly fence: number
  readonly sources: readonly ManagedServiceUISourceSnapshot[]
  readonly capabilities: readonly ManagedServiceUICapabilityMutation[]
  readonly activations: readonly ManagedServiceNodeActivation[]
}

/** Internal durable recovery evidence for the same owner UI fence. */
export interface ManagedServiceUIRecovery {
  readonly stamp: number
  readonly registryEpoch: number
  readonly profileId: string
  readonly runtimeGeneration: string
  readonly plugins: string
}

type Captured = ManagedServiceUIContinuityCapture & { readonly routeRevision: number }

function sameInputs(first: Captured, second: Captured): boolean {
  return sameManagedServiceUISources(first.sources, second.sources)
    && isDeepStrictEqual(first.capabilities, second.capabilities)
    && first.routeRevision === second.routeRevision
}

/**
 * Proves that a settled owner transaction retained the exact service sources
 * and capabilities, including during the interval where the ordinary fleet
 * observer is replaced. It does not suspend Manager calls or authorize any
 * mutation; a caller must independently drain affected reads and writes and
 * fence or park subscription results before using the resulting fence.
 */
export class ManagedServiceUIContinuity {
  private reservation: symbol | undefined
  private disposeReservation: (() => boolean) | undefined
  private closed = false
  private routeRevision = 0

  constructor(
    private readonly input: {
      readonly capture: () => ManagedServiceUIContinuityCapture | undefined
      /** A failed observer cleanup makes the owner fence unavailable. */
      readonly cleanupFailed: () => void
    },
  ) {}

  /** The owner calls this synchronously before changing its active route map. */
  observeRoutes(
    previous: ReadonlyMap<string, object> | undefined,
    next: ReadonlyMap<string, object> | undefined,
  ): void {
    if (this.closed) return
    const left = previous ?? new Map<string, object>()
    const right = next ?? new Map<string, object>()
    if (left.size === right.size && [...left].every(([key, value]) => right.get(key) === value)) return
    if (this.routeRevision >= Number.MAX_SAFE_INTEGER) {
      try {
        this.input.cleanupFailed()
      } finally {
        this.dispose()
      }
      return
    }
    this.routeRevision++
  }

  private capture(): Captured | undefined {
    if (this.closed) return undefined
    try {
      const value = this.input.capture()
      if (
        !value || !Number.isSafeInteger(value.fence) || value.fence < 0 || value.sources.length > 4_096
        || value.capabilities.length > 256 || value.activations.length > 256
        || new Set(value.activations).size !== value.activations.length
      ) return undefined
      return {
        fence: value.fence,
        sources: value.sources.map(source => ({ ...source })),
        capabilities: value.capabilities.map(capability => ({ ...capability })),
        activations: [...value.activations],
        routeRevision: this.routeRevision,
      }
    } catch {
      return undefined
    }
  }

  reserve(): { finish(): number | undefined; cancel(): boolean } {
    if (this.closed || this.reservation) throw new Error('managed-service-continuity-unavailable')
    const token = Symbol('managed-service-ui-continuity')
    this.reservation = token
    const before = this.capture()
    if (!before || this.closed || this.reservation !== token) {
      if (this.reservation === token) this.reservation = undefined
      throw new Error('managed-service-continuity-unavailable')
    }
    let changed = false
    const observation = observeManagedServiceUISources(before.activations, () => changed = true)
    let stopped = false
    const stop = (): boolean => {
      if (stopped) return false
      stopped = true
      try {
        observation.stop()
        return true
      } catch {
        try {
          this.input.cleanupFailed()
        } catch { /* Cleanup failure remains a failed reservation. */ }
        return false
      }
    }
    const again = this.capture()
    if (
      this.closed || this.reservation !== token || !observation.available || changed || !again
      || again.fence !== before.fence || !sameInputs(before, again)
    ) {
      stop()
      if (this.reservation === token) this.reservation = undefined
      throw new Error('managed-service-continuity-unavailable')
    }
    const close = (): boolean => {
      if (this.reservation !== token) return false
      const result = stop()
      if (this.reservation === token) this.reservation = undefined
      this.disposeReservation = undefined
      return result
    }
    this.disposeReservation = close
    return {
      finish: () => {
        if (this.closed || this.reservation !== token) return undefined
        const after = this.capture()
        const retained = !changed && after !== undefined && after.fence > before.fence && sameInputs(before, after)
        const released = stop()
        const verified = released ? this.capture() : undefined
        const current = !this.closed && this.reservation === token
        if (current) this.reservation = undefined
        this.disposeReservation = undefined
        return current && retained && !changed && verified && verified.fence === after!.fence
            && sameInputs(after!, verified)
          ? verified.fence
          : undefined
      },
      cancel: close,
    }
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.disposeReservation?.()
  }
}
