import type { OutletController, OutletHostSnapshot, OutletPlacement } from '../navigation.js'
import type { OutletResolver, ResolvedOutletAnchor } from './types.js'
import { normalizedInsets } from './dom.js'

/** One host-owned overlay layer. Native anchors are observed and never mutated except by appending this layer. */
export class DomOutletController implements OutletController {
  private readonly listeners = new Set<() => void>()
  private readonly observer?: MutationObserver
  private resizeObserver: ResizeObserver | undefined
  private resizeAnchor: HTMLElement | undefined
  private readonly layer: HTMLElement
  private snapshot: OutletHostSnapshot
  private scheduled = false
  private shown = false
  private disposed = false
  private anchor: HTMLElement | undefined

  constructor(
    private readonly document: Document,
    private readonly outletId: string,
    private readonly preferredPlacement: OutletPlacement,
    private readonly resolver: OutletResolver,
  ) {
    this.layer = document.createElement('section')
    this.layer.dataset.cordisxPageOutlet = outletId
    this.layer.hidden = true
    Object.assign(this.layer.style, {
      boxSizing: 'border-box',
      overflow: 'auto',
      // Mounted pages opt back into hit testing. This lets a standard page clip
      // its titlebar safe area so native window controls remain reachable.
      pointerEvents: 'none',
      zIndex: '2147483200',
    })
    this.snapshot = Object.freeze({
      available: false,
      placement: preferredPlacement,
      error: 'semantic anchor is unavailable',
    })
    const Observer = document.defaultView?.MutationObserver
    if (Observer !== undefined) {
      this.observer = new Observer((records) => {
        const nativeMutation = records.some((record) => {
          const target = record.target.nodeType === 1
            ? record.target as Element
            : record.target.parentElement
          return target?.closest(
            '[data-cordisx-surface-host], [data-cordisx-page-outlet], [data-cordisx-manager-modal]',
          ) === null
        })
        if (nativeMutation) this.schedule()
      })
      this.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true })
    }
    document.defaultView?.addEventListener('resize', this.schedule)
    document.defaultView?.addEventListener('scroll', this.schedule, true)
    this.reconcile()
  }

  getSnapshot(): OutletHostSnapshot {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  show(): void {
    this.shown = true
    this.layer.hidden = false
    this.reconcile()
  }

  hide(): void {
    this.shown = false
    this.layer.hidden = true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.observer?.disconnect()
    this.clearGeometryObserver()
    this.document.defaultView?.removeEventListener('resize', this.schedule)
    this.document.defaultView?.removeEventListener('scroll', this.schedule, true)
    this.layer.remove()
    this.listeners.clear()
  }

  private readonly schedule = (): void => {
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.reconcile()
    })
  }

  private reconcile(): void {
    if (this.disposed) return
    const resolved = this.resolver()
    if (resolved === undefined || !resolved.anchor.isConnected) {
      this.anchor = undefined
      this.clearGeometryObserver()
      this.layer.remove()
      this.updateSnapshot({
        available: false,
        placement: this.preferredPlacement,
        error: 'semantic anchor is unavailable',
      })
      return
    }
    this.anchor = resolved.anchor
    this.layer.style.setProperty(
      '--cordisx-page-chrome-safe-left',
      `${Math.max(0, resolved.pageChromeSafeLeft ?? 0)}px`,
    )
    const isApp = this.outletId === 'app'
    const hostPosition = this.document.defaultView?.getComputedStyle(resolved.anchor).position
    const positioned = isApp || (hostPosition !== undefined && hostPosition !== '' && hostPosition !== 'static')
    const placement: OutletPlacement = isApp
      ? 'fixed'
      : this.preferredPlacement === 'portal'
      ? 'portal'
      : positioned
      ? 'absolute'
      : 'portal'
    if (placement === 'portal') {
      if (this.layer.parentElement !== this.document.body) this.document.body.append(this.layer)
      this.installGeometryObserver(resolved.anchor)
      this.projectGeometry(resolved)
    } else {
      this.clearGeometryObserver()
      if (this.layer.parentElement !== resolved.anchor) resolved.anchor.append(this.layer)
      const insets = normalizedInsets(resolved)
      Object.assign(this.layer.style, {
        position: isApp ? 'fixed' : 'absolute',
        inset: 'auto',
        left: `${insets.left}px`,
        top: `${insets.top}px`,
        right: `${insets.right}px`,
        bottom: `${insets.bottom}px`,
        width: '',
        height: '',
      })
    }
    if (this.layer.hidden === this.shown) this.layer.hidden = !this.shown
    this.updateSnapshot(Object.freeze({
      available: true,
      contextKey: resolved.contextKey,
      container: this.layer,
      placement,
      ...(resolved.nativeSessionId === undefined ? {} : { nativeSessionId: resolved.nativeSessionId }),
    }))
  }

  private installGeometryObserver(anchor: HTMLElement): void {
    if (this.resizeObserver !== undefined && this.resizeAnchor === anchor) return
    this.clearGeometryObserver()
    const Observer = this.document.defaultView?.ResizeObserver
    if (Observer === undefined) return
    this.resizeAnchor = anchor
    this.resizeObserver = new Observer(() => this.reconcile())
    this.resizeObserver.observe(anchor)
  }

  private clearGeometryObserver(): void {
    this.resizeObserver?.disconnect()
    this.resizeObserver = undefined
    this.resizeAnchor = undefined
  }

  private projectGeometry(resolved: ResolvedOutletAnchor): void {
    const rect = resolved.anchor.getBoundingClientRect()
    const insets = normalizedInsets(resolved)
    Object.assign(this.layer.style, {
      position: 'fixed',
      inset: 'auto',
      left: `${rect.left + insets.left}px`,
      top: `${rect.top + insets.top}px`,
      width: `${Math.max(0, rect.width - insets.left - insets.right)}px`,
      height: `${Math.max(0, rect.height - insets.top - insets.bottom)}px`,
    })
  }

  private updateSnapshot(next: OutletHostSnapshot): void {
    const previous = this.snapshot
    const same = previous.available === next.available
      && previous.contextKey === next.contextKey
      && previous.container === next.container
      && previous.placement === next.placement
      && previous.nativeSessionId === next.nativeSessionId
      && previous.error === next.error
    if (same) return
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}
