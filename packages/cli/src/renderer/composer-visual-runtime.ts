import { ComposerVisualInteractions } from './composer-visual-interactions.js'
import type { ExtensionPointInteractionsV2 } from '@cordisx/protocol/extension-point-interactions/v2'
import { ComposerVisualDrag } from './composer-visual-drag.js'
import type { ExtensionPointDragHandleV1 } from '@cordisx/protocol/extension-point-drag/v1'
import type { ExtensionPointVisualSnapshotV2 } from '@cordisx/protocol/extension-point-visual/v2'
import * as React from 'react'
import { resolveHostTheme } from './host-theme.js'
import { createRoot, type Root } from 'react-dom/client'
import type { CordisXReactVisual, CordisXVisualRegistration } from '../extension-point-visual-contracts.js'
import type {
  ExtensionPointVisualIdV1,
  ExtensionPointVisualSnapshotV1,
} from '@cordisx/protocol/extension-point-visual/v1'
import { type NativeComposerVisualSeat, probeComposerVisual } from './adapter/composer-visual-probe.js'

export interface ComposerVisualAuthority {
  /** Must include current point policy, exact manifest grant, and generation visibility. */
  mounted?(): () => void
  render(): boolean
  observePointer(): boolean
  drag?(): boolean
  activate?(): boolean
  subscribe(listener: () => void): () => void
}
type VisualSnapshot = ExtensionPointVisualSnapshotV1 | ExtensionPointVisualSnapshotV2

interface Registration {
  readonly key: string
  readonly declaration: CordisXVisualRegistration
  readonly load: () => Promise<CordisXReactVisual>
  readonly authority: ComposerVisualAuthority
  readonly releaseAuthority: () => void
  retired: boolean
  failed: boolean
  epoch: number
  loaded?: CordisXReactVisual
  loading?: Promise<void>
}
interface Mounted {
  readonly registration: Registration
  readonly seat: NativeComposerVisualSeat
  readonly container: HTMLSpanElement
  readonly root: Root
  readonly releaseRendered: () => void
  readonly restore: () => void
  readonly source: VisualSource
  drag?: ComposerVisualDrag
  interactions?: ComposerVisualInteractions
}

class VisualSource {
  private readonly listeners = new Set<() => void>()
  constructor(private value: VisualSnapshot) {}
  getSnapshot = (): VisualSnapshot => this.value
  subscribe = (listener: () => void): () => void => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  update(value: VisualSnapshot): void {
    this.value = Object.freeze(value)
    for (const listener of this.listeners) listener()
  }
}
class VisualBoundary extends React.Component<{ children: React.ReactNode; failed: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  componentDidCatch(): void {
    this.props.failed()
  }
  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children
  }
}
function VisualBody(
  { source, visual, getDrag, getInteractions }: {
    source: VisualSource
    visual: CordisXReactVisual
    getDrag: () => ExtensionPointDragHandleV1 | undefined
    getInteractions: () => ExtensionPointInteractionsV2 | undefined
  },
): React.ReactElement {
  const state = React.useSyncExternalStore(source.subscribe, source.getSnapshot)
  const drag = getDrag()
  const interactions = getInteractions()
  return React.createElement(visual.component, {
    state,
    ...(drag === undefined ? {} : { drag }),
    ...(interactions === undefined ? {} : { interactions }),
  })
}
function positioned(parent: HTMLElement): () => void {
  if (parent.ownerDocument.defaultView?.getComputedStyle(parent).position !== 'static') return () => {}
  const previous = parent.style.getPropertyValue('position')
  const priority = parent.style.getPropertyPriority('position')
  parent.style.setProperty('position', 'relative')
  return () => {
    if (parent.style.getPropertyValue('position') !== 'relative') return
    if (previous === '') parent.style.removeProperty('position')
    else parent.style.setProperty('position', previous, priority)
  }
}

/** Host-private React mounts. Callbacks see semantic props only; no native node. */
export class ComposerVisualRuntime {
  private readonly registrations = new Map<string, Registration>()
  private readonly mounted = new Map<ExtensionPointVisualIdV1, Mounted>()
  private readonly observer: MutationObserver
  private readonly resize: ResizeObserver | undefined
  private readonly motion: MediaQueryList | undefined
  private frame: number | undefined
  private disposed = false
  private sequence = 0
  private pointer: { x: number; y: number } | undefined
  private readonly view: Window

  constructor(private readonly document: Document, private readonly contextChanged?: (available: boolean) => void) {
    const view = document.defaultView
    if (view === null) throw new Error('Composer visuals require a document window')
    this.view = view
    this.observer = new view.MutationObserver(records => {
      if (
        records.some(record =>
          (record.target instanceof view.Element ? record.target : record.target.parentElement)
            ?.closest('[data-cordisx-composer-visual], [data-cordisx-composer-drag]') == null
        )
      ) this.schedule()
    })
    this.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
    this.resize = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(() => this.schedule()) : undefined
    this.motion = view.matchMedia?.('(prefers-reduced-motion: reduce)')
    this.motion?.addEventListener('change', this.schedule)
    view.addEventListener('resize', this.schedule)
    document.addEventListener('scroll', this.schedule, true)
    document.addEventListener('input', this.schedule, true)
    document.addEventListener('pointermove', this.onPointer, { passive: true })
    document.addEventListener('pointerleave', this.onPointerLeave)
  }

  register(
    key: string,
    declaration: CordisXVisualRegistration,
    load: () => Promise<CordisXReactVisual>,
    authority: ComposerVisualAuthority,
  ): () => void {
    if (this.disposed || this.registrations.has(key)) {
      throw new Error('Visual owner generation is unavailable or duplicated')
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(declaration.id)) throw new Error('Invalid visual id')
    if (!['composer.primary-action.visual', 'composer.frame.overlay'].includes(declaration.pointId)) {
      throw new Error('Unknown visual point')
    }
    if (Object.keys(declaration).some(key => !['id', 'pointId', 'events', 'order', 'snapshotVersion'].includes(key))) {
      throw new Error('Unknown visual declaration field')
    }
    if (declaration.snapshotVersion !== undefined && ![1, 2].includes(declaration.snapshotVersion)) {
      throw new Error('Unsupported visual snapshot version')
    }
    if (
      declaration.events?.some(event =>
        event !== 'pointer.observe'
        && !(['drag', 'activate'].includes(event) && declaration.pointId === 'composer.frame.overlay')
      )
    ) {
      throw new Error('Requested visual interaction is unavailable')
    }
    const record: Registration = {
      key,
      declaration: Object.freeze({ ...declaration }),
      load,
      authority,
      releaseAuthority: authority.subscribe(() => {
        record.epoch++
        for (const [point, mount] of this.mounted) {
          if (mount.registration !== record) continue
          if (!authority.render()) this.unmount(point)
          else {
            this.syncDrag(mount)
            mount.source.update(this.snapshot(mount.seat, record))
          }
        }
        this.schedule()
      }),
      retired: false,
      failed: false,
      epoch: 0,
    }
    this.registrations.set(key, record)
    this.schedule()
    return () => {
      if (record.retired) return
      record.retired = true
      record.releaseAuthority()
      this.registrations.delete(key)
      for (const [point, mount] of this.mounted) if (mount.registration === record) this.unmount(point)
      this.schedule()
    }
  }

  private readonly onPointer = (event: PointerEvent): void => {
    this.pointer = { x: event.clientX, y: event.clientY }
    this.schedule()
  }
  private readonly onPointerLeave = (): void => {
    this.pointer = undefined
    this.schedule()
  }
  private readonly schedule = (): void => {
    if (this.disposed || this.frame !== undefined) return
    this.frame = this.view.requestAnimationFrame(() => {
      this.frame = undefined
      this.reconcile()
    })
  }

  private snapshot(seat: NativeComposerVisualSeat, record: Registration): VisualSnapshot {
    const anchorBounds = (record.declaration.pointId === 'composer.primary-action.visual' ? seat.button : seat.frame)
      .getBoundingClientRect()
    const bounds = record.declaration.pointId === 'composer.frame.overlay'
      ? {
        left: anchorBounds.left,
        top: anchorBounds.top - this.overlayHeight(seat, record),
        width: anchorBounds.width,
        height: this.overlayHeight(seat, record),
      }
      : anchorBounds
    const pointer = record.declaration.events?.includes('pointer.observe') && record.authority.observePointer()
      ? this.pointer
      : undefined
    const x = pointer === undefined ? 0 : (pointer.x - bounds.left) / bounds.width
    const y = pointer === undefined ? 0 : (pointer.y - bounds.top) / bounds.height
    return Object.freeze({
      ...(record.declaration.snapshotVersion === 2
        ? { schemaVersion: 2 as const, dictation: seat.dictation }
        : { schemaVersion: 1 as const }),
      sequence: ++this.sequence,
      action: seat.action,
      enabled: seat.enabled,
      busy: seat.busy,
      draftEmpty: seat.draftEmpty,
      accessibleLabel: seat.accessibleLabel,
      theme: resolveHostTheme(this.document).theme,
      reducedMotion: this.motion?.matches ?? false,
      bounds: Object.freeze({ width: bounds.width, height: bounds.height }),
      pointer: pointer === undefined
        ? null
        : Object.freeze({
          x: Math.max(0, Math.min(1, x)),
          y: Math.max(0, Math.min(1, y)),
          inside: x >= 0 && x <= 1 && y >= 0 && y <= 1,
        }),
      // No confirmed native submission receipt is available to this adapter yet.
      events: Object.freeze([]),
    })
  }

  private reconcile(): void {
    if (this.disposed) return
    const result = probeComposerVisual(this.document)
    this.contextChanged?.(result.status === 'available')
    for (const point of ['composer.primary-action.visual', 'composer.frame.overlay'] as const) {
      if (result.status !== 'available') {
        this.unmount(point)
        continue
      }
      const record = [...this.registrations.values()]
        .filter(record =>
          record.declaration.pointId === point && !record.retired && !record.failed && record.authority.render()
        )
        .sort((a, b) =>
          (a.declaration.order ?? 0) - (b.declaration.order ?? 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
        )[0]
      const previous = this.mounted.get(point)
      if (record === undefined) {
        this.unmount(point)
        continue
      }
      const seat = result.seat
      if (
        previous !== undefined && (previous.registration !== record || previous.seat.button !== seat.button
          || previous.seat.frame !== seat.frame || previous.seat.visual !== seat.visual
          || !previous.container.isConnected)
      ) this.unmount(point)
      if (record.loaded === undefined) {
        if (record.loading === undefined) {
          const epoch = record.epoch
          record.loading = Promise.resolve().then(() => {
            if (
              record.retired || !record.authority.render() || this.disposed
              || probeComposerVisual(this.document).status !== 'available'
            ) return
            return record.load()
          }).then(visual => {
            if (
              visual === undefined || record.retired || this.disposed || record.epoch !== epoch
              || !record.authority.render()
            ) return
            if (!['react-svg-v1', 'react-dom-v1'].includes(visual.kind) || typeof visual.component !== 'function') {
              throw new Error('Unsupported visual renderer')
            }
            record.loaded = visual
          }).catch(() => {
            record.failed = true
          }).finally(() => {
            delete record.loading
            this.schedule()
          })
        }
        continue
      }
      const existing = this.mounted.get(point)
      if (existing !== undefined) {
        this.syncDrag(existing)
        existing.source.update(this.snapshot(seat, record))
      } else this.mount(point, record, seat)
    }
  }

  private overlayHeight(seat: NativeComposerVisualSeat, record: Registration): number {
    return record.declaration.events?.includes('drag') && record.authority.drag?.()
      ? Math.max(0, seat.frame.getBoundingClientRect().top)
      : 128
  }

  private syncDrag(mount: Mounted): void {
    const record = mount.registration
    if (record.declaration.pointId !== 'composer.frame.overlay') return
    mount.container.style.height = `${this.overlayHeight(mount.seat, record)}px`
    const drag = () =>
      !record.retired && !this.disposed && record.authority.render()
      && Boolean(record.declaration.events?.includes('drag') && record.authority.drag?.())
    const activate = () =>
      !record.retired && !this.disposed && record.authority.render()
      && Boolean(record.declaration.events?.includes('activate') && record.authority.activate?.())
    if (!drag() && !activate()) {
      mount.drag?.dispose()
      delete mount.drag
      mount.interactions?.dispose()
      delete mount.interactions
      return
    }
    mount.drag ??= new ComposerVisualDrag(
      mount.seat.frame,
      () => ({ width: mount.seat.frame.getBoundingClientRect().width, height: this.overlayHeight(mount.seat, record) }),
      { drag, activate },
    )
    mount.drag.refresh()
    mount.interactions ??= new ComposerVisualInteractions(
      mount.seat.frame,
      () => ({ width: mount.seat.frame.getBoundingClientRect().width, height: this.overlayHeight(mount.seat, record) }),
      { drag, activate },
    )
    mount.interactions.refresh()
  }

  private mount(point: ExtensionPointVisualIdV1, record: Registration, seat: NativeComposerVisualSeat): void {
    const parent = point === 'composer.primary-action.visual' ? seat.button : seat.frame
    const container = this.document.createElement('span')
    container.dataset.cordisxComposerVisual = point
    container.setAttribute('aria-hidden', 'true')
    container.setAttribute('inert', '')
    container.style.cssText = point === 'composer.frame.overlay'
      ? 'position:absolute;left:0;right:0;bottom:100%;height:128px;display:block;pointer-events:none;overflow:hidden;'
      : 'position:absolute;inset:0;display:block;pointer-events:none;overflow:hidden;'
    const restorePosition = positioned(parent)
    const visualStyle = (seat.visual as SVGElement | HTMLElement).style
    const oldVisibility = visualStyle.getPropertyValue('visibility')
    const oldPriority = visualStyle.getPropertyPriority('visibility')
    const buttonStyle = seat.button.style
    const oldBackground = buttonStyle.getPropertyValue('background-color')
    const oldBackgroundPriority = buttonStyle.getPropertyPriority('background-color')
    if (point === 'composer.primary-action.visual') {
      visualStyle.setProperty('visibility', 'hidden')
      buttonStyle.setProperty('background-color', 'transparent')
    }
    parent.append(container)
    const root = createRoot(container)
    const source = new VisualSource(this.snapshot(seat, record))
    const restore = (): void => {
      if (point === 'composer.primary-action.visual' && visualStyle.getPropertyValue('visibility') === 'hidden') {
        if (oldVisibility === '') visualStyle.removeProperty('visibility')
        else visualStyle.setProperty('visibility', oldVisibility, oldPriority)
      }
      if (
        point === 'composer.primary-action.visual' && buttonStyle.getPropertyValue('background-color') === 'transparent'
      ) {
        if (oldBackground === '') buttonStyle.removeProperty('background-color')
        else buttonStyle.setProperty('background-color', oldBackground, oldBackgroundPriority)
      }
      restorePosition()
    }
    this.mounted.set(point, {
      registration: record,
      seat,
      container,
      root,
      source,
      restore,
      releaseRendered: record.authority.mounted?.() ?? (() => {}),
    })
    this.syncDrag(this.mounted.get(point)!)
    this.resize?.observe(parent)
    root.render(React.createElement(VisualBoundary, {
      failed: () => {
        record.failed = true
        queueMicrotask(() => {
          if (this.mounted.get(point)?.registration === record) this.unmount(point)
        })
        this.schedule()
      },
      children: React.createElement(VisualBody, {
        source,
        visual: record.loaded!,
        getDrag: () => this.mounted.get(point)?.drag?.handle,
        getInteractions: () => this.mounted.get(point)?.interactions?.handle,
      }),
    }))
  }

  private unmount(point: ExtensionPointVisualIdV1): void {
    const mount = this.mounted.get(point)
    if (mount === undefined) return
    this.mounted.delete(point)
    this.resize?.unobserve(point === 'composer.primary-action.visual' ? mount.seat.button : mount.seat.frame)
    mount.drag?.dispose()
    mount.interactions?.dispose()
    mount.root.unmount()
    mount.container.remove()
    mount.restore()
    mount.releaseRendered()
  }
  inspect(): Readonly<{ roots: number; registrations: number; disposed: boolean }> {
    return Object.freeze({ roots: this.mounted.size, registrations: this.registrations.size, disposed: this.disposed })
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.frame !== undefined) this.view.cancelAnimationFrame(this.frame)
    this.observer.disconnect()
    this.resize?.disconnect()
    this.motion?.removeEventListener('change', this.schedule)
    this.view.removeEventListener('resize', this.schedule)
    this.document.removeEventListener('scroll', this.schedule, true)
    this.document.removeEventListener('input', this.schedule, true)
    this.document.removeEventListener('pointermove', this.onPointer)
    this.document.removeEventListener('pointerleave', this.onPointerLeave)
    for (const record of this.registrations.values()) {
      record.retired = true
      record.releaseAuthority()
    }
    this.registrations.clear()
    for (const point of this.mounted.keys()) this.unmount(point)
  }
}
