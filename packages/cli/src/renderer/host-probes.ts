function visible(element: Element): element is HTMLElement {
  const ElementClass = element.ownerDocument.defaultView?.HTMLElement
  if (ElementClass === undefined || !(element instanceof ElementClass)) return false
  return element.getClientRects().length > 0
}

/** Private fallback probe for the current manager trigger. Structured adapters use semantic probes. */
export function resolveManagerTriggerTarget(document: Document): HTMLElement | undefined {
  const candidates = document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')
  const visibleCandidates = [...candidates].filter(candidate =>
    visible(candidate)
    && (candidate.textContent?.trim() === 'Codex'
      || candidate.getAttribute('aria-label')?.trim().endsWith('Codex') === true)
  )
  return visibleCandidates.length === 1 ? visibleCandidates[0] : undefined
}

/** Host-private 26.924 rail seat. Insert a tagged Host-owned item before `before`; leave native items in place. */
export function resolveManagerRailSeat(document: Document): {
  container: HTMLElement
  before: HTMLElement
  homeButton: HTMLButtonElement
} | undefined {
  const rails = document.querySelectorAll<HTMLElement>('nav[data-app-navigation-rail="true"]')
  const rail = rails[0]
  if (rails.length !== 1 || rail === undefined || !visible(rail)) return undefined

  const homes = rail.querySelectorAll<HTMLButtonElement>('button[data-sidebar-destination="builtin:home"]')
  const automations = rail.querySelectorAll<HTMLButtonElement>(
    'button[data-sidebar-destination="builtin:automations"]',
  )
  if (homes.length !== 1 || automations.length !== 1) return undefined

  const homeButton = homes[0]
  const automationButton = automations[0]
  if (
    homeButton === undefined || automationButton === undefined || !visible(homeButton) || !visible(automationButton)
  ) {
    return undefined
  }

  const homeItem = homeButton.parentElement
  const container = homeItem?.parentElement
  const managerItems = rail.querySelectorAll<HTMLElement>('[data-cordisx-manager-rail-item]')
  if (managerItems.length > 1) return undefined

  const next = homeItem?.nextElementSibling
  const managerItem = managerItems[0]
  if (
    managerItem !== undefined
    && (managerItem !== next || managerItem.tagName !== 'DIV'
      || managerItem.getAttribute('data-cordisx-manager-rail-item') !== 'true')
  ) return undefined
  const before = managerItem?.nextElementSibling ?? next
  if (
    homeItem?.tagName !== 'DIV'
    || container?.tagName !== 'DIV'
    || container.parentElement !== rail
    || before?.tagName !== 'DIV'
    || !before.contains(automationButton)
  ) return undefined

  return { container, before: before as HTMLElement, homeButton }
}

/** Host-private 26.924 main card. Reject changed or ambiguous native structure. */
export function resolveManagerCardSeat(document: Document): {
  anchor: HTMLElement
  frame: HTMLElement
} | undefined {
  const anchors = document.querySelectorAll<HTMLElement>(
    '[data-app-shell-main-content-layout="thread-edge-scroll"], [data-app-shell-main-content-layout="default"], [data-app-shell-main-content-layout="full-bleed"]',
  )
  const anchor = anchors[0]
  if (anchors.length !== 1 || anchor === undefined || !visible(anchor)) return undefined
  const ElementClass = document.defaultView?.HTMLElement
  if (ElementClass === undefined) return undefined
  const frames = [...anchor.children].filter((child): child is HTMLElement =>
    child instanceof ElementClass
    && child.hasAttribute('data-app-shell-thread-edge-divider')
  )
  const frame = frames[0]
  if (frames.length !== 1 || frame === undefined || !visible(frame)) return undefined
  if (
    frame.querySelectorAll('[data-app-shell-main-content-top-fade]').length !== 1
    || frame.querySelectorAll('[data-app-shell-focus-area="main"]').length !== 1
  ) return undefined
  const anchorRect = anchor.getBoundingClientRect()
  const frameRect = frame.getBoundingClientRect()
  const rail = document.querySelector<HTMLElement>('nav[data-app-navigation-rail="true"]')
  const railRect = rail?.getBoundingClientRect()
  if (
    anchorRect.width < 320 || anchorRect.height < 240 || anchorRect.top < 36
    || railRect === undefined || anchorRect.left < railRect.right
    || Math.abs(anchorRect.left - frameRect.left) > 2
    || Math.abs(anchorRect.top - frameRect.top) > 2
    || Math.abs(anchorRect.width - frameRect.width) > 2
    || Math.abs(anchorRect.height - frameRect.height) > 2
  ) return undefined
  return { anchor, frame }
}

export interface ManagerTwoPaneSeat {
  readonly rail: HTMLElement
  readonly sidebar: {
    readonly navigation: HTMLElement
    readonly container: HTMLElement
    /** Exact direct native children to preserve while the Host projection is open. */
    readonly native: readonly HTMLElement[]
    /** The separate 26.924 aside resize strip overlaps the Host pane boundary. */
    readonly resizer: HTMLElement
  }
  readonly main: {
    readonly anchor: HTMLElement
    readonly frame: HTMLElement
  }
  /** Snapshot only. Consumers must re-resolve before applying a projection. */
  readonly geometry: {
    readonly railRight: number
    readonly sidebarLeft: number
    readonly sidebarRight: number
    readonly mainLeft: number
    readonly top: number
    readonly bottom: number
  }
  readonly provenance: 'codex-26.924-native-two-pane'
}

/** Host-private paired seat for the 26.924 rail + current native sidebar + main card layout. */
export function resolveManagerTwoPaneSeat(document: Document): ManagerTwoPaneSeat | undefined {
  const card = resolveManagerCardSeat(document)
  const rails = document.querySelectorAll<HTMLElement>('nav[data-app-navigation-rail="true"]')
  const rail = rails[0]
  if (
    card === undefined || rails.length !== 1 || rail === undefined || !visible(rail)
  ) return undefined

  const railRect = rail.getBoundingClientRect()
  const mainRect = card.anchor.getBoundingClientRect()
  const near = (left: number, right: number) =>
    Number.isFinite(left) && Number.isFinite(right)
    && Math.abs(left - right) <= 2
  if (!near(railRect.left, 0) || railRect.width < 40 || railRect.width > 80) return undefined

  const ElementClass = document.defaultView?.HTMLElement
  if (ElementClass === undefined) return undefined
  const candidates = [...document.querySelectorAll<HTMLElement>('nav[role="navigation"], nav:not([role])[aria-label]')]
    .flatMap(navigation => {
      if (
        !visible(navigation) || rail.contains(navigation)
        || card.anchor.contains(navigation) || navigation.contains(card.anchor)
      ) return []
      const navRect = navigation.getBoundingClientRect()
      if (
        navRect.width < 180 || navRect.width > 420 || navRect.height < 240
        || !near(railRect.right, navRect.left) || !near(navRect.right, mainRect.left)
        || !near(navRect.top, mainRect.top) || !near(navRect.bottom, mainRect.bottom)
      ) return []
      const children = [...navigation.children]
      const hostRoots = children.filter(child => child.hasAttribute('data-cordisx-manager-sidebar-root'))
      if (
        hostRoots.length > 1
        || (hostRoots.length === 1 && (
          hostRoots[0] !== children.at(-1)
          || hostRoots[0]?.tagName !== 'DIV'
          || hostRoots[0]?.getAttribute('data-cordisx-manager-sidebar-root') !== 'true'
        ))
      ) return []
      const native = children.filter((child): child is HTMLElement =>
        child instanceof ElementClass && !child.hasAttribute('data-cordisx-manager-sidebar-root')
      )
      if (native.length === 0 || native.length + hostRoots.length !== children.length) return []
      const aside = navigation.closest<HTMLElement>('aside[data-app-shell-left-panel-appearance]')
      if (aside === null || !aside.contains(rail)) return []
      const resizers = [...aside.children]
        .filter((child): child is HTMLElement => child instanceof ElementClass)
        .filter(wrapper => {
          if (navigation.contains(wrapper) || rail.contains(wrapper)) return false
          if (wrapper.querySelector(':scope > [role="separator"][aria-orientation="vertical"]') === null) {
            return false
          }
          const rect = wrapper.getBoundingClientRect()
          return rect.width >= 6 && rect.width <= 24 && rect.height >= navRect.height * 0.8
            && Math.abs((rect.left + rect.right) / 2 - navRect.right) <= 8
        })
      if (resizers.length !== 1) return []
      return [{ navigation, native, navRect, resizer: resizers[0]! }]
    })
  if (candidates.length !== 1) return undefined
  const { navigation, native, navRect, resizer } = candidates[0]!

  return {
    rail,
    sidebar: { navigation, container: navigation, native, resizer },
    main: card,
    geometry: {
      railRight: railRect.right,
      sidebarLeft: navRect.left,
      sidebarRight: navRect.right,
      mainLeft: mainRect.left,
      top: navRect.top,
      bottom: navRect.bottom,
    },
    provenance: 'codex-26.924-native-two-pane',
  }
}

/** 26.924 exposes one title surface between its native start and end controls. */
export function resolveManagerTitlebarSeat(document: Document): {
  readonly slot: HTMLElement
  readonly native: readonly HTMLElement[]
  /** Viewport bounds for Host chrome, excluding an end control overlaid on the native main slot. */
  readonly bounds: Readonly<{ left: number; top: number; width: number; height: number }>
} | undefined {
  const bars = document.querySelectorAll<HTMLElement>('header[data-app-shell-titlebar="true"]')
  const bar = bars[0]
  if (bars.length !== 1 || bar === undefined || !visible(bar)) return undefined
  const titles = bar.querySelectorAll<HTMLElement>(
    ':scope > [data-app-shell-main-titlebar="true"][data-testid="app-shell-header-context-menu-surface"]',
  )
  const slots = titles[0]?.querySelectorAll<HTMLElement>(
    '[data-app-shell-titlebar-slot="main"][data-app-shell-focus-area="main"]',
  )
  const starts = bar.querySelectorAll<HTMLElement>('[data-app-shell-header-slot="start"]')
  const ends = bar.querySelectorAll<HTMLElement>('[data-app-shell-header-slot="end"]')
  const slot = slots?.[0]
  if (
    titles.length !== 1 || slots?.length !== 1 || starts.length !== 1 || ends.length !== 1
    || slot === undefined || !visible(slot)
  ) return undefined

  const barRect = bar.getBoundingClientRect()
  const slotRect = slot.getBoundingClientRect()
  const startRect = starts[0]!.getBoundingClientRect()
  const endRect = ends[0]!.getBoundingClientRect()
  const safeRight = Math.min(slotRect.right, endRect.left)
  if (
    barRect.width <= 0 || barRect.height < 30 || barRect.height > 80
    || slotRect.width < 200 || slotRect.height < 30 || safeRight - slotRect.left < 200
    || Math.abs(slotRect.top - barRect.top) > 2
    || Math.abs(slotRect.left - startRect.right) > 2
    || Math.abs(endRect.top - barRect.top) > 2 || endRect.width <= 0 || endRect.width > 64
    || Math.abs(endRect.right - barRect.right) > 2
    || slotRect.right > barRect.right + 2 || endRect.left < slotRect.left
    || (slotRect.right > endRect.left + 2 && endRect.right > slotRect.right + 2)
  ) return undefined

  const ElementClass = document.defaultView?.HTMLElement
  if (ElementClass === undefined) return undefined
  const children = [...slot.children]
  const hostSeats = children.filter(child => child.hasAttribute('data-cordisx-manager-titlebar-seat'))
  if (
    hostSeats.length > 1
    || (hostSeats.length === 1 && (
      hostSeats[0] !== children.at(-1) || hostSeats[0]?.tagName !== 'DIV'
      || hostSeats[0]?.getAttribute('data-cordisx-manager-titlebar-seat') !== 'true'
    ))
  ) return undefined
  const native = children.filter((child): child is HTMLElement =>
    child instanceof ElementClass && !child.hasAttribute('data-cordisx-manager-titlebar-seat')
  )
  if (native.length + hostSeats.length !== children.length) return undefined
  return {
    slot,
    native,
    bounds: { left: slotRect.left, top: slotRect.top, width: safeRight - slotRect.left, height: slotRect.height },
  }
}

export interface ManagerRailOnlySeat {
  readonly rail: HTMLElement
  readonly sidebar: {
    /** The Host projection is placed beside the rail, never over it. */
    readonly container: HTMLElement
    readonly native: readonly HTMLElement[]
    readonly left: number
    readonly width: number
    readonly inMain: boolean
  }
  readonly main: { readonly anchor: HTMLElement; readonly frame: HTMLElement }
  readonly provenance: 'codex-26.924-rail-only'
}

export type ManagerPaneSeat = ManagerTwoPaneSeat | ManagerRailOnlySeat

/** 26.924 pages with a rail and main viewport but no native navigation pane. */
export function resolveManagerRailOnlySeat(document: Document): ManagerRailOnlySeat | undefined {
  const rails = document.querySelectorAll<HTMLElement>('nav[data-app-navigation-rail="true"]')
  const rail = rails[0]
  const asides = document.querySelectorAll<HTMLElement>('aside[data-app-shell-left-panel-appearance]')
  const aside = asides[0]
  const anchors = document.querySelectorAll<HTMLElement>(
    '[data-app-shell-main-content-layout="default"], [data-app-shell-main-content-layout="custom-titlebar"], [data-app-shell-main-content-layout="full-bleed"]',
  )
  const anchor = anchors[0]
  if (
    rails.length !== 1 || rail === undefined || !visible(rail)
    || asides.length !== 1 || aside === undefined || !visible(aside) || !aside.contains(rail)
    || anchors.length !== 1 || anchor === undefined || !visible(anchor)
    || [...aside.querySelectorAll('nav')].some(navigation => navigation !== rail)
  ) return undefined
  const ElementClass = document.defaultView?.HTMLElement
  if (ElementClass === undefined) return undefined
  const frames = [...anchor.children].filter((child): child is HTMLElement =>
    child instanceof ElementClass && child.hasAttribute('data-app-shell-thread-edge-divider')
  )
  const frame = frames[0]
  if (
    frames.length !== 1 || frame === undefined || !visible(frame)
    || frame.querySelectorAll('[data-app-shell-focus-area="main"]').length !== 1
    || frame.querySelectorAll('[data-app-shell-main-content-top-fade]').length > 1
  ) return undefined
  const railRect = rail.getBoundingClientRect()
  const asideRect = aside.getBoundingClientRect()
  const mainRect = anchor.getBoundingClientRect()
  const frameRect = frame.getBoundingClientRect()
  const near = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 2
  if (
    !near(railRect.left, 0) || railRect.width < 40 || railRect.width > 80
    || !near(railRect.top, asideRect.top) || !near(railRect.bottom, asideRect.bottom)
    || !near(asideRect.left, 0) || !near(asideRect.right, mainRect.left)
    || !near(mainRect.top, railRect.top) || !near(mainRect.bottom, railRect.bottom)
    || !near(mainRect.left, frameRect.left) || !near(mainRect.top, frameRect.top)
    || !near(mainRect.width, frameRect.width) || !near(mainRect.height, frameRect.height)
    || mainRect.top < 36 || mainRect.height < 240
  ) return undefined
  if (!near(asideRect.right, railRect.right) || mainRect.width < 558) return undefined
  const sidebarWidth = 238
  const container = anchor
  const native: HTMLElement[] = []
  let railBranch: Element = rail
  for (let depth = 0; railBranch.parentElement !== aside && depth < 8; depth++) {
    const parent = railBranch.parentElement
    if (parent === null || !aside.contains(parent)) return undefined
    native.push(
      ...[...parent.children].filter((child): child is HTMLElement =>
        child instanceof ElementClass && child !== railBranch
        && !child.hasAttribute('data-cordisx-manager-sidebar-root')
      ),
    )
    railBranch = parent
  }
  if (railBranch.parentElement !== aside) return undefined
  native.push(
    ...[...aside.children].filter((child): child is HTMLElement =>
      child instanceof ElementClass && child !== railBranch && !child.hasAttribute('data-cordisx-manager-sidebar-root')
    ),
  )
  const roots = document.querySelectorAll('[data-cordisx-manager-sidebar-root]')
  if (roots.length > 1 || (roots.length === 1 && roots[0]?.parentElement !== container)) return undefined
  return {
    rail,
    sidebar: { container, native, left: 0, width: sidebarWidth, inMain: true },
    main: { anchor, frame },
    provenance: 'codex-26.924-rail-only',
  }
}

export function resolveManagerPaneSeat(document: Document): ManagerPaneSeat | undefined {
  return resolveManagerTwoPaneSeat(document) ?? resolveManagerRailOnlySeat(document)
}
