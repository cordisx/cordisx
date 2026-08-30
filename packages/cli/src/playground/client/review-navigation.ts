/**
 * Preview-only initial navigation through the contributed Host sidebar row.
 * This intentionally exercises the same authorized route action as a user click.
 */
export function activatePlaygroundReviewNavigation(
  document: Document,
  qualifiedContributionId: string,
): () => void {
  let active = true
  let observer: MutationObserver | undefined

  const activate = (): boolean => {
    if (!active) return false
    const row = [...document.querySelectorAll<HTMLElement>('[data-sidebar-item]')]
      .find(candidate => candidate.dataset.sidebarItem === qualifiedContributionId)
    const button = row?.querySelector<HTMLButtonElement>('.cxsi-primary')
    if (button === undefined || button === null || button.disabled) return false
    active = false
    observer?.disconnect()
    button.click()
    return true
  }

  if (!activate()) {
    const seat = document.querySelector<HTMLElement>('[data-cordisx-playground-surface="sidebar.navigation.items"]')
    const MutationObserverConstructor = document.defaultView?.MutationObserver
    if (seat !== null && MutationObserverConstructor !== undefined) {
      observer = new MutationObserverConstructor(() => { activate() })
      observer.observe(seat, { childList: true, subtree: true })
    }
  }

  return () => {
    active = false
    observer?.disconnect()
  }
}
