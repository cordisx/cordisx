export const MIN_MANAGER_SIDEBAR_WIDTH = 180
export const MAX_MANAGER_SIDEBAR_WIDTH = 420
const MIN_CONTENT_WIDTH = 320

/** Keep both the content pane and the bounded native titlebar usable at narrow window widths. */
export function maximumManagerSidebarWidth(input: {
  readonly availableWidth: number
  readonly currentWidth: number
  readonly mainLeft: number
  readonly titlebarSafeRight?: number
}): number {
  const contentLimit = Math.floor(input.availableWidth - MIN_CONTENT_WIDTH)
  const titlebarLimit = input.titlebarSafeRight === undefined
    ? MAX_MANAGER_SIDEBAR_WIDTH
    : Math.floor(input.titlebarSafeRight - MIN_CONTENT_WIDTH - (input.mainLeft - input.currentWidth))
  return Math.max(MIN_MANAGER_SIDEBAR_WIDTH, Math.min(MAX_MANAGER_SIDEBAR_WIDTH, contentLimit, titlebarLimit))
}
