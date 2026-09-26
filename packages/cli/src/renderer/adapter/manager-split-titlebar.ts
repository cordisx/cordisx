type Bounds = Readonly<{ left: number; top: number; width: number; height: number }>

export interface ManagerSplitTitlebarSeat {
  readonly slot: HTMLElement
  readonly native: readonly HTMLElement[]
  readonly bounds: Bounds
}

function box(element: Element): DOMRect | undefined {
  if (element.getClientRects().length === 0) return undefined
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0 ? rect : undefined
}

function near(a: number, b: number): boolean {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 2
}

/**
 * Read-only 26.924 split-tab seat. CordisX may use the left title span while
 * Codex keeps the right tab strip and its panel. No native tab is created or
 * activated here.
 */
export function resolveManagerSplitTitlebarSeat(document: Document): ManagerSplitTitlebarSeat | undefined {
  const headers = document.querySelectorAll<HTMLElement>('header[data-app-shell-titlebar="true"]')
  const header = headers[0]
  if (
    headers.length !== 1 || header === undefined
    || header.parentElement?.getAttribute('data-app-shell-unified-tab-strip') !== 'true'
    || header.getAttribute('data-app-shell-header-layout') !== 'default'
  ) return undefined
  const anchors = document.querySelectorAll<HTMLElement>(
    '[data-app-shell-main-content-layout][data-app-shell-workspace-layout="split"]',
  )
  const anchor = anchors[0]
  const titles = header.querySelectorAll<HTMLElement>(
    ':scope > [data-app-shell-main-titlebar="true"][data-testid="app-shell-header-context-menu-surface"]',
  )
  const title = titles[0]
  const slots = title?.querySelectorAll<HTMLElement>(
    '[data-app-shell-titlebar-slot="main"][data-app-shell-focus-area="main"]',
  )
  const slot = slots?.[0]
  const starts = header.querySelectorAll<HTMLElement>(':scope > [data-app-shell-header-slot="start"]')
  const ends = header.querySelectorAll<HTMLElement>(':scope > [data-app-shell-header-slot="end"]')
  if (
    anchors.length !== 1 || anchor === undefined || titles.length !== 1 || title === undefined
    || slots?.length !== 1 || slot === undefined || starts.length !== 1 || ends.length !== 1
  ) return undefined
  const headerRect = box(header)
  const anchorRect = box(anchor)
  const titleRect = box(title)
  const slotRect = box(slot)
  const startRect = box(starts[0]!)
  const endRect = box(ends[0]!)
  if (
    headerRect === undefined || anchorRect === undefined || titleRect === undefined
    || slotRect === undefined || startRect === undefined || endRect === undefined
    || !near(headerRect.left, 0) || !near(headerRect.top, 0)
    || headerRect.height < 40 || headerRect.height > 48
    || !near(anchorRect.top, headerRect.bottom) || anchorRect.width < 320
    || !near(titleRect.left, startRect.right) || !near(titleRect.left, slotRect.left)
    || !near(titleRect.right, slotRect.right) || !near(titleRect.top, headerRect.top)
    || !near(slotRect.left, anchorRect.left) || !near(slotRect.right, anchorRect.right)
    || !near(slotRect.top, headerRect.top) || !near(slotRect.height, headerRect.height)
    || endRect.width <= 64 || !near(endRect.right, headerRect.right)
    || endRect.left < slotRect.right - 2 || endRect.left > slotRect.right + 8
  ) return undefined

  const controllers = [...header.querySelectorAll<HTMLElement>(
    '[data-app-shell-tab-controller="right"][data-tab-id]',
  )]
  if (controllers.length === 0) return undefined
  const ids = controllers.map(controller => controller.getAttribute('data-tab-id'))
  if (
    ids.some(id => !id) || new Set(ids).size !== ids.length
    || controllers.some(controller => controller.querySelector('[role="tab"]') === null)
  ) return undefined
  const active = controllers.filter(controller =>
    controller.querySelector('[role="tab"][aria-selected="true"]') !== null
  )
  if (active.length !== 1) return undefined
  const activeId = active[0]!.getAttribute('data-tab-id')
  const panels = [...document.querySelectorAll<HTMLElement>(
    '[role="tabpanel"][data-app-shell-tab-panel-controller="right"][data-tab-id]',
  )].filter(panel => panel.getAttribute('data-tab-id') === activeId)
  if (panels.length !== 1 || box(panels[0]!) === undefined) return undefined
  if (
    controllers.some(controller => {
      const rect = controller.getBoundingClientRect()
      // Codex may collapse a selected tab header to zero width while its
      // matching right panel remains visible; that header occupies no left seat.
      return !Number.isFinite(rect.left) || !Number.isFinite(rect.right)
        || rect.width < 0 || rect.height <= 0
        || rect.left < endRect.left - 2 || rect.right > endRect.right + 2
    })
  ) return undefined

  const ElementClass = document.defaultView?.HTMLElement
  if (ElementClass === undefined) return undefined
  const children = [...slot.children]
  const hostSeats = children.filter(child => child.hasAttribute('data-cordisx-manager-titlebar-seat'))
  if (
    hostSeats.length > 1 || (hostSeats.length === 1 && (
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
    bounds: { left: slotRect.left, top: slotRect.top, width: slotRect.width, height: slotRect.height },
  }
}
