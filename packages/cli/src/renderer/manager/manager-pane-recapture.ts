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

/** Retain one established page through a native split transition while it can paint. */
export class ManagerPaneRecapture {
  private pending: (PageIdentity & { readonly deadline: number }) | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private frame: number | undefined
  private waitingDocument: Document | undefined
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
    if (!this.canRetain(pending, seat)) {
      this.cancel()
      return 'lost'
    }
    if (seat !== undefined && activate()) {
      this.cancel()
      return 'restored'
    }
    const document = pending.main.ownerDocument
    if (document.visibilityState === 'hidden' && typeof document.defaultView?.requestAnimationFrame === 'function') {
      // Native offscreen renderers commit DOM before updating their painted
      // geometry. Wall-clock expiry cannot prove that the same page was lost.
      this.pending = { ...pending, deadline: Date.now() + 1000 }
      this.retry()
      return 'waiting'
    }
    // A background native renderer may deliver its first retry after the
    // deadline. Reclaim an already valid same-page seat before timing out.
    if (Date.now() >= pending.deadline) {
      this.cancel()
      return 'lost'
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
    if (this.frame !== undefined) this.waitingDocument?.defaultView?.cancelAnimationFrame(this.frame)
    this.frame = undefined
    this.waitingDocument?.removeEventListener('visibilitychange', this.onVisibilityChange)
    this.waitingDocument = undefined
  }

  dispose(): void {
    this.disposed = true
    this.cancel()
  }

  private retry(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    const document = this.pending?.main.ownerDocument
    if (document?.visibilityState === 'hidden' && typeof document.defaultView?.requestAnimationFrame === 'function') {
      if (this.waitingDocument === undefined) {
        this.waitingDocument = document
        document.addEventListener('visibilitychange', this.onVisibilityChange)
      }
      this.frame ??= document.defaultView.requestAnimationFrame(() => {
        this.frame = undefined
        if (!this.disposed && this.pending !== undefined) this.schedule()
      })
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.disposed && this.pending !== undefined) this.schedule()
    }, 25)
  }

  private readonly onVisibilityChange = () => {
    if (this.disposed || this.pending === undefined || this.waitingDocument?.visibilityState !== 'visible') return
    this.pending = { ...this.pending, deadline: Date.now() + 1000 }
    this.schedule()
  }
}
