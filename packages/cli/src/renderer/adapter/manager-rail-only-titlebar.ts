/** Host-private 26.924 probe for destinations with a rail and no native sidebar. */
export interface ManagerRailOnlyTitlebarSeat {
  readonly anchor: HTMLElement
  readonly nativeTitle: HTMLElement
  /** Viewport coordinates inside the native y=0 titlebar, clear of its controls. */
  readonly bounds: Readonly<{ left: number; top: number; right: number; bottom: number; width: number; height: number }>
  readonly provenance: 'codex-26.924-rail-only-titlebar'
}

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

/**
 * Library, Images, and Customize in 26.924 leave a native drag strip at y=0.
 * Only return its measured blank span. The y=44 content title is never a seat.
 * The caller may append one Host-owned pointer-events:none seat to `anchor`,
 * with only its own controls set to pointer-events:auto and app-region:no-drag.
 */
export function resolveManagerRailOnlyTitlebarSeat(document: Document): ManagerRailOnlyTitlebarSeat | undefined {
  const view = document.defaultView
  if (view === null) return undefined
  const headers = document.querySelectorAll<HTMLElement>(
    'header[data-app-shell-titlebar="true"][data-app-shell-application-menu-bar="false"]',
  )
  const header = headers[0]
  if (headers.length !== 1 || header === undefined) return undefined
  const layout = header.getAttribute('data-app-shell-header-layout')
  if (layout !== 'default' && layout !== 'custom-titlebar') return undefined
  const headerRect = box(header)
  const headerStyle = view.getComputedStyle(header)
  if (
    headerRect === undefined || !near(headerRect.left, 0) || !near(headerRect.top, 0)
    || headerRect.height < 40 || headerRect.height > 48
    || headerStyle.position !== 'fixed' || headerStyle.pointerEvents !== 'none'
    || region(headerStyle) !== 'drag'
  ) return undefined

  const starts = header.querySelectorAll<HTMLElement>(
    ':scope > [data-app-shell-header-slot="start"][data-app-shell-header-obstacle="true"]',
  )
  const ends = header.querySelectorAll<HTMLElement>(
    ':scope > [data-app-shell-header-slot="end"][data-app-shell-header-obstacle="true"]',
  )
  const titles = header.querySelectorAll<HTMLElement>(
    ':scope > [data-app-shell-main-titlebar="true"][data-testid="app-shell-header-context-menu-surface"]',
  )
  if (starts.length !== 1 || ends.length !== 1 || titles.length !== 1) return undefined
  if (header.querySelector('[data-app-shell-titlebar-slot="main"]') !== null) return undefined
  const start = starts[0]!
  const end = ends[0]!
  const title = titles[0]!
  const startRect = box(start)
  const endRect = box(end)
  const titleRect = box(title)
  if (
    startRect === undefined || endRect === undefined || titleRect === undefined
    || !near(startRect.left, headerRect.left) || !near(startRect.top, headerRect.top)
    || startRect.width < 40 || startRect.width > 80 || !near(startRect.height, headerRect.height)
    || !near(titleRect.left, startRect.right) || !near(titleRect.top, headerRect.bottom)
    || titleRect.width < 200 || !near(endRect.left, titleRect.right)
    || endRect.width > 2 || endRect.top < headerRect.bottom - 2
  ) return undefined
  const titleStyle = view.getComputedStyle(title)
  const titleRegion = layout === 'custom-titlebar' ? 'no-drag' : 'none'
  if (titleStyle.pointerEvents !== 'none' || region(titleStyle) !== titleRegion) return undefined

  // A native sidebar gives this route a different header owner and layout.
  const visibleNavigation = [...document.querySelectorAll('nav[role="navigation"]')]
    .some(element => element.getClientRects().length > 0)
  if (visibleNavigation) return undefined
  const hostSeats = header.querySelectorAll(':scope > [data-cordisx-manager-titlebar-seat="true"]')
  if (hostSeats.length > 1 || (hostSeats.length === 1 && hostSeats[0] !== header.lastElementChild)) {
    return undefined
  }

  const actions = [...header.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea,[role="button"]')]
    .filter(element => !element.closest('[data-cordisx-manager-titlebar-seat]'))
    .map(element => ({ element, rect: box(element), style: view.getComputedStyle(element) }))
    .filter((item): item is typeof item & { rect: DOMRect } =>
      item.rect !== undefined && item.rect.top < headerRect.bottom && item.rect.bottom > headerRect.top
      && item.style.display !== 'none' && item.style.visibility === 'visible'
    )
  if (
    actions.length !== 2
    || actions.some(({ element, rect, style }) =>
      element.tagName !== 'BUTTON' || rect.left < headerRect.left + 80
      || rect.right > headerRect.left + 170 || rect.width < 24 || rect.width > 36
      || rect.height < 24 || rect.height > 36 || style.pointerEvents !== 'auto'
      || region(style) !== 'no-drag'
    )
  ) return undefined
  const [first, second] = actions.sort((left, right) => left.rect.left - right.rect.left)
  if (first === undefined || second === undefined || first.rect.right > second.rect.left + 2) return undefined

  const left = Math.ceil(Math.max(startRect.right, second.rect.right + 16))
  const right = Math.floor(Math.min(headerRect.right - 36, endRect.left))
  if (right - left < 320) return undefined
  // The native strip must remain click-through outside its two buttons. A new
  // interactive native control in this span invalidates the Host seat.
  const y = headerRect.top + headerRect.height / 2
  for (let x = left + 8; x < right; x += 16) {
    const hit = document.elementFromPoint(x, y)
    if (hit === null || (header.contains(hit) && !hit.closest('[data-cordisx-manager-titlebar-seat]'))) {
      return undefined
    }
  }
  if (hostSeats.length === 1) {
    const host = hostSeats[0]!
    const hostRect = box(host)
    const hostStyle = view.getComputedStyle(host)
    if (
      hostRect === undefined || hostStyle.pointerEvents !== 'none' || region(hostStyle) === 'no-drag'
      || hostRect.left < left - 2 || hostRect.right > right + 2
      || !near(hostRect.top, headerRect.top) || hostRect.bottom > headerRect.bottom + 2
    ) return undefined
  }
  return {
    anchor: header,
    nativeTitle: title,
    bounds: {
      left,
      top: headerRect.top,
      right,
      bottom: headerRect.bottom,
      width: right - left,
      height: headerRect.height,
    },
    provenance: 'codex-26.924-rail-only-titlebar',
  }
}
