import { resolveManagerRailSeat } from '../host-probes.js'

/**
 * Observe a completed activation of a Codex-owned rail destination. A click on
 * the already-active destination can leave the native route identity unchanged,
 * so a route subscription alone cannot release the Manager pane.
 */
export function observeNativeRailActivation(document: Document, onActivate: () => void): () => void {
  const ElementClass = document.defaultView?.Element
  if (ElementClass === undefined) return () => {}
  let active = true
  const onClick = (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof ElementClass)) return
    const button = target.closest<HTMLButtonElement>('button[data-sidebar-destination]')
    const rail = resolveManagerRailSeat(document)?.homeButton.closest('nav[data-app-navigation-rail="true"]')
    if (
      button === null || rail === null || rail === undefined || !rail.contains(button)
      || button.disabled || button.getAttribute('aria-disabled') === 'true'
      || button.inert || button.closest('[inert]') !== null
    ) return
    // Let Codex's own click handler run before revoking the Host projection.
    queueMicrotask(() => {
      if (active) onActivate()
    })
  }
  document.addEventListener('click', onClick, true)
  return () => {
    active = false
    document.removeEventListener('click', onClick, true)
  }
}
