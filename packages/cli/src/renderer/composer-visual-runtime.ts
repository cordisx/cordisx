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
  subscribe(listener: () => void): () => void
}
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
}

class VisualSource {
  private readonly listeners = new Set<() => void>()
  constructor(private value: ExtensionPointVisualSnapshotV1) {}
  getSnapshot = (): ExtensionPointVisualSnapshotV1 => this.value
  subscribe = (listener: () => void): () => void => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  update(value: ExtensionPointVisualSnapshotV1): void {
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
function VisualBody({ source, visual }: { source: VisualSource; visual: CordisXReactVisual }): React.ReactElement {
  const state = React.useSyncExternalStore(source.subscribe, source.getSnapshot)
  return React.createElement(visual.component, { state })
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
            ?.closest('[data-cordisx-composer-visual]') == null
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
    if (Object.keys(declaration).some(key => !['id', 'pointId', 'events', 'order'].includes(key))) {
      throw new Error('Unknown visual declaration field')
    }
    if (declaration.events?.some(event => event !== 'pointer.observe')) {
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
          else mount.source.update(this.snapshot(mount.seat, record))
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

  private snapshot(seat: NativeComposerVisualSeat, record: Registration): ExtensionPointVisualSnapshotV1 {
    const bounds = (record.declaration.pointId === 'composer.primary-action.visual' ? seat.button : seat.frame)
      .getBoundingClientRect()
    const pointer = record.declaration.events?.includes('pointer.observe') && record.authority.observePointer()
      ? this.pointer
      : undefined
    const x = pointer === undefined ? 0 : (pointer.x - bounds.left) / bounds.width
    const y = pointer === undefined ? 0 : (pointer.y - bounds.top) / bounds.height
    return Object.freeze({
      schemaVersion: 1,
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
            if (visual.kind !== 'react-svg-v1' || typeof visual.component !== 'function') {
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
      if (existing !== undefined) existing.source.update(this.snapshot(seat, record))
      else this.mount(point, record, seat)
    }
  }

  private mount(point: ExtensionPointVisualIdV1, record: Registration, seat: NativeComposerVisualSeat): void {
    const parent = point === 'composer.primary-action.visual' ? seat.button : seat.frame
    const container = this.document.createElement('span')
    container.dataset.cordisxComposerVisual = point
    container.setAttribute('aria-hidden', 'true')
    container.setAttribute('inert', '')
    container.style.cssText = 'position:absolute;inset:0;display:block;pointer-events:none;overflow:hidden;'
    const restorePosition = positioned(parent)
    const visualStyle = (seat.visual as SVGElement | HTMLElement).style
    const oldVisibility = visualStyle.getPropertyValue('visibility')
    const oldPriority = visualStyle.getPropertyPriority('visibility')
    if (point === 'composer.primary-action.visual') visualStyle.setProperty('visibility', 'hidden')
    parent.append(container)
    const root = createRoot(container)
    const source = new VisualSource(this.snapshot(seat, record))
    const restore = (): void => {
      if (point === 'composer.primary-action.visual' && visualStyle.getPropertyValue('visibility') === 'hidden') {
        if (oldVisibility === '') visualStyle.removeProperty('visibility')
        else visualStyle.setProperty('visibility', oldVisibility, oldPriority)
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
    this.resize?.observe(parent)
    root.render(React.createElement(VisualBoundary, {
      failed: () => {
        record.failed = true
        queueMicrotask(() => {
          if (this.mounted.get(point)?.registration === record) this.unmount(point)
        })
        this.schedule()
      },
      children: React.createElement(VisualBody, { source, visual: record.loaded! }),
    }))
  }

  private unmount(point: ExtensionPointVisualIdV1): void {
    const mount = this.mounted.get(point)
    if (mount === undefined) return
    this.mounted.delete(point)
    this.resize?.unobserve(point === 'composer.primary-action.visual' ? mount.seat.button : mount.seat.frame)
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
