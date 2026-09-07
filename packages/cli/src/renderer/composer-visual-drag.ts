import type {
  ExtensionPointDragHandleV1,
  ExtensionPointDragRegionV1,
  ExtensionPointDragSnapshotV1,
} from '@cordisx/protocol/extension-point-drag/v1'

/** Host-owned interaction sibling: plugin artwork remains inert. */
export class ComposerVisualDrag {
  readonly handle: ExtensionPointDragHandleV1
  private readonly button: HTMLButtonElement
  private readonly listeners = new Set<() => void>()
  private snapshot: ExtensionPointDragSnapshotV1 = Object.freeze({
    sequence: 0,
    gesture: 0,
    phase: 'idle',
    deltaX: 0,
    deltaY: 0,
  })
  private region: ExtensionPointDragRegionV1 | null = null
  private active: { id: number; x: number; y: number; moved: boolean; drag: boolean } | undefined
  private disposed = false
  constructor(
    private readonly parent: HTMLElement,
    private readonly bounds: () => { width: number; height: number },
    private readonly authority: { drag(): boolean; activate(): boolean },
  ) {
    this.button = parent.ownerDocument.createElement('button')
    this.button.type = 'button'
    this.button.dataset.cordisxComposerDrag = ''
    this.button.style.cssText =
      'position:absolute;display:none;padding:0;border:0;background:transparent;touch-action:none;cursor:grab;z-index:1;'
    this.button.addEventListener('pointerdown', this.down)
    this.button.addEventListener('pointermove', this.move)
    this.button.addEventListener('pointerup', this.up)
    this.button.addEventListener('pointercancel', this.cancel)
    this.button.addEventListener('lostpointercapture', this.cancel)
    this.button.addEventListener('keydown', this.key)
    this.button.addEventListener('blur', this.restoreFocusOutline)
    this.button.addEventListener('click', this.click)
    parent.ownerDocument.defaultView?.addEventListener('blur', this.cancel)
    parent.append(this.button)
    this.handle = Object.freeze({
      getSnapshot: () => this.snapshot,
      subscribe: (listener: () => void) => {
        if (this.disposed) return () => {}
        this.listeners.add(listener)
        return () => {
          this.listeners.delete(listener)
        }
      },
      setRegion: (region: ExtensionPointDragRegionV1 | null) => {
        if (this.disposed) return
        this.region = region === null ? null : { ...region }
        this.refresh()
      },
    })
  }
  private permitted(): boolean {
    return !this.disposed && (this.authority.drag() || this.authority.activate())
  }
  refresh(): void {
    if (this.disposed) return
    if (this.active?.drag && !this.authority.drag()) this.cancel()
    const r = this.region, b = this.bounds()
    if (
      !this.permitted() || r === null || ![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width <= 0
      || r.height <= 0 || typeof r.label !== 'string' || !r.label.trim()
    ) {
      this.cancel()
      this.button.style.display = 'none'
      return
    }
    const x = Math.max(0, r.x), y = Math.max(0, r.y)
    const width = Math.max(0, Math.min(b.width, r.x + r.width) - x)
    const height = Math.max(0, Math.min(b.height, r.y + r.height) - y)
    this.button.style.display = width && height ? 'block' : 'none'
    this.button.style.left = `${x}px`
    this.button.style.bottom = `calc(100% + ${b.height - y - height}px)`
    this.button.style.width = `${width}px`
    this.button.style.height = `${height}px`
    this.button.setAttribute('aria-label', r.label.slice(0, 200))
    this.button.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight ArrowUp ArrowDown Enter Space')
    if (!width || !height) this.cancel()
  }
  private emit(phase: ExtensionPointDragSnapshotV1['phase'], x = this.snapshot.deltaX, y = this.snapshot.deltaY): void {
    this.snapshot = Object.freeze({
      sequence: this.snapshot.sequence + 1,
      gesture: this.snapshot.gesture + (phase === 'start' ? 1 : 0),
      phase,
      deltaX: x,
      deltaY: y,
    })
    for (const listener of this.listeners) listener()
  }
  private down = (event: PointerEvent): void => {
    if (!this.permitted() || this.active || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    this.active = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, drag: this.authority.drag() }
    try {
      this.button.setPointerCapture(event.pointerId)
    } catch {
      /* Unsupported capture cancels rather than leaking a gesture. */ this.active = undefined
      return
    }
    this.button.style.outline = 'none'
    this.button.focus({ preventScroll: true })
    this.emit('start', 0, 0)
  }
  private move = (event: PointerEvent): void => {
    if (event.pointerId !== this.active?.id) return
    if (!this.permitted() || (this.active.drag && !this.authority.drag())) {
      this.cancel()
      return
    }
    const x = event.clientX - this.active.x, y = event.clientY - this.active.y
    this.active.moved ||= Math.hypot(x, y) >= 4
    event.preventDefault()
    event.stopPropagation()
    if (this.active.moved && this.authority.drag()) this.emit('move', x, y)
  }
  private up = (event: PointerEvent): void => {
    if (event.pointerId !== this.active?.id) return
    if (!this.permitted() || (this.active.drag && !this.authority.drag())) {
      this.cancel()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const x = event.clientX - this.active.x, y = event.clientY - this.active.y
    const moved = this.active.moved || Math.hypot(x, y) >= 4
    const activate = !moved && this.authority.activate()
    this.finish(
      activate ? 'activate' : 'end',
      moved && this.authority.drag() ? x : 0,
      moved && this.authority.drag() ? y : 0,
    )
  }
  private finish(phase: 'end' | 'cancel' | 'activate', x?: number, y?: number): void {
    const active = this.active
    this.active = undefined
    if (active) {
      this.emit(phase, x, y)
      try {
        if (this.button.hasPointerCapture(active.id)) this.button.releasePointerCapture(active.id)
      } catch { /* The native target may already be detached. */ }
    }
  }
  private cancel = (): void => {
    this.finish('cancel')
  }
  private click = (event: MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    // Pointer clicks were handled by pointerup; keyboard defaults are prevented below.
    // Detail zero preserves the semantic click used by assistive technology.
    if (event.detail !== 0 || this.active || !this.permitted() || !this.authority.activate()) return
    this.emit('start', 0, 0)
    if (this.permitted() && this.authority.activate()) this.emit('activate', 0, 0)
  }
  private restoreFocusOutline = (): void => {
    this.button.style.removeProperty('outline')
  }
  private key = (event: KeyboardEvent): void => {
    this.restoreFocusOutline()
    if (!this.permitted()) {
      this.cancel()
      return
    }
    if (event.key === 'Escape' && this.active) {
      event.preventDefault()
      event.stopPropagation()
      this.cancel()
      return
    }
    if (this.active || event.repeat) return
    if ((event.key === 'Enter' || event.key === ' ') && this.authority.activate()) {
      event.preventDefault()
      event.stopPropagation()
      this.emit('start', 0, 0)
      if (this.permitted() && this.authority.activate()) this.emit('activate', 0, 0)
      return
    }
    const movement: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }
    const delta = movement[event.key]
    if (!delta || !this.authority.drag()) return
    event.preventDefault()
    event.stopPropagation()
    const step = event.shiftKey ? 32 : 8
    this.emit('start', 0, 0)
    if (this.permitted() && this.authority.drag()) this.emit('end', delta[0] * step, delta[1] * step)
  }
  dispose(): void {
    if (this.disposed) return
    this.cancel()
    this.disposed = true
    this.parent.ownerDocument.defaultView?.removeEventListener('blur', this.cancel)
    this.button.remove()
    this.listeners.clear()
  }
}
