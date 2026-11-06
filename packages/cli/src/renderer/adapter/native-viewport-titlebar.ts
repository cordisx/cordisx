export interface NativeViewportTitlebarOwner {
  readonly position: 'fixed' | 'absolute'
  readonly surface?: HTMLElement
  readonly frame?: HTMLElement
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
  const near = (left: number, right: number) => Number.isFinite(left) && Math.abs(left - right) <= 2
  if (
    !near(headerRect.left, 0) || !near(headerRect.top, 0)
    || !near(frameRect.left, headerRect.left) || !near(frameRect.top, headerRect.top)
    || !near(frameRect.right, headerRect.right) || frameRect.height < 240
    || headerRect.height < 40 || headerRect.height > 48
  ) return undefined
  return { position, surface, frame }
}
