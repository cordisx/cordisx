import { isRetainedInactiveNativePage } from '../host-probes.js'
import { nativeRouteIdentity, type NativeRouteSource } from './native-route-transition.js'

interface PageIdentity {
  readonly route: string | undefined
  readonly rail: HTMLElement
  readonly main: HTMLElement
}

interface PaneSeat {
  readonly rail: HTMLElement
  readonly main: { readonly anchor: HTMLElement }
}

/** Retain one established Manager page through a bounded native split transition. */
export class ManagerPaneRecapture {
  private pending: (PageIdentity & { readonly deadline: number }) | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(
    private readonly source: NativeRouteSource | undefined,
    private readonly schedule: () => void,
  ) {}

  canRetain(identity: PageIdentity, seat: PaneSeat | undefined): boolean {
    return !this.disposed && identity.route !== undefined && this.source !== undefined
      && nativeRouteIdentity(this.source.snapshot()) === identity.route
      && identity.rail.isConnected && identity.main.isConnected
      && !isRetainedInactiveNativePage(identity.rail) && !isRetainedInactiveNativePage(identity.main)
      && (seat === undefined || (seat.rail === identity.rail && seat.main.anchor === identity.main))
  }

  start(identity: PageIdentity): void {
    this.cancel()
    if (this.disposed) return
    this.pending = { ...identity, deadline: Date.now() + 1000 }
    this.retry()
  }

  resume(seat: PaneSeat | undefined, activate: () => boolean): 'idle' | 'waiting' | 'restored' | 'lost' {
    const pending = this.pending
    if (pending === undefined) return 'idle'
    if (!this.canRetain(pending, seat) || Date.now() >= pending.deadline) {
      this.cancel()
      return 'lost'
    }
    if (seat !== undefined && activate()) {
      this.cancel()
      return 'restored'
    }
    // Activation restores the previous native lease before trying to re-enter;
    // that cleanup may cancel us even when the new lease is not ready yet.
    this.pending = pending
    this.retry()
    return 'waiting'
  }

  cancel(): void {
    this.pending = undefined
    clearTimeout(this.timer)
    this.timer = undefined
  }

  dispose(): void {
    this.disposed = true
    this.cancel()
  }

  private retry(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.disposed && this.pending !== undefined) this.schedule()
    }, 25)
  }
}
