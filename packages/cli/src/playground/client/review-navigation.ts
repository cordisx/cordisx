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

  const view = document.defaultView
  const state = view?.history.state
  const route = state !== null && typeof state === 'object'
    ? (state as { readonly __cordisxRouteV1?: unknown }).__cordisxRouteV1
    : undefined
  // Review mode supplies a default only for a genuinely blank first entry.
  // Refreshing an existing plugin route or Host task URL must preserve the
  // one native history stack instead of being redirected to New room.
  if (view !== null && view !== undefined && (view.location.pathname !== '/' || route !== undefined)) {
    return () => undefined
  }

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

/**
 * Authorize only the owner and extension point containing the exact configured
 * review contribution. This is a Playground-only convenience for an explicit
 * local review composition; production permission policy remains unchanged.
 */
export async function authorizePlaygroundReviewNavigation(
  runtime: PlaygroundRuntime,
  qualifiedContributionId: string,
): Promise<void> {
  const snapshot = runtime.snapshot()
  const registration = snapshot.registrations.find(candidate =>
    candidate.qualifiedId === qualifiedContributionId
    && candidate.surface === 'sidebar.navigation.items')
  if (registration === undefined || registration.authorized) return
  if (registration.pointPolicyReason !== 'permission.review-pending') return
  const plugin = snapshot.plugins.find(candidate => candidate.id === registration.owner)
  if (plugin === undefined) return
  const pointIds = [registration.surface]
  const routeId = registration.item?.route?.id
  const route = routeId === undefined
    ? undefined
    : snapshot.navigation.routes.find(candidate =>
      candidate.owner === registration.owner && candidate.id === routeId)
  if (route !== undefined) pointIds.push(route.definition.outlet)
  const applied: string[] = []
  try {
    for (const pointId of new Set(pointIds)) {
      await runtime.setExtensionPointPolicy(plugin.source, registration.owner, pointId, 'allow')
      applied.push(pointId)
    }
  } catch (error) {
    // The review convenience must not leave a persistent partial grant when
    // the route outlet cannot be authorized. Restore the inherited policy for
    // every point already written, then let the caller remain fail-closed.
    await Promise.allSettled(applied.reverse().map(pointId =>
      runtime.setExtensionPointPolicy(plugin.source, registration.owner, pointId, 'inherit')))
    throw error
  }
}
