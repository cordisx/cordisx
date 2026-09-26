/** Host-private 26.924 seat for the native full-bleed Settings layout. */
export interface ManagerSettingsTitlebarSeat {
  readonly anchor: HTMLElement
  readonly nativeTitle: HTMLElement
  /** Viewport bounds in the fixed y=0 titlebar, clear of native controls. */
  readonly bounds: Readonly<{ left: number; top: number; right: number; bottom: number; width: number; height: number }>
  readonly provenance: 'codex-26.924-settings-titlebar'
}

function visibleBox(element: Element): DOMRect | undefined {
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
 * Settings renders its content title at y=44, outside the fixed titlebar.
 * This probe only returns the measured empty y=0 span of that fixed header.
 * A caller must append one Host seat inside `anchor`, bounded to `bounds`,
 * with pointer-events:none on its root and no-drag only on its own buttons.
 */
export function resolveManagerSettingsTitlebarSeat(document: Document): ManagerSettingsTitlebarSeat | undefined {
  const view = document.defaultView
  if (view === null) return undefined
  const headers = document.querySelectorAll<HTMLElement>(
    'header[data-app-shell-titlebar="true"][data-app-shell-application-menu-bar="false"][data-app-shell-header-layout="full-bleed"]',
  )
  const header = headers[0]
  if (headers.length !== 1 || header === undefined) return undefined
  const headerRect = visibleBox(header)
  const headerStyle = view.getComputedStyle(header)
  if (
    headerRect === undefined || !near(headerRect.left, 0) || !near(headerRect.top, 0)
    || headerRect.height < 40 || headerRect.height > 48
    || headerStyle.position !== 'fixed' || headerStyle.pointerEvents !== 'none'
    || region(headerStyle) !== 'drag'
  ) return undefined

  const rails = document.querySelectorAll<HTMLElement>('nav[data-app-navigation-rail="true"]')
  const mains = document.querySelectorAll<HTMLElement>('[data-app-shell-main-content-layout="full-bleed"]')
  const navigation = [...document.querySelectorAll<HTMLElement>('nav[aria-label]')]
    .filter(element => !element.hasAttribute('role'))
    .filter(element => ['设置', 'Settings'].includes(element.getAttribute('aria-label') ?? ''))
  const railRect = rails[0] === undefined ? undefined : visibleBox(rails[0])
  const navRect = navigation[0] === undefined ? undefined : visibleBox(navigation[0])
  const mainRect = mains[0] === undefined ? undefined : visibleBox(mains[0])
  if (
    rails.length !== 1 || mains.length !== 1 || navigation.length !== 1
    || railRect === undefined || navRect === undefined || mainRect === undefined
    || !near(railRect.left, 0) || !near(railRect.top, headerRect.bottom)
    || railRect.width < 40 || railRect.width > 80
    || !near(navRect.left, railRect.right) || !near(navRect.top, headerRect.bottom)
    || navRect.width < 180 || navRect.width > 420 || navRect.height < 240
    || !near(mainRect.left, navRect.right) || !near(mainRect.top, headerRect.bottom)
    || mainRect.width < 320 || mainRect.height < 240
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
  const title = titles[0]!
  const startRect = visibleBox(starts[0]!)
  const endRect = visibleBox(ends[0]!)
  const titleRect = visibleBox(title)
  if (
    startRect === undefined || endRect === undefined || titleRect === undefined
    || !near(startRect.left, headerRect.left) || !near(startRect.top, headerRect.top)
    || !near(startRect.right, navRect.right) || !near(startRect.height, headerRect.height)
    || !near(titleRect.left, navRect.right) || !near(titleRect.top, headerRect.bottom)
    || !near(titleRect.right, mainRect.right) || titleRect.width < 320
    || !near(endRect.left, titleRect.right) || endRect.width > 2
    || endRect.top < headerRect.bottom - 2
  ) return undefined
  const titleStyle = view.getComputedStyle(title)
  if (titleStyle.pointerEvents !== 'none' || region(titleStyle) !== 'none') return undefined

  const hostSeats = header.querySelectorAll(':scope > [data-cordisx-manager-titlebar-seat="true"]')
  if (hostSeats.length > 1 || (hostSeats.length === 1 && hostSeats[0] !== header.lastElementChild)) {
    return undefined
  }
  const actions = [...header.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea,[role="button"]')]
    .filter(element => !element.closest('[data-cordisx-manager-titlebar-seat]'))
    .map(element => ({ element, rect: visibleBox(element), style: view.getComputedStyle(element) }))
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

  const left = Math.ceil(Math.max(navRect.right, second.rect.right + 16))
  // Reserve the 26.924 end control width even though Settings currently gives
  // that y=0 slot zero width. The Host never claims the macOS/window edge.
  const right = Math.floor(Math.min(headerRect.right - 36, titleRect.right))
  if (right - left < 320) return undefined
  const y = headerRect.top + headerRect.height / 2
  for (let x = left + 8; x < right; x += 16) {
    const hit = document.elementFromPoint(x, y)
    if (hit === null || (header.contains(hit) && !hit.closest('[data-cordisx-manager-titlebar-seat]'))) {
      return undefined
    }
  }
  if (hostSeats.length === 1) {
    const host = hostSeats[0]!
    const hostRect = visibleBox(host)
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
    provenance: 'codex-26.924-settings-titlebar',
  }
}
