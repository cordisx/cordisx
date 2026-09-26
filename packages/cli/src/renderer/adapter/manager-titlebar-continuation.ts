import { resolveManagerTitlebarSeat } from '../host-probes.js'
import { resolveManagerSplitTitlebarSeat } from './manager-split-titlebar.js'
import { resolveManagerSettingsTitlebarSeat } from './manager-settings-titlebar.js'

type Bounds = Readonly<{ left: number; top: number; width: number; height: number }>

export interface ManagerTitlebarLease {
  readonly kind: 'native' | 'split' | 'settings'
  readonly seat: {
    readonly slot: HTMLElement
    readonly native: readonly HTMLElement[]
    readonly bounds: Bounds
    readonly provenance: 'native' | 'split' | 'settings'
  }
}

export interface ManagerTitlebarPaneIdentity {
  readonly rail: HTMLElement
  readonly sidebar: { readonly container: HTMLElement }
  readonly main: { readonly anchor: HTMLElement }
}

export interface ManagerTitlebarActiveSeats {
  readonly titlebarSeat: HTMLElement
  readonly navigationSeat: HTMLElement
  readonly contentSeat: HTMLElement
  readonly resizeHandle: HTMLElement
  readonly sidebarWidth: number
}

interface NativeControl {
  readonly element: HTMLElement
  readonly bounds: DOMRect
}

interface Baseline {
  readonly document: Document
  readonly header: HTMLElement
  readonly start: HTMLElement
  readonly end: HTMLElement
  readonly title: HTMLElement
  readonly slot: HTMLElement
  readonly native: readonly HTMLElement[]
  readonly rail: HTMLElement
  readonly navigation: HTMLElement
  readonly main: HTMLElement
  readonly headerRect: DOMRect
  readonly startRect: DOMRect
  readonly endRect: DOMRect
  readonly titleRect: DOMRect
  readonly titleRegion: string
  readonly slotRect: DOMRect
  readonly railRect: DOMRect
  readonly mainRight: number
  readonly headerLayout: string | null
  readonly mainLayout: string | null
  readonly navigationLabel: string | null
  readonly controls: readonly NativeControl[]
  readonly bounds: Bounds
  readonly kind: ManagerTitlebarLease['kind']
  activeOwner?: Pick<ManagerTitlebarActiveSeats, 'titlebarSeat' | 'navigationSeat' | 'contentSeat' | 'resizeHandle'>
}

const issued = new WeakMap<ManagerTitlebarLease, Baseline>()

function box(element: Element): DOMRect | undefined {
  if (element.getClientRects().length === 0) return undefined
  const rect = element.getBoundingClientRect()
  return rect.width >= 0 && rect.height > 0 ? rect : undefined
}

function region(style: CSSStyleDeclaration): string {
  return style.getPropertyValue('-webkit-app-region').trim()
    || (style as CSSStyleDeclaration & { webkitAppRegion?: string }).webkitAppRegion?.trim()
    || ''
}

function near(left: number, right: number): boolean {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 2
}

function sameRect(left: DOMRect, right: DOMRect): boolean {
  return near(left.left, right.left) && near(left.top, right.top)
    && near(left.right, right.right) && near(left.bottom, right.bottom)
}

function outsideNativeTitle(element: Element, native: readonly HTMLElement[]): boolean {
  return native.every(node => !node.contains(element))
}

function nativeControls(header: HTMLElement, native: readonly HTMLElement[]): NativeControl[] {
  const view = header.ownerDocument.defaultView
  const headerRect = header.getBoundingClientRect()
  if (view === null) return []
  return [...header.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea,[role="button"]')]
    .filter(element => outsideNativeTitle(element, native))
    .filter(element => element.closest('[data-cordisx-manager-titlebar-seat]') === null)
    .map(element => ({ element, bounds: box(element), style: view.getComputedStyle(element) }))
    .filter((item): item is typeof item & { bounds: DOMRect } =>
      item.bounds !== undefined && item.bounds.top < headerRect.bottom && item.bounds.bottom > headerRect.top
      && item.style.display !== 'none' && item.style.visibility === 'visible'
    )
    .map(({ element, bounds }) => ({ element, bounds }))
    .sort((left, right) => left.bounds.left - right.bounds.left)
}

function nativeControlStyleAllowed(
  element: HTMLElement,
  bounds: DOMRect,
  style: CSSStyleDeclaration,
  kind: ManagerTitlebarLease['kind'],
  seatRight: number,
): boolean {
  if (region(style) !== 'no-drag') return false
  if (style.pointerEvents === 'auto') return true
  // In the split tab strip, an inactive tab's close button can be hidden from
  // pointer input. It remains wholly outside the Host's left title seat.
  return kind === 'split' && style.pointerEvents === 'none'
    && element.matches('button:not([role="tab"])')
    && element.closest('[data-app-shell-tab-controller="right"][data-tab-id]') !== null
    && bounds.left >= seatRight - 2
}

/** Capture exact native identities before the Host changes sidebar width. */
export function captureManagerTitlebarLease(
  document: Document,
  kind: ManagerTitlebarLease['kind'],
  pane: ManagerTitlebarPaneIdentity,
): ManagerTitlebarLease | undefined {
  const view = document.defaultView
  if (view === null) return undefined
  const strict = kind === 'native'
    ? resolveManagerTitlebarSeat(document)
    : kind === 'split'
    ? resolveManagerSplitTitlebarSeat(document)
    : resolveManagerSettingsTitlebarSeat(document)
  if (strict === undefined) return undefined
  const seat = kind === 'native' || kind === 'split'
    ? { ...strict as NonNullable<ReturnType<typeof resolveManagerTitlebarSeat>>, provenance: kind }
    : {
      slot: (strict as NonNullable<ReturnType<typeof resolveManagerSettingsTitlebarSeat>>).anchor,
      native: [(strict as NonNullable<ReturnType<typeof resolveManagerSettingsTitlebarSeat>>).nativeTitle],
      bounds: (strict as NonNullable<ReturnType<typeof resolveManagerSettingsTitlebarSeat>>).bounds,
      provenance: 'settings' as const,
    }
  const header = kind === 'settings'
    ? seat.slot
    : seat.slot.closest<HTMLElement>('header[data-app-shell-titlebar="true"]')
  if (header === null || header === undefined) return undefined
  const starts = header.querySelectorAll<HTMLElement>(':scope > [data-app-shell-header-slot="start"]')
  const ends = header.querySelectorAll<HTMLElement>(':scope > [data-app-shell-header-slot="end"]')
  const titles = header.querySelectorAll<HTMLElement>(
    ':scope > [data-app-shell-main-titlebar="true"][data-testid="app-shell-header-context-menu-surface"]',
  )
  if (starts.length !== 1 || ends.length !== 1 || titles.length !== 1) return undefined
  const start = starts[0]!
  const end = ends[0]!
  const title = titles[0]!
  const headerRect = box(header)
  const startRect = box(start)
  const endRect = box(end)
  const titleRect = box(title)
  const slotRect = box(seat.slot)
  const railRect = box(pane.rail)
  const navRect = box(pane.sidebar.container)
  const mainRect = box(pane.main.anchor)
  if (
    headerRect === undefined || startRect === undefined || endRect === undefined
    || titleRect === undefined || slotRect === undefined || railRect === undefined
    || navRect === undefined || mainRect === undefined
    || !near(navRect.left, railRect.right) || !near(navRect.right, mainRect.left)
    || !near(navRect.right, seat.bounds.left) || !near(mainRect.top, headerRect.bottom)
    || header.querySelector('[data-cordisx-manager-titlebar-seat]') !== null
  ) return undefined
  const controls = nativeControls(header, seat.native)
  const headerStyle = view.getComputedStyle(header)
  const titleStyle = view.getComputedStyle(title)
  if (
    headerStyle.position !== 'fixed' || headerStyle.pointerEvents !== 'none'
    || region(headerStyle) !== 'drag' || titleStyle.pointerEvents !== 'none'
    || controls.length < 2 || controls[0]!.bounds.left < headerRect.left + 80
    || controls[1]!.bounds.right > headerRect.left + 170
  ) return undefined
  if (
    controls.some(({ element, bounds }) =>
      !nativeControlStyleAllowed(
        element,
        bounds,
        view.getComputedStyle(element),
        kind,
        seat.bounds.left + seat.bounds.width,
      )
    )
  ) return undefined
  const lease: ManagerTitlebarLease = { kind, seat }
  issued.set(lease, {
    document,
    header,
    start,
    end,
    title,
    slot: seat.slot,
    native: seat.native,
    rail: pane.rail,
    navigation: pane.sidebar.container,
    main: pane.main.anchor,
    headerRect,
    startRect,
    endRect,
    titleRect,
    titleRegion: region(titleStyle),
    slotRect,
    railRect,
    mainRight: mainRect.right,
    headerLayout: header.getAttribute('data-app-shell-header-layout'),
    mainLayout: pane.main.anchor.getAttribute('data-app-shell-main-content-layout'),
    navigationLabel: pane.sidebar.container.getAttribute('aria-label'),
    controls,
    bounds: seat.bounds,
    kind,
  })
  return lease
}

/** Revoke the captured native identities when the owning Manager pane closes. */
export function releaseManagerTitlebarLease(lease: ManagerTitlebarLease): void {
  issued.delete(lease)
}

/**
 * Continue only the same mounted Host pane. Native titlebar geometry stays at
 * its captured position while the Host-owned nav/main split may move.
 */
export function resolveManagerTitlebarContinuation(
  document: Document,
  lease: ManagerTitlebarLease,
  owner: ManagerTitlebarActiveSeats,
): ManagerTitlebarLease['seat'] | undefined {
  const baseline = issued.get(lease)
  const view = document.defaultView
  if (baseline === undefined || baseline.document !== document || view === null) return undefined
  const held = baseline.activeOwner
  if (
    held !== undefined && (
      held.titlebarSeat !== owner.titlebarSeat || held.navigationSeat !== owner.navigationSeat
      || held.contentSeat !== owner.contentSeat || held.resizeHandle !== owner.resizeHandle
    )
  ) return undefined
  const { header, start, end, title, slot, rail, navigation, main, native } = baseline
  if (
    ![header, start, end, title, slot, rail, navigation, main].every(node => node.isConnected)
    || owner.sidebarWidth < 180 || owner.sidebarWidth > 420
    || !Number.isFinite(owner.sidebarWidth)
    || owner.titlebarSeat.parentElement !== slot
    || owner.navigationSeat.parentElement !== navigation
    || owner.contentSeat.parentElement !== main
    || !owner.resizeHandle.isConnected
    || owner.titlebarSeat.getAttribute('data-cordisx-manager-titlebar-seat') !== 'true'
    || owner.navigationSeat.getAttribute('data-cordisx-manager-sidebar-root') !== 'true'
    || owner.contentSeat.getAttribute('data-cordisx-react-manager') !== 'true'
    || owner.contentSeat.getAttribute('data-manager-surface') !== 'pane'
    || owner.resizeHandle.getAttribute('data-cordisx-manager-sidebar-resizer') !== 'true'
    || owner.resizeHandle.getAttribute('role') !== 'separator'
    || header.getAttribute('data-app-shell-header-layout') !== baseline.headerLayout
    || main.getAttribute('data-app-shell-main-content-layout') !== baseline.mainLayout
    || navigation.getAttribute('aria-label') !== baseline.navigationLabel
  ) return undefined
  const headers = document.querySelectorAll('header[data-app-shell-titlebar="true"]')
  const starts = header.querySelectorAll(':scope > [data-app-shell-header-slot="start"]')
  const ends = header.querySelectorAll(':scope > [data-app-shell-header-slot="end"]')
  const titles = header.querySelectorAll(
    ':scope > [data-app-shell-main-titlebar="true"][data-testid="app-shell-header-context-menu-surface"]',
  )
  const hostSeats = header.querySelectorAll('[data-cordisx-manager-titlebar-seat="true"]')
  if (
    headers.length !== 1 || headers[0] !== header || starts.length !== 1 || starts[0] !== start
    || ends.length !== 1 || ends[0] !== end || titles.length !== 1 || titles[0] !== title
    || hostSeats.length !== 1 || hostSeats[0] !== owner.titlebarSeat
    || !native.every(node =>
      node.isConnected && node.inert
      && node.style.visibility === 'hidden' && node.getAttribute('aria-hidden') === 'true'
    )
  ) return undefined
  const headerRect = box(header)
  const startRect = box(start)
  const endRect = box(end)
  const titleRect = box(title)
  const slotRect = box(slot)
  const railRect = box(rail)
  const navRect = box(navigation)
  const mainRect = box(main)
  const handleRect = box(owner.resizeHandle)
  const hostRect = box(owner.titlebarSeat)
  if (
    headerRect === undefined || startRect === undefined || endRect === undefined
    || titleRect === undefined || slotRect === undefined || railRect === undefined
    || navRect === undefined || mainRect === undefined || handleRect === undefined
    || hostRect === undefined
    || !sameRect(headerRect, baseline.headerRect) || !sameRect(startRect, baseline.startRect)
    || !sameRect(endRect, baseline.endRect) || !sameRect(titleRect, baseline.titleRect)
    || !sameRect(slotRect, baseline.slotRect) || !sameRect(railRect, baseline.railRect)
    || !near(navRect.left, railRect.right) || !near(navRect.top, headerRect.bottom)
    || !near(navRect.width, owner.sidebarWidth) || !near(mainRect.left, navRect.right)
    || !near(mainRect.top, headerRect.bottom) || !near(mainRect.right, baseline.mainRight)
    || mainRect.width < 320 || handleRect.width < 6 || handleRect.width > 24
    || handleRect.height < navRect.height * 0.8
    || !near((handleRect.left + handleRect.right) / 2, navRect.right)
  ) return undefined
  const headerStyle = view.getComputedStyle(header)
  const titleStyle = view.getComputedStyle(title)
  const hostStyle = view.getComputedStyle(owner.titlebarSeat)
  if (
    headerStyle.position !== 'fixed' || headerStyle.pointerEvents !== 'none' || region(headerStyle) !== 'drag'
    || titleStyle.pointerEvents !== 'none' || region(titleStyle) !== baseline.titleRegion
    || hostStyle.pointerEvents !== 'none' || region(hostStyle) === 'no-drag'
    || hostRect.left < baseline.bounds.left - 2
    || hostRect.right > baseline.bounds.left + baseline.bounds.width + 2
    || !near(hostRect.top, headerRect.top) || hostRect.bottom > headerRect.bottom + 2
  ) return undefined
  const controls = nativeControls(header, native)
  if (
    controls.length !== baseline.controls.length || controls.some(({ element, bounds }, index) => {
      const expected = baseline.controls[index]
      const style = view.getComputedStyle(element)
      return expected?.element !== element || !sameRect(bounds, expected.bounds)
        || !nativeControlStyleAllowed(
          element,
          bounds,
          style,
          baseline.kind,
          baseline.bounds.left + baseline.bounds.width,
        )
    })
  ) return undefined
  const right = baseline.bounds.left + baseline.bounds.width
  const left = Math.max(baseline.bounds.left, mainRect.left)
  if (right - left < 320) return undefined
  for (let x = baseline.bounds.left + 8; x < right; x += 16) {
    const hit = document.elementFromPoint(x, headerRect.top + headerRect.height / 2)
    if (hit === null || (header.contains(hit) && !owner.titlebarSeat.contains(hit))) return undefined
  }
  baseline.activeOwner ??= {
    titlebarSeat: owner.titlebarSeat,
    navigationSeat: owner.navigationSeat,
    contentSeat: owner.contentSeat,
    resizeHandle: owner.resizeHandle,
  }
  return {
    slot,
    native,
    provenance: baseline.kind,
    bounds: { left, top: baseline.bounds.top, width: right - left, height: baseline.bounds.height },
  }
}
