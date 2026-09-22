/**
 * Packaged index.html and the full-page React fallback in
 * app-initial-a498f911edeb.js. Never match arbitrary in-app brand artwork.
 */
export const NATIVE_STARTUP_MARK_SELECTOR = [
  'body > #root > .startup-loader[aria-hidden="true"] > .startup-loader__logo',
  'body > #root [role="presentation"]:is(.relative.size-full,.absolute.inset-0).bg-transparent'
  + ' > .flex.flex-col.items-center.gap-2 > ._Root_yklzu_11.size-14[aria-hidden="true"]',
].join(', ')
