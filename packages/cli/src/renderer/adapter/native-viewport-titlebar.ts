export interface NativeViewportTitlebarOwner {
  readonly position: 'fixed' | 'absolute'
  readonly surface?: HTMLElement
  readonly frame?: HTMLElement
  readonly activePage?: HTMLElement
  readonly workspace?: HTMLElement
  readonly workspaceRow?: HTMLElement
}

/** 26.1103 places the viewport header absolutely inside a native contents surface. */
export function resolveNativeViewportTitlebarOwner(header: HTMLElement): NativeViewportTitlebarOwner | undefined {
  const view = header.ownerDocument.defaultView
  if (view === null || !header.isConnected) return undefined
  const position = view.getComputedStyle(header).position
  if (position === 'fixed') return { position }
  if (position !== 'absolute') return undefined
  const surface = header.parentElement
  const frame = surface?.closest<HTMLElement>('[data-app-shell-frame="true"]')
  if (
    surface === null || surface === undefined || frame === null || frame === undefined
    || surface.getAttribute('data-app-shell-page-surface') !== 'true'
    || !['titlebar', 'page'].includes(surface.getAttribute('data-app-shell-header-placement') ?? '')
    || view.getComputedStyle(surface).display !== 'contents'
    || view.getComputedStyle(frame).position !== 'relative'
    || header.getClientRects().length === 0 || frame.getClientRects().length === 0
  ) return undefined
  const headerRect = header.getBoundingClientRect()
  const frameRect = frame.getBoundingClientRect()
  const near = (left: number, right: number) =>
    Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 2
  let workspaceOwner: {
    activePage: HTMLElement
    workspace: HTMLElement
    workspaceRow: HTMLElement
  } | undefined
  if (surface.parentElement !== frame) {
    const page = surface.parentElement
    const owner = page?.parentElement
    const row = owner?.parentElement
    if (
      page === null || owner === null || owner === undefined || row === null || row === undefined
      || page.getAttribute('data-app-shell-active-page') !== 'true'
      || view.getComputedStyle(page).display !== 'contents'
      || owner.getAttribute('data-app-shell-workspace') !== 'true'
      || row.getAttribute('data-app-shell-workspace-row') !== 'true' || row.parentElement !== frame
      || view.getComputedStyle(owner).position !== 'relative'
      || view.getComputedStyle(row).position !== 'relative'
      || owner.getClientRects().length === 0 || row.getClientRects().length === 0
    ) return undefined
    const ownerRect = owner.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    const gutter = frame.getAttribute('data-app-shell-compact-page-gutter') === 'true' ? 4 : 0
    if (
      !near(rowRect.left, ownerRect.left) || !near(rowRect.top, ownerRect.top)
      || !near(rowRect.right, ownerRect.right) || !near(rowRect.bottom, ownerRect.bottom)
      || !near(frameRect.right - rowRect.right, gutter)
      || !near(frameRect.bottom - rowRect.bottom, gutter)
    ) return undefined
    workspaceOwner = { activePage: page, workspace: owner, workspaceRow: row }
  }
  const viewportRect = workspaceOwner?.workspace.getBoundingClientRect() ?? frameRect
  if (
    !near(headerRect.left, 0) || !near(headerRect.top, 0)
    || !near(frameRect.left, headerRect.left) || !near(frameRect.top, headerRect.top)
    || !near(viewportRect.left, headerRect.left) || !near(viewportRect.top, headerRect.top)
    || !near(viewportRect.right, headerRect.right) || viewportRect.height < 240
    || headerRect.height < 40 || headerRect.height > 48
  ) return undefined
  return { position, surface, frame, ...workspaceOwner }
}
