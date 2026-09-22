/**
 * Packaged index.html and the full-page React fallback in
 * app-initial-a498f911edeb.js. Never match arbitrary in-app brand artwork.
 */
export const NATIVE_STARTUP_MARK_SELECTOR = [
  'body > #root > .startup-loader[aria-hidden="true"] > .startup-loader__logo',
  'body > #root [role="presentation"]:is(.relative.size-full,.absolute.inset-0).bg-transparent'
  + ' > .flex.flex-col.items-center.gap-2 > ._Root_yklzu_11.size-14[aria-hidden="true"]',
].join(', ')

/**
 * Native MainContentSurface observed at the first rendered shell (build 9922).
 * Static/React full-page splash documents do not publish these semantic seats.
 * Sidebar is intentionally not required because it can be collapsed.
 */
export const NATIVE_STARTUP_SURFACE = {
  root: 'body > #root main',
  main: '[data-app-shell-focus-area="main"]',
  chrome: 'header[data-app-shell-application-menu-bar]',
  content: ':scope > [data-vscode-context]',
}
